import type { FunctionBuilder, Value } from '@mica-js/ir';
import { PIN_MODE, PIN_PULL, type PinMode, type PinPull } from '../pin-space';
import type { CompiledCircuitMemory, CompiledNet, CompiledRail } from './types';
import { UnifiedIRCompilerError } from './types';

/**
 * The analog electrical model of RFC 0002 (§4 and §5).
 *
 * The digital model in `net-level.ts` answers "is this node high?". This module
 * answers "what voltage does this node settle at?", which is what an analog
 * pin, a probe or a threshold read needs. The arbitration mirrors the scheduler
 * path's `resolveElectricalNetwork`:
 *
 * ```text
 * 1. rail     a GND / VCC / 3V3 rail is a stiff source and always wins
 * 2. strong   a push-pull, open-drain or analog driver that is enabled
 * 3. weak     a pull-up or pull-down bias of any pin of the node
 * 4. floating nothing holds the node, so it reads 0 V
 * ```
 *
 * Within the winning tier every contribution must agree: two strong drivers of
 * one node whose voltages differ by more than {@link VOLTAGE_CONFLICT_TOLERANCE}
 * are an electrical conflict, which latches `electrical_fault` and pauses the
 * main loop. The arbitration is a single pass of typed-array loads, compares
 * and `select`s — never an iterative solve.
 *
 * Everything the generated IR needs is planned at compile time
 * ({@link planVoltage}); {@link emitNetVoltage} then materialises the voltage of
 * one node and {@link emitThresholdDigital} converts it back to a digital level.
 */

/** Nominal supply of a circuit that declares no power domain (volts). */
export const DEFAULT_SUPPLY_VOLTAGE = 3.3;

/** Default low-level threshold of a 3.3 V pin (volts). */
export const DEFAULT_LOW_THRESHOLD = 0.8;

/** Default high-level threshold of a 3.3 V pin (volts). */
export const DEFAULT_HIGH_THRESHOLD = 2;

/**
 * Low threshold as a fraction of the supply, so a 1.8 V or 5 V domain gets a
 * threshold that still classifies its own drive levels (`0.8 / 3.3`).
 */
export const THRESHOLD_LOW_RATIO = DEFAULT_LOW_THRESHOLD / DEFAULT_SUPPLY_VOLTAGE;

/** High threshold as a fraction of the supply (`2.0 / 3.3`). */
export const THRESHOLD_HIGH_RATIO = DEFAULT_HIGH_THRESHOLD / DEFAULT_SUPPLY_VOLTAGE;

/** Largest voltage spread of one node that is still "driven together" (volts). */
export const VOLTAGE_CONFLICT_TOLERANCE = 0.001;

/**
 * Largest finite `f32`. The spread tracker starts at `±F32_MAX` instead of
 * `±Infinity`, because every generated constant stays finite: an inactive
 * driver must not look like a 0 V contribution.
 */
const F32_MAX = 3.4028234663852886e38;

/** Threshold pair of one pin, in volts. */
export interface VoltageThresholds {
  readonly low: number;
  readonly high: number;
}

/**
 * Default thresholds of a pin whose supply is `supplyVoltage`.
 *
 * Scaling by the supply keeps the defaults usable for low-voltage logic: a
 * 3.3 V rail yields `0.8 V / 2.0 V`, a 1.8 V rail `0.44 V / 1.09 V`, and a
 * 5 V rail `1.21 V / 3.03 V`. `pin.configure` overrides either value.
 */
export function thresholdsForSupply(supplyVoltage: number): VoltageThresholds {
  return Object.freeze({
    low: Math.fround(supplyVoltage * THRESHOLD_LOW_RATIO),
    high: Math.fround(supplyVoltage * THRESHOLD_HIGH_RATIO),
  });
}

const RAIL_SUPPLY_PATTERN = /^\+?(\d+)V(\d+)$/i;
const RAIL_VOLTS_PATTERN = /^\+?(\d+(?:\.\d+)?)V$/i;

/**
 * Voltage of a high rail named like a supply.
 *
 * `3V3` reads 3.3 V, `+5V` reads 5 V, `12V` reads 12 V; every other name
 * (`VCC`, `VDD`, `VBUS`, …) falls back to the circuit supply. A low rail is
 * always 0 V and never reaches this function.
 */
