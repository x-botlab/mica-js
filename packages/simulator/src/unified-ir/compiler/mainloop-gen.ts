import type { ArrayRef, FunctionBuilder, FunctionRef, IRModule } from '@mica-js/ir';
import { ELECTRICAL_FAULT } from '../pin-space';
import type { DeviceLoopEntry } from './device-gen';
import { FLOATING_TICK_PS } from './floating';
import { emitObserverDetection, type LoweredObserver } from './lowering';
import { emitDevicePowered, type PowerGating } from './power';
import type { NetSolverRuntime } from './solver-gen';
import { UnifiedIRCompilerError, type CompiledCircuitMemory, type CompiledNetlist } from './types';

/** Generated entry-point names. */
export interface MainLoopNames {
  readonly tick: string;
  readonly initialize: string;
  readonly batch: string;
}

/** Names used when the caller does not override them. */
export const DEFAULT_ENTRY_POINT_NAMES: MainLoopNames = Object.freeze({
  tick: 'unified_tick',
  initialize: 'unified_initialize',
  batch: 'unified_tick_batch',
});

/** Everything the main loop needs from the lowering pass. */
export interface MainLoopOptions {
  /** Shared memories; required when `observers` or `initializeTail` are used. */
  readonly memory?: CompiledCircuitMemory;
  /** Activated observations, emitted after every device update. */
  readonly observers?: readonly LoweredObserver[];
  /**
   * Extra instructions at the end of `initialize`, after every device phase:
   * the lowered propagation of `initial: 'closed'` switches.
   */
  readonly initializeTail?: (builder: FunctionBuilder<readonly []>) => void;
  /**
   * Power-domain gating (RFC 0007). A device whose primary domain is off has
   * its `tick` and `update` phases skipped; the electrical solve still runs.
   */
  readonly power?: PowerGating;
  /**
   * `electrical_fault` slot (RFC 0002 §4.4). When the circuit can produce a
   * strong-drive conflict, the step returns immediately after the solve once
   * the slot is latched, so no device observes a poisoned network.
   */
  readonly faults?: ArrayRef<'u8'>;
  /**
   * RFC 0002 §4.5 sample clock: two `u32` words of picoseconds since reset,
   * advanced once per step. `undefined` when no net of the circuit floats.
   */
  readonly floatingClock?: ArrayRef<'u32'>;
}

/** The generated main loop. */
export interface MainLoopOutput {
  readonly names: MainLoopNames;
  readonly initialize: FunctionRef<readonly [], readonly []>;
  readonly tick: FunctionRef<readonly [], readonly []>;
  readonly batch: FunctionRef<readonly ['u32'], readonly []>;
  /** Device ids in dependency order. */
  readonly order: readonly string[];
}

/**
 * Generates the circuit entries.
 *
 * ```text
 * unified_initialize:                // once, before the first tick
 *   mcu1_initialize()
 *   led1_initialize()                // if the device has one
 *
 * unified_tick:                      // one simulation step
 *   mcu1_tick()                      // drivers publish their outputs
 *   solve_net_0()                    // the electrical network resolves
 *   led1_update()                    // loads observe the solved inputs
 *
 * unified_tick_batch(count):         // the same step, looped inside the IR
 *   for i in 0 .. count { <step> }
 * ```
 *
 * Devices run in dependency order: a device that drives a net executes before
 * every device that senses it. Feedback loops fall back to declaration order
 * after the topological prefix, so clock cycles stay valid.
 */
export class MainLoopGenerator {
  private readonly module: IRModule;
  private readonly memory: CompiledCircuitMemory | undefined;
  private readonly observers: readonly LoweredObserver[];
  private readonly initializeTail: ((builder: FunctionBuilder<readonly []>) => void) | undefined;
  private readonly power: PowerGating | undefined;
  private readonly faults: ArrayRef<'u8'> | undefined;
  private readonly floatingClock: ArrayRef<'u32'> | undefined;

  constructor(module: IRModule, options: MainLoopOptions = {}) {
    this.module = module;
    this.memory = options.memory;
    this.observers = options.observers ?? [];
    this.initializeTail = options.initializeTail;
    this.power = options.power;
    this.faults = options.faults;
    this.floatingClock = options.floatingClock;
  }

