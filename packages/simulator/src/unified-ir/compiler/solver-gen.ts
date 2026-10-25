import type { ArrayRef, FunctionBuilder, FunctionRef, IRModule, Value } from '@mica-js/ir';
import { ELECTRICAL_FAULT } from '../pin-space';
import type { ConnectionLowering } from './lowering';
import { emitNetLevel, planNetLevel, type FloatingLevel, type NetLevelPlan } from './net-level';
import type { PowerGating } from './power';
import type { CompiledCircuitMemory, CompiledNet, CompiledNetlist } from './types';
import {
  DEFAULT_SUPPLY_VOLTAGE,
  emitNetVoltage,
  emitThresholdDigital,
  planVoltage,
  thresholdsForSupply,
} from './voltage-solver';

/** One generated net solver. */
export interface NetSolverRuntime {
  readonly netId: number;
  /** Generated `solve_net_<id>`. */
  readonly name: string;
  readonly net: CompiledNet;
  readonly solve: FunctionRef<readonly [], readonly []>;
}

/** Everything the solver generator reads from the prior compilation stages. */
export interface SolverGenerationContext {
  readonly module: IRModule;
  readonly memory: CompiledCircuitMemory;
  /**
   * Switch lowering, when the circuit declares dynamic connections. Every net
   * solver then asks it for the levels implied by closed switches, so the
   * connectivity chosen by `connection.apply` survives the next solve.
   */
  readonly switches?: ConnectionLowering;
  /**
   * Power-domain gating (RFC 0007). A driver whose domain is off releases the
   * net, so it contributes neither a high nor a low level.
   */
  readonly power?: PowerGating;
  /**
   * Nominal circuit supply in volts (RFC 0002 §5). Used for pins without a
   * power domain. Defaults to 3.3 V.
   */
  readonly supplyVoltage?: number;
  /**
   * Global pin ids whose behaviour configured a pull resistor. Only those pins
   * join the weak tier, so a circuit without pulls emits no bias reads.
   */
  readonly pulledPins?: ReadonlySet<number>;
  /**
   * Global pin ids whose behaviour overrode a pin threshold. A sink without an
   * override keeps its seeded thresholds, which lets a rail node resolve its
   * digital level at compile time.
   */
  readonly thresholdPins?: ReadonlySet<number>;
  /**
   * RFC 0002 §4.5 floating sample: the topology seed and the tick clock the
   * main loop advances. `undefined` when no net of the circuit floats, which is
   * also when no clock memory is allocated.
   */
  readonly floating?: {
    readonly seed: number;
    readonly clock: ArrayRef<'u32'>;
    /** Net ids the compiler planned to sample; anything else keeps its level. */
    readonly nets: readonly number[];
  };
}

/**
 * Generates the electrical solve, one `solve_net_<id>` function per net.
 *
 * The level comes from {@link emitNetLevel}, the RFC 0002 model shared with the
 * dynamic-switch lowering. For the common single push-pull driver the emitted
 * body collapses to the pre-RFC-0002 shape:
 *
 * ```text
 * solve_net_0:
 *   let mode   = PIN_MODE[driver]
 *   let output = PIN_OUTPUT[driver]
 *   let driven = mode == PUSH_PULL && output
 *   PIN_INPUT[load] = driven          // once per sink
 * ```
 *
 * Everything else is the same branch-free read extended by the other tiers:
 *
 * ```text
 * driven_high = OR(mode == PUSH_PULL && output)                     // wired-OR
 * driving     = OR(mode == PUSH_PULL || (mode == OPEN_DRAIN && !output))
 * pull_up     = OR(PIN_PULL[pin] == UP)                             // every pin
 * pull_down   = OR(PIN_PULL[pin] == DOWN)
 * level       = driving ? driven_high
 *                       : (rail ? rail.level
 *                               : (pull_up ? 1 : pull_down ? 0 : sample_floating))
 *   PIN_INPUT[sink] = level           // once per sink
 * ```
 *
 * The floating sample only exists for a node with no driver and no rail (see
 * {@link FloatingLevel}); every other node keeps the pre-RFC-0002 instruction
 * sequence.
 */
export class ElectricalSolverGenerator {
  private readonly context: SolverGenerationContext;
  /** Global pin id -> high-level voltage of its power domain. */
  private readonly pinVoltages: ReadonlyMap<number, number> | undefined;

  constructor(context: SolverGenerationContext) {
    this.context = context;
    const power = context.power;
    if (power === undefined) {
      this.pinVoltages = undefined;
    } else {
      const voltages = new Map<number, number>();
      for (const [globalPinId, domainIndex] of power.pinDomains) {
        const voltage = power.domainVoltages[domainIndex];
        if (voltage !== undefined) voltages.set(globalPinId, voltage);
      }
      this.pinVoltages = voltages;
    }
  }

  generate(netlist: CompiledNetlist): readonly NetSolverRuntime[] {
    return Object.freeze(netlist.nets.map((net) => this.generateNetSolver(net)));
  }