export function supplyVoltageOfRail(name: string, fallback: number): number {
  const compact = RAIL_SUPPLY_PATTERN.exec(name);
  if (compact !== null) return Number(`${compact[1]}.${compact[2]}`);
  const volts = RAIL_VOLTS_PATTERN.exec(name);
  if (volts !== null) return Number(volts[1]);
  return fallback;
}

/**
 * Voltage a node's rails impose, or `undefined` when it touches no rail.
 *
 * Rails of one node always share a level (the topology analyzer rejects a
 * short), so the first one decides; a low rail pins the node to 0 V.
 */
export function railVoltageOf(
  rails: readonly CompiledRail[],
  supplyVoltage: number,
): number | undefined {
  const rail = rails[0];
  if (rail === undefined) return undefined;
  return rail.level ? supplyVoltageOfRail(rail.name, supplyVoltage) : 0;
}

/* -------------------------------------------------------------------------
 * Pure arbitration (the RFC 0002 reference used by tests and the compiler)
 * ---------------------------------------------------------------------- */

/** Runtime state of one pin on a node, as the pure solver sees it. */
export interface VoltagePinState {
  readonly globalPinId: number;
  readonly mode: PinMode;
  readonly output: boolean;
  readonly voltageIntent: number;
  readonly pull: PinPull;
  readonly powered: boolean;
  readonly highVoltage: number;
  readonly lowVoltage: number;
}

/** One contribution to a node's voltage. */
export interface VoltageContribution {
  readonly globalPinId: number;
  readonly kind: 'drive' | 'pull' | 'rail';
  readonly strength: 'rail' | 'strong' | 'weak';
  readonly voltage: number;
}

/** Result of the pure voltage solve of one node. */
export type VoltageNetworkResult =
  | {
      readonly state: 'floating';
      readonly voltage: 0;
      readonly contributions: readonly VoltageContribution[];
    }
  | {
      readonly state: 'driven';
      readonly voltage: number;
      readonly strength: 'rail' | 'strong' | 'weak';
      readonly contributions: readonly VoltageContribution[];
    }
  | {
      readonly state: 'conflict';
      /** Spread of the strongest tier that disagreed (volts). */
      readonly spread: number;
      readonly contributions: readonly VoltageContribution[];
    };

/** Voltage one pin actively holds the node at, or `undefined` when released. */
export function activeVoltage(pin: VoltagePinState): number | undefined {
  if (!pin.powered) return undefined;
  switch (pin.mode) {
    case PIN_MODE.highZ:
      return undefined;
    case PIN_MODE.pushPull:
      return pin.output ? pin.highVoltage : pin.lowVoltage;
    case PIN_MODE.openDrain:
      // Open-drain pulls low while its latch is 0 and releases on 1.
      return pin.output ? undefined : pin.lowVoltage;
    case PIN_MODE.analog:
      // An analog output drives its intent only once `writeAnalog` enabled it;
      // configuring `analog` to read thresholds alone leaves the pin released.
      return pin.output ? pin.voltageIntent : undefined;
    default:
      return undefined;
  }
}

/**
 * Resolves one node exactly like the generated solver does.
 *
 * Used as the test oracle and by the planner; the generated IR emits the same
 * tiers but reads its inputs from the shared pin memories.
 */