  /**
   * Advances the RFC 0002 §4.5 sample clock by one tick (`TICK_PS`).
   *
   * ```text
   * low' = low + 1_000_000
   * high' = high + (low' < low)      // the add wrapped, so it carried
   * ```
   *
   * Two `u32` words cover the scheduler's whole `TimePs` range without the JIT
   * having to lower a 64-bit value.
   */
  private emitClockAdvance(b: FunctionBuilder<readonly []>): void {
    const clock = this.floatingClock;
    if (clock === undefined) return;
    const zero = b.const('u32', 0);
    const low = b.array.load(clock, zero);
    const next = b.int.add(low, b.const('u32', FLOATING_TICK_PS));
    b.array.store(clock, zero, next);
    const carry = b.int.cmp('lt', next, low);
    const high = b.array.load(clock, b.const('u32', 1));
    b.array.store(
      clock,
      b.const('u32', 1),
      b.int.add(high, b.select(carry, b.const('u32', 1), zero)),
    );
  }

  /** Stable topological order of the devices; cycles fall back to declaration order. */
  order(entries: readonly DeviceLoopEntry[], netlist: CompiledNetlist): readonly string[] {
    const indexById = new Map(entries.map((entry, index) => [entry.deviceId, index]));
    const consumers = new Map<string, Set<string>>();
    const indegree = new Map<string, number>(entries.map((entry) => [entry.deviceId, 0]));

    for (const net of netlist.nets) {
      const driverDevices = new Set(net.drivers.map((pin) => pin.deviceId));
      const sinkDevices = new Set(net.sinks.map((pin) => pin.deviceId));
      for (const driver of driverDevices) {
        for (const sink of sinkDevices) {
          if (driver === sink) continue;
          let targets = consumers.get(driver);
          if (targets === undefined) {
            targets = new Set();
            consumers.set(driver, targets);
          }
          if (targets.has(sink)) continue;
          targets.add(sink);
          indegree.set(sink, (indegree.get(sink) ?? 0) + 1);
        }
      }
    }

    const ready = new Set(
      entries
        .filter((entry) => (indegree.get(entry.deviceId) ?? 0) === 0)
        .map((entry) => entry.deviceId),
    );
    const order: string[] = [];
    while (ready.size > 0) {
      let nextId: string | undefined;
      let nextIndex = Number.POSITIVE_INFINITY;
      for (const id of ready) {
        const index = indexById.get(id) ?? 0;
        if (index < nextIndex) {
          nextIndex = index;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      ready.delete(nextId);
      order.push(nextId);
      for (const consumer of consumers.get(nextId) ?? []) {
        const remaining = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, remaining);
        if (remaining === 0) ready.add(consumer);
      }
    }
    for (const entry of entries) {
      if (!order.includes(entry.deviceId)) order.push(entry.deviceId);
    }
    return Object.freeze(order);
  }

  /** Generates `initialize`, `tick` and the batched tick loop. */
  generate(
    entries: readonly DeviceLoopEntry[],
    solvers: readonly NetSolverRuntime[],
    netlist: CompiledNetlist,
    names: MainLoopNames = DEFAULT_ENTRY_POINT_NAMES,
  ): MainLoopOutput {
    const order = this.order(entries, netlist);
    const byId = new Map(entries.map((entry) => [entry.deviceId, entry]));

    /**
     * Emits the RFC 0002 §4.4 pause:
     *
     * ```text
     * if electrical_fault != 0 { return }
     * ```
     *
     * Only a node with several drivers can conflict, so a single-driver
     * circuit emits no check at all and keeps its previous tick shape.
     */
    const detectConflict =
      this.faults !== undefined && netlist.nets.some((net) => net.drivers.length > 1);
    const emitFaultCheck = (
      b: FunctionBuilder<readonly []>,
      continuation: (builder: FunctionBuilder<readonly []>) => void,
    ): void => {
      const faults = this.faults;
      if (!detectConflict || faults === undefined) {
        continuation(b);
        return;
      }
      const fault = b.array.load(faults, b.const('u32', 0));
      const halted = b.block([]);
      const running = b.block([]);
      b.branch(
        b.int.cmp('ne', fault, b.const('u8', ELECTRICAL_FAULT.none)),
        { target: halted, args: [] },
        { target: running, args: [] },
      );
      b.at(halted, (edge) => {
        edge.return([]);
      });
      b.at(running, (edge) => {
        continuation(edge);
      });
    };

    /**
     * Emits `emit` only while the device's primary domain is powered, then
     * hands the builder of the follow-up block to `continuation`.
     *
     * The IR builder has no "insert after this block" operation, so the rest of
     * the step is chained through the callback — exactly like observer edge
     * detection. A device without a domain (or a circuit without domains) keeps
     * the straight-line call.
     */
    const emitGuarded = (
      b: FunctionBuilder<readonly []>,
      deviceId: string,
      emit: (builder: FunctionBuilder<readonly []>) => void,
      continuation: (builder: FunctionBuilder<readonly []>) => void,
    ): void => {
      const powered = emitDevicePowered(b, this.power, deviceId);
      if (powered === undefined) {
        emit(b);
        continuation(b);
        return;
      }
      const running = b.block([]);
      const after = b.block([]);
      b.branch(powered, { target: running, args: [] }, { target: after, args: [] });
      b.at(running, (then) => {
        emit(then);
        then.jump(after, []);
      });
      b.at(after, (next) => {
        continuation(next);
      });
    };

    /** Emits a device phase call per entry, skipping unpowered devices. */
    const emitCalls = (
      b: FunctionBuilder<readonly []>,
      calls: readonly {
        readonly deviceId: string;
        readonly ref: FunctionRef<readonly [], readonly []>;
      }[],
      index: number,
      continuation: (builder: FunctionBuilder<readonly []>) => void,
    ): void => {
      const call = calls[index];
      if (call === undefined) {
        continuation(b);
        return;
      }
      emitGuarded(
        b,
        call.deviceId,
        (inner) => inner.call(call.ref, []),
        (next) => emitCalls(next, calls, index + 1, continuation),
      );
    };

    const emitStep = (
      b: FunctionBuilder<readonly []>,
      continuation: (builder: FunctionBuilder<readonly []>) => void,
    ): void => {
      // The clock moves at the very end of the step, so the solve — and every
      // observer read that follows it — sees the time it is sampling at.
      const finish = (builder: FunctionBuilder<readonly []>): void => {
        this.emitClockAdvance(builder);
        continuation(builder);
      };
      const ticks = order.flatMap((deviceId) => {
        const tick = byId.get(deviceId)?.tick;
        return tick === undefined ? [] : [{ deviceId, ref: tick }];
      });
      const updates = order.flatMap((deviceId) => {
        const update = byId.get(deviceId)?.update;
        return update === undefined ? [] : [{ deviceId, ref: update }];
      });
      emitCalls(b, ticks, 0, (afterTicks) => {
        for (const solver of solvers) afterTicks.call(solver.solve, []);
        emitFaultCheck(afterTicks, (afterFault) => {
          emitCalls(afterFault, updates, 0, (afterUpdates) => {
            if (this.observers.length === 0) {
              finish(afterUpdates);
              return;
            }
            const memory = this.memory;
            if (memory === undefined) {
              throw new UnifiedIRCompilerError(
                'invalid-input',
                'The main loop needs `memory` to emit observation edge detection',
              );
            }
            emitObserverDetection(afterUpdates, memory, this.observers, 0, finish, this.power);
          });
        });
      });
    };

    const initialize = this.module.func(names.initialize, { params: [], results: [] });
    initialize.body((b) => {
      for (const deviceId of order) {
        const entry = byId.get(deviceId);
        if (entry?.initialize !== undefined) b.call(entry.initialize, []);
      }
      this.initializeTail?.(b);
      b.return([]);
    });

    const tick = this.module.func(names.tick, { params: [], results: [] });
    tick.body((b) => {
      emitStep(b, (next) => next.return([]));
    });

    // The batch entry keeps the loop inside the IR: one engine call per batch
    // instead of one host entry per tick, which is the throughput path.
    const batch = this.module.func(names.batch, { params: ['u32'], results: [] });
    batch.body((b, [count]) => {
      const header = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block([]);
      b.jump(header, [b.const('u32', 0)]);
      b.at(header, (ib, [index]) =>
        ib.branch(
          ib.int.cmp('lt', index, count),
          { target: body, args: [index] },
          { target: done, args: [] },
        ),
      );
      b.at(body, (ib, [index]) => {
        emitStep(ib, (next) => next.jump(header, [next.int.add(index, next.const('u32', 1))]));
      });
      b.at(done, (ib) => ib.return([]));
    });

    return Object.freeze({
      names,
      initialize,
      tick,
      batch,
      order,
    });
  }
}