  private generateNetSolver(net: CompiledNet): NetSolverRuntime {
    const name = `solve_net_${net.netId}`;
    const solve = this.context.module.func(name, { params: [], results: [] });
    // The plan is fixed at compile time: pin ids and rails never change.
    const plan: NetLevelPlan = planNetLevel(net.pins, net.rails, this.context.power?.pinDomains);
    const voltagePlan = planVoltage(net, {
      supplyVoltage: this.context.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE,
      ...(this.pinVoltages === undefined ? {} : { pinVoltages: this.pinVoltages }),
      ...(this.context.power === undefined ? {} : { pinDomains: this.context.power.pinDomains }),
      pull: this.context.memory.pull !== undefined,
      ...(this.context.pulledPins === undefined ? {} : { pullPins: this.context.pulledPins }),
    });

    const railLevel = this.railDigitalLevel(net, voltagePlan.railVoltage);

    solve.body((b) => {
      const memory = this.context.memory;
      // RFC 0002 §4: every node resolves a voltage, whether or not anyone
      // samples it, because a probe can read any pin between ticks.
      const voltageMemory = memory.voltage;
      const voltage =
        voltageMemory === undefined ? undefined : emitNetVoltage(b, memory, voltagePlan);
      if (voltage !== undefined && voltageMemory !== undefined) {
        const fault = memory.electricalFault;
        if (voltage.conflict !== undefined && fault !== undefined) {
          // Latch: another net may already have flagged a conflict this tick,
          // and a conflict-free net must never clear it.
          const existing = b.array.load(fault, b.const('u32', 0));
          b.array.store(
            fault,
            b.const('u32', 0),
            b.select(voltage.conflict, b.const('u8', ELECTRICAL_FAULT.conflict), existing),
          );
        }
        for (const pin of net.pins) {
          b.array.store(voltageMemory, b.const('u32', pin.globalPinId), voltage.voltage);
        }
      }

      if (net.sinks.length > 0) {
        const switches = this.context.switches?.switchesOfNet(net.netId) ?? [];
        const floating = this.floatingOf(net.netId, plan);
        if (floating !== undefined || voltage === undefined || switches.length > 0) {
          // A floating node has no voltage of its own, a switchable node merges
          // several levels, and an old memory has no analog tier: all three
          // answer with the RFC 0002 boolean solve.
          const base = emitNetLevel(b, memory, plan, undefined, floating);
          const driven = this.applySwitches(b, net.netId, base);
          for (const sink of net.sinks) {
            b.array.store(this.context.memory.input, b.const('u32', sink.globalPinId), driven);
          }
        } else {
          // RFC 0002 §4.6: digital sampling converts the solved voltage
          // through the pin's own thresholds instead of re-deriving the level.
          if (railLevel !== undefined) {
            // A rail node with only seeded thresholds has a compile-time level.
            for (const sink of net.sinks) {
              b.array.store(
                this.context.memory.input,
                b.const('u32', sink.globalPinId),
                b.const('bool', railLevel),
              );
            }
          } else {
            for (const sink of net.sinks) {
              b.array.store(
                this.context.memory.input,
                b.const('u32', sink.globalPinId),
                emitThresholdDigital(b, memory, sink.globalPinId, voltage.voltage),
              );
            }
          }
        }
      }
      b.return([]);
    });

    return Object.freeze({ netId: net.netId, name, net, solve });
  }

  /**
   * Digital level a rail imposes on every sink when that level is known at
   * compile time, or `undefined` when a threshold read is still required.
   *
   * Rails beat every other contribution, so the level is purely a function of
   * the rail voltage and the seeded thresholds. A sink that overrode a
   * threshold at run time opts out, as does a rail sitting inside the
   * indeterminate band.
   */
  private railDigitalLevel(net: CompiledNet, railVoltage: number | undefined): boolean | undefined {
    if (railVoltage === undefined || net.sinks.length === 0) return undefined;
    const overridden = this.context.thresholdPins;
    const supply = this.context.supplyVoltage ?? DEFAULT_SUPPLY_VOLTAGE;
    let level: boolean | undefined;
    for (const sink of net.sinks) {
      if (overridden?.has(sink.globalPinId) === true) return undefined;
      const thresholds = thresholdsForSupply(this.pinVoltages?.get(sink.globalPinId) ?? supply);
      const digital =
        railVoltage < thresholds.low ? false : railVoltage > thresholds.high ? true : undefined;
      if (digital === undefined) return undefined;
      if (level !== undefined && level !== digital) return undefined;
      level = digital;
    }
    return level;
  }

  /**
   * The floating sample of `netId`, when both the node and the circuit can
   * float. A node with a driver or a rail always has a source, so it never
   * pays for the sample.
   */
  private floatingOf(netId: number, plan: NetLevelPlan): FloatingLevel | undefined {
    const floating = this.context.floating;
    if (!plan.floating || floating === undefined) return undefined;
    if (!floating.nets.includes(netId)) return undefined;
    return { netId, seed: floating.seed, clock: floating.clock };
  }

  /**
   * Re-applies the dynamic connectivity of `netId`:
   *
   * ```text
   * level = base
   * for each switch touching this net:
   *   level = select(connection_states[switch], mergedLevel, level)
   * ```
   *
   * Every switch and every level is a compile-time constant read, so this is a
   * handful of typed-array loads and `select`s — never a netlist walk.
   */
  private applySwitches(
    b: FunctionBuilder<readonly []>,
    netId: number,
    base: Value<'bool'>,
  ): Value<'bool'> {
    const lowering = this.context.switches;
    const states = this.context.memory.connectionStates;
    if (lowering === undefined || states === undefined) return base;
    let level = base;
    for (const slot of lowering.switchesOfNet(netId)) {
      const state = b.array.load(states, b.const('u32', slot.index));
      level = b.select(state, lowering.emitMergedLevel(b, slot), level);
    }
    return level;
  }
}