export function resolveVoltageNetwork(
  pins: readonly VoltagePinState[],
  railVoltage?: number,
): VoltageNetworkResult {
  const contributions: VoltageContribution[] = [];
  const pullUps: number[] = [];
  const pullDowns: number[] = [];
  for (const pin of pins) {
    const driven = activeVoltage(pin);
    if (driven !== undefined) {
      contributions.push({
        globalPinId: pin.globalPinId,
        kind: 'drive',
        strength: 'strong',
        voltage: driven,
      });
    }
    if (pin.pull === PIN_PULL.up) {
      pullUps.push(pin.highVoltage);
      contributions.push({
        globalPinId: pin.globalPinId,
        kind: 'pull',
        strength: 'weak',
        voltage: pin.highVoltage,
      });
    } else if (pin.pull === PIN_PULL.down) {
      pullDowns.push(pin.lowVoltage);
      contributions.push({
        globalPinId: pin.globalPinId,
        kind: 'pull',
        strength: 'weak',
        voltage: pin.lowVoltage,
      });
    }
  }
  const snapshot = Object.freeze(contributions.map((entry) => Object.freeze(entry)));

  if (railVoltage !== undefined) {
    return Object.freeze({
      state: 'driven',
      voltage: railVoltage,
      strength: 'rail',
      contributions: Object.freeze([
        Object.freeze({
          globalPinId: -1,
          kind: 'rail',
          strength: 'rail',
          voltage: railVoltage,
        }),
        ...snapshot,
      ]),
    });
  }

  const strong = snapshot.filter((entry) => entry.strength === 'strong');
  if (strong.length > 0) {
    const { min, max } = spreadOf(strong);
    if (max - min > VOLTAGE_CONFLICT_TOLERANCE) {
      return Object.freeze({ state: 'conflict', spread: max - min, contributions: snapshot });
    }
    return Object.freeze({
      state: 'driven',
      voltage: min,
      strength: 'strong',
      contributions: snapshot,
    });
  }

  const weak = snapshot.filter((entry) => entry.strength === 'weak');
  if (weak.length === 0) {
    return Object.freeze({ state: 'floating', voltage: 0, contributions: snapshot });
  }
  // A pull-up wins over a pull-down; weak disagreement is a divider, not a
  // short, so the stronger bias simply decides (RFC 0002 §4.2).
  const voltage = pullUps.length > 0 ? spreadOfValues(pullUps).max : spreadOfValues(pullDowns).min;
  return Object.freeze({ state: 'driven', voltage, strength: 'weak', contributions: snapshot });
}

function spreadOf(entries: readonly VoltageContribution[]): { min: number; max: number } {
  return spreadOfValues(entries.map((entry) => entry.voltage));
}

function spreadOfValues(values: readonly number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    min: min === Number.POSITIVE_INFINITY ? 0 : min,
    max: max === Number.NEGATIVE_INFINITY ? 0 : max,
  };
}

/* -------------------------------------------------------------------------
 * Compile-time plan
 * ---------------------------------------------------------------------- */

/** One pin the generated solver reads, with its compile-time voltage levels. */
export interface VoltageDriverPlan {
  readonly globalPinId: number;
  /** Voltage the pin holds the node at while it drives high (volts). */
  readonly highVoltage: number;
  /** Voltage the pin holds the node at while it drives low (volts). */
  readonly lowVoltage: number;
  /** Index of the power domain gating this pin, if any. */
  readonly domainIndex: number | undefined;
}

/** Everything `solve_net_<id>` needs to emit the voltage of one node. */
export interface VoltagePlan {
  readonly drivers: readonly VoltageDriverPlan[];
  /** Every pin of the node, because a weak bias is independent of its role. */
  readonly pulls: readonly VoltageDriverPlan[];
  readonly railVoltage: number | undefined;
  /** Whether the node can have several strong drivers, so a conflict is possible. */
  readonly trackSpread: boolean;
}

/** Inputs of {@link planVoltage}. */
export interface VoltagePlanOptions {
  /** Circuit supply used for pins without a declared power domain (volts). */
  readonly supplyVoltage: number;
  /** Global pin id -> nominal high-level voltage of its power domain. */
  readonly pinVoltages?: ReadonlyMap<number, number>;
  /** Global pin id -> index of the power domain gating it. */
  readonly pinDomains?: ReadonlyMap<number, number>;
  /** Whether the circuit allocated the `pin_pull` memory. */
  readonly pull?: boolean;
  /**
   * Global pin ids whose behaviour called `pin.pull`. When present, only those
   * pins join the weak tier; `undefined` reads every pin (the conservative
   * default for direct callers).
   */
  readonly pullPins?: ReadonlySet<number>;
}

/** Builds the voltage plan of one node; every id and voltage is a constant. */
export function planVoltage(net: CompiledNet, options: VoltagePlanOptions): VoltagePlan {
  const railVoltage = railVoltageOf(net.rails, options.supplyVoltage);
  const highOf = (globalPinId: number): number =>
    options.pinVoltages?.get(globalPinId) ?? railVoltage ?? options.supplyVoltage;

  const drivers: VoltageDriverPlan[] = net.drivers.map((pin) =>
    Object.freeze({
      globalPinId: pin.globalPinId,
      highVoltage: highOf(pin.globalPinId),
      lowVoltage: 0,
      domainIndex: options.pinDomains?.get(pin.globalPinId),
    }),
  );
  const pulls: VoltageDriverPlan[] = [];
  if (options.pull !== false) {
    const seen = new Set<number>();
    for (const pin of net.pins) {
      if (seen.has(pin.globalPinId)) continue;
      if (options.pullPins !== undefined && !options.pullPins.has(pin.globalPinId)) continue;
      seen.add(pin.globalPinId);
      pulls.push(
        Object.freeze({
          globalPinId: pin.globalPinId,
          highVoltage: highOf(pin.globalPinId),
          lowVoltage: 0,
          domainIndex: options.pinDomains?.get(pin.globalPinId),
        }),
      );
    }
  }
  return Object.freeze({
    drivers: Object.freeze(drivers),
    pulls: Object.freeze(pulls),
    railVoltage,
    trackSpread: drivers.length > 1,
  });
}

/* -------------------------------------------------------------------------
 * IR emission
 * ---------------------------------------------------------------------- */

/** The solved voltage of one node plus its conflict predicate. */
export interface NetVoltageEmission {
  /** Node voltage in volts; already arbitrated over rails, strong and weak. */
  readonly voltage: Value<'f32'>;
  /**
   * `true` while the strong tier disagrees by more than the tolerance.
   * `undefined` when the node cannot have several drivers, so no check is
   * emitted at all.
   */
  readonly conflict: Value<'bool'> | undefined;
}

/**
 * Emits the RFC 0002 §4 arbitration of one node.
 *
 * ```text
 * strong = OR(mode == PUSH_PULL
 *             || (mode == OPEN_DRAIN && !output)
 *             || (mode == ANALOG && output))
 * drive  = analog ? intent : (push_pull ? (output ? high : low) : low)
 * weak   = any_pull_up ? pull_up_voltage : pull_down_voltage
 * voltage = rail ?? (strong ? drive : weak) ?? 0
 * conflict = multiple_drivers && (max(strong) - min(strong) > 0.001)
 * ```
 *
 * A driver whose power domain is off releases the node. Every input is a
 * compile-time array index, so the body is a single branch-free pass.
 */
export function emitNetVoltage(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  plan: VoltagePlan,
): NetVoltageEmission {
  if (plan.railVoltage !== undefined && !plan.trackSpread) {
    // A rail with at most one driver is the common GND/VCC node: the rail
    // decides, so the whole strong/weak pass can be skipped.
    return Object.freeze({ voltage: builder.const('f32', plan.railVoltage), conflict: undefined });
  }
  const floats = builder.float;
  const zero = builder.const('f32', 0);
  const pushPullMode = builder.const('u8', PIN_MODE.pushPull);
  const openDrainMode = builder.const('u8', PIN_MODE.openDrain);
  const analogMode = builder.const('u8', PIN_MODE.analog);
  const intent = memory.voltageIntent;
  if (plan.drivers.length > 0 && intent === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'The voltage solver needs a `pin_voltage_intent` array for analog drivers',
    );
  }

  let active: Value<'bool'> | undefined;
  let drive: Value<'f32'> | undefined;
  let min: Value<'f32'> | undefined;
  let max: Value<'f32'> | undefined;
  if (plan.trackSpread) {
    min = builder.const('f32', F32_MAX);
    max = builder.const('f32', -F32_MAX);
  }
  for (const driver of plan.drivers) {
    const index = builder.const('u32', driver.globalPinId);
    const mode = builder.array.load(memory.mode, index);
    const output = builder.array.load(memory.output, index);
    const pushPull = builder.int.cmp('eq', mode, pushPullMode);
    const openDrain = builder.int.cmp('eq', mode, openDrainMode);
    const analog = builder.int.cmp('eq', mode, analogMode);
    const high = builder.const('f32', driver.highVoltage);
    const low = builder.const('f32', driver.lowVoltage);
    const highOrLow = builder.select(output, high, low);
    const selected =
      intent === undefined
        ? highOrLow
        : builder.select(analog, builder.array.load(intent, index), highOrLow);

    let pinActive = builder.bool.or(
      pushPull,
      builder.bool.or(
        builder.bool.and(openDrain, builder.bool.not(output)),
        builder.bool.and(analog, output),
      ),
    );
    const ready = memory.powerReady;
    const domainIndex = driver.domainIndex;
    if (ready !== undefined && domainIndex !== undefined) {
      const powered = builder.array.load(ready, builder.const('u32', domainIndex));
      pinActive = builder.bool.and(pinActive, powered);
    }

    active = active === undefined ? pinActive : builder.bool.or(active, pinActive);
    if (min === undefined || max === undefined) {
      // A single driver cannot disagree with itself: no spread bookkeeping.
      drive = selected;
      continue;
    }
    min = builder.select(
      builder.bool.and(pinActive, floats.cmp('lt', selected, min)),
      selected,
      min,
    );
    max = builder.select(
      builder.bool.and(pinActive, floats.cmp('gt', selected, max)),
      selected,
      max,
    );
  }

  if (plan.trackSpread && min !== undefined && max !== undefined) {
    drive = min;
  }
  const conflict =
    plan.trackSpread && active !== undefined && min !== undefined && max !== undefined
      ? builder.bool.and(
          active,
          floats.cmp('gt', floats.sub(max, min), builder.const('f32', VOLTAGE_CONFLICT_TOLERANCE)),
        )
      : undefined;

  const weak =
    plan.railVoltage === undefined ? emitWeakBias(builder, memory, plan.pulls) : undefined;
  let voltage: Value<'f32'>;
  if (plan.railVoltage !== undefined) {
    // Rails are the stiffest source; a static driver plus a rail is a
    // compile-time power short, so no runtime arbitration is needed.
    voltage = builder.const('f32', plan.railVoltage);
  } else if (drive !== undefined && active !== undefined) {
    // The released fallback is the weak bias, and 0 V when nothing biases the
    // node: a high-z or released open-drain pin never leaks its latch value.
    voltage = builder.select(active, drive, weak ?? zero);
  } else {
    voltage = weak ?? zero;
  }
  return Object.freeze({ voltage, conflict });
}

/**
 * Weak tier: a pull-up wins over a pull-down, and neither beats a strong
 * drive. `undefined` when the node declares no bias memory or no pins.
 */
function emitWeakBias(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  pulls: readonly VoltageDriverPlan[],
): Value<'f32'> | undefined {
  const array = memory.pull;
  if (array === undefined || pulls.length === 0) return undefined;
  const up = builder.const('u8', PIN_PULL.up);
  const down = builder.const('u8', PIN_PULL.down);
  const zero = builder.const('f32', 0);
  let anyUp: Value<'bool'> | undefined;
  let upVoltage: Value<'f32'> | undefined;
  let downVoltage: Value<'f32'> | undefined;
  for (const pin of pulls) {
    const value = builder.array.load(array, builder.const('u32', pin.globalPinId));
    const isUp = builder.int.cmp('eq', value, up);
    const isDown = builder.int.cmp('eq', value, down);
    anyUp = anyUp === undefined ? isUp : builder.bool.or(anyUp, isUp);
    const high = builder.const('f32', pin.highVoltage);
    const low = builder.const('f32', pin.lowVoltage);
    upVoltage =
      upVoltage === undefined
        ? builder.select(isUp, high, zero)
        : builder.select(isUp, high, upVoltage);
    downVoltage =
      downVoltage === undefined
        ? builder.select(isDown, low, zero)
        : builder.select(isDown, low, downVoltage);
  }
  if (anyUp === undefined || upVoltage === undefined || downVoltage === undefined) return undefined;
  return builder.select(anyUp, upVoltage, downVoltage);
}

/**
 * Converts the solved voltage of a node into the digital level one pin sees.
 *
 * ```text
 * voltage <  lowThreshold  -> false
 * voltage >  highThreshold -> true
 * otherwise                -> previous pin_input (the indeterminate band keeps
 *                             the last determinate level)
 * ```
 *
 * The hysteresis is what makes an analog ramp produce a clean edge instead of
 * chattering around one comparator threshold.
 */
export function emitThresholdDigital(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  globalPinId: number,
  voltage: Value<'f32'>,
): Value<'bool'> {
  const low = memory.lowThreshold;
  const high = memory.highThreshold;
  if (low === undefined || high === undefined) {
    throw new UnifiedIRCompilerError(
      'invalid-input',
      'A threshold read needs the `pin_low_threshold` and `pin_high_threshold` arrays',
    );
  }
  const index = builder.const('u32', globalPinId);
  const previous = builder.array.load(memory.input, index);
  const below = builder.float.cmp('lt', voltage, builder.array.load(low, index));
  const above = builder.float.cmp('gt', voltage, builder.array.load(high, index));
  return builder.select(
    below,
    builder.const('bool', false),
    builder.select(above, builder.const('bool', true), previous),
  );
}
