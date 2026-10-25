import type { ArrayRef, FunctionBuilder, Value } from '@mica-js/ir';
import { PIN_MODE, PIN_PULL } from '../pin-space';
import { FNV_OFFSET_BASIS, FNV_PRIME } from '../runtime/floating';
import type { CompiledCircuitMemory, CompiledPinConnection, CompiledRail } from './types';

/**
 * The digital electrical model of RFC 0002, shared by every level emitter.
 *
 * A node resolves in three tiers, strongest first:
 *
 * ```text
 * 1. strong drive   any pin that actively holds the node decides its level
 * 2. rail           a GND/VCC rail is a stiff source, so it beats a weak bias
 * 3. weak bias      a pull-up makes an otherwise released node read high
 * 4. floating       nothing holds the node, so it samples the deterministic
 *                    RFC 0002 §4.5 sequence (`mica-floating-v2`)
 * ```
 *
 * The strong tier is a wired-OR over the *actively driven high* pins:
 *
 * ```text
 * driven_high(pin) = PIN_MODE[pin] == PUSH_PULL && PIN_OUTPUT[pin]
 * active(pin)      = PIN_MODE[pin] == PUSH_PULL
 *                  || (PIN_MODE[pin] == OPEN_DRAIN && !PIN_OUTPUT[pin])
 * ```
 *
 * Open-drain therefore contributes a low level while it pulls and releases the
 * node (contributes nothing) when its latch is high; high-z and analog always
 * release. Because every low contribution is the representation's `false`,
 * OR-ing the high contributions already yields the wired level.
 *
 * The weak tier is read from `pin_pull` for *every* pin of the node — not only
 * for its drivers — because the bias is independent of the drive mode, the
 * output latch and the pin role (a two-terminal pull resistor is a `passive`
 * pin). A pull-down needs no term of its own: the fallback level already is
 * `false`. When a node declares both biases the pull-up wins, which keeps the
 * solver branch-free; a real divider is out of scope for the boolean model.
 */
export interface NetLevelPlan {
  /** Global pin ids of the pins that can hold the node (`role === 'driver'`). */
  readonly drivers: readonly number[];
  /** Global pin ids whose `pin_pull` slot biases the node, drivers included. */
  readonly pulls: readonly number[];
  /** Rail level attached to the node, or `undefined` when it touches no rail. */
  readonly rail: boolean | undefined;
  /**
   * Driver pin id -> index of the power domain gating it (RFC 0007). A driver
   * whose domain is off releases the node: it neither holds a level nor counts
   * as driving. Empty when no driver is bound to a domain.
   */
  readonly powered: ReadonlyMap<number, number>;
  /**
   * RFC 0002 §4.5: the node has no strong driver and no rail, so nothing can
   * hold it. An unbiased node then samples the floating sequence instead of
   * reading a constant low.
   */
  readonly floating: boolean;
}

/**
 * Everything the level emitter needs to materialise `sampleFloating`
 * (`@mica-js/simulator`'s `runtime/floating.ts`) inline.
 *
 * The values are compile-time constants except the clock, which the main loop
 * advances once per tick:
 *
 * ```text
 * low, high = floating_clock[0], floating_clock[1]     // picoseconds
 * hash = fnv1a(seed, netId, low, high)
 * level = (hash & 1) && (low | high) != 0              // settled low at reset
 * ```
 */
export interface FloatingLevel {
  readonly netId: number;
  readonly seed: number;
  /** `[low, high]` words of the sample clock in picoseconds. */
  readonly clock: ArrayRef<'u32'>;
}

/** Builds the level plan of one node from its pins and rails. */
export function planNetLevel(
  pins: readonly CompiledPinConnection[],
  rails: readonly CompiledRail[],
  pinDomains?: ReadonlyMap<number, number>,
): NetLevelPlan {
  const drivers: number[] = [];
  const pulls: number[] = [];
  const powered = new Map<number, number>();
  const seen = new Set<number>();
  for (const pin of pins) {
    if (pin.role === 'driver') {
      drivers.push(pin.globalPinId);
      const domain = pinDomains?.get(pin.globalPinId);
      if (domain !== undefined) powered.set(pin.globalPinId, domain);
    }
    if (seen.has(pin.globalPinId)) continue;
    seen.add(pin.globalPinId);
    pulls.push(pin.globalPinId);
  }
  drivers.sort((left, right) => left - right);
  pulls.sort((left, right) => left - right);
  return Object.freeze({
    drivers: Object.freeze(drivers),
    pulls: Object.freeze(pulls),
    // Rails of opposite level are a compile error, so the first one decides.
    rail: rails.length === 0 ? undefined : rails.some((rail) => rail.level),
    powered,
    // A node with a driver or a rail always has at least one source; one with
    // neither is only resolved by a weak bias or, without one, by the RFC 0002
    // §4.5 floating sample.
    floating: drivers.length === 0 && rails.length === 0,
  });
}

/**
 * Materialises the solved level of one node.
 *
 * Every input is a compile-time array index, so the result is a branch-free
 * sequence of loads, compares and `select`s — the netlist is never walked at
 * run time. Plans with neither weak biases nor rails collapse to the plain
 * wired-OR the pre-RFC-0002 solver emitted.
 *
 * @param cache Optional plan→value memo; a switch group emits several levels
 *   per solver body and shares the repeated sub-expressions.
 */
export function emitNetLevel(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  plan: NetLevelPlan,
  cache?: Map<NetLevelPlan, Value<'bool'>>,
  floating?: FloatingLevel,
): Value<'bool'> {
  const cached = cache?.get(plan);
  if (cached !== undefined) return cached;

  const pull = memory.pull;
  const pullPins = pull === undefined ? [] : plan.pulls;
  const strong = emitStrongDrives(builder, memory, plan.drivers, plan.powered);
  // A node that nothing can hold samples the floating sequence; every other
  // node never pays for the sample.
  const sample =
    plan.floating && floating !== undefined ? emitFloatingSample(builder, floating) : undefined;
  const settled = sample ?? builder.const('bool', false);

  let level: Value<'bool'>;
  if (plan.rail !== undefined) {
    // A rail is a stiff source: it beats a weak bias, and only an actively
    // driving pin can override it (a static driver + rail is a power short).
    const railLevel = builder.const('bool', plan.rail);
    level =
      strong.active === undefined
        ? railLevel
        : builder.select(strong.active, strong.level as Value<'bool'>, railLevel);
  } else {
    let weak: Value<'bool'>;
    if (pullPins.length === 0) {
      // No weak bias: the wired-OR alone decides, or the node floats.
      weak = settled;
    } else {
      const biased = emitPullUp(builder, pull as ArrayRef<'u8'>, pullPins);
      // A pull-down is a bias too: it holds the node low, so the floating
      // sample only applies when no pin pulls at all.
      const pulledDown =
        sample === undefined ? undefined : emitPullDown(builder, pull as ArrayRef<'u8'>, pullPins);
      weak =
        pulledDown === undefined
          ? biased
          : builder.select(
              biased,
              builder.const('bool', true),
              builder.select(pulledDown, builder.const('bool', false), sample as Value<'bool'>),
            );
    }
    level =
      strong.active === undefined
        ? weak
        : builder.select(strong.active, strong.level as Value<'bool'>, weak);
  }

  cache?.set(plan, level);
  return level;
}

interface StrongDrives {
  /** True while at least one pin actively holds the node. */
  readonly active: Value<'bool'> | undefined;
  /** Wired-OR of the actively driven *high* levels. */
  readonly level: Value<'bool'> | undefined;
}

/**
 * Folds the strong tier of every driver into two values.
 *
 * One pass emits both so a driver costs one `mode` load, one `output` load,
 * two compares and three boolean ops — regardless of how the node is biased.
 * A driver whose power domain is off contributes nothing at all: it is neither
 * `active` (it cannot override a rail or a weak bias) nor part of the wired-OR.
 */
function emitStrongDrives(
  builder: FunctionBuilder<readonly []>,
  memory: CompiledCircuitMemory,
  drivers: readonly number[],
  poweredBy: ReadonlyMap<number, number>,
): StrongDrives {
  const pushPullMode = builder.const('u8', PIN_MODE.pushPull);
  const openDrainMode = builder.const('u8', PIN_MODE.openDrain);
  const ready = memory.powerReady;
  let active: Value<'bool'> | undefined;
  let level: Value<'bool'> | undefined;
  for (const pinId of drivers) {
    const index = builder.const('u32', pinId);
    const mode = builder.array.load(memory.mode, index);
    const output = builder.array.load(memory.output, index);
    const pushPull = builder.int.cmp('eq', mode, pushPullMode);
    const openDrain = builder.int.cmp('eq', mode, openDrainMode);
    // Open-drain pulls low while its latch is 0 and releases on 1.
    const rawDriven = builder.bool.or(
      pushPull,
      builder.bool.and(openDrain, builder.bool.not(output)),
    );
    const rawHigh = builder.bool.and(pushPull, output);
    const domainIndex = ready === undefined ? undefined : poweredBy.get(pinId);
    const powered =
      ready === undefined || domainIndex === undefined
        ? undefined
        : builder.array.load(ready, builder.const('u32', domainIndex));
    const driven = powered === undefined ? rawDriven : builder.bool.and(rawDriven, powered);
    const high = powered === undefined ? rawHigh : builder.bool.and(rawHigh, powered);
    active = active === undefined ? driven : builder.bool.or(active, driven);
    level = level === undefined ? high : builder.bool.or(level, high);
  }
  return { active, level };
}

/** `OR(PIN_PULL[pin] == UP)` over the pins of the node. */
function emitPullUp(
  builder: FunctionBuilder<readonly []>,
  pull: ArrayRef<'u8'>,
  pins: readonly number[],
): Value<'bool'> {
  return emitPullIs(builder, pull, pins, PIN_PULL.up);
}

/** `OR(PIN_PULL[pin] == DOWN)` over the pins of the node. */
function emitPullDown(
  builder: FunctionBuilder<readonly []>,
  pull: ArrayRef<'u8'>,
  pins: readonly number[],
): Value<'bool'> {
  return emitPullIs(builder, pull, pins, PIN_PULL.down);
}

function emitPullIs(
  builder: FunctionBuilder<readonly []>,
  pull: ArrayRef<'u8'>,
  pins: readonly number[],
  value: number,
): Value<'bool'> {
  const target = builder.const('u8', value);
  let biased: Value<'bool'> | undefined;
  for (const pinId of pins) {
    const slot = builder.array.load(pull, builder.const('u32', pinId));
    const isBias = builder.int.cmp('eq', slot, target);
    biased = biased === undefined ? isBias : builder.bool.or(biased, isBias);
  }
  return biased ?? builder.const('bool', false);
}

/**
 * Materialises one RFC 0002 §4.5 floating sample.
 *
 * This is `sampleFloating(netId, clock, seed)` from `runtime/floating.ts`
 * inlined: FNV-1a over the seed, the net and both clock words, the
 * `mixFloatingHash` avalanche, then the low bit. Keeping the arithmetic here
 * means the reference engine and the JIT run the same instructions, and the hot
 * path never calls back into the host.
 *
 * `t = 0` is the reset point, where the sequence has not started yet: the node
 * keeps the settled low level so creating and resetting a circuit is
 * reproducible.
 */
function emitFloatingSample(
  builder: FunctionBuilder<readonly []>,
  floating: FloatingLevel,
): Value<'bool'> {
  const zero = builder.const('u32', 0);
  const one = builder.const('u32', 1);
  const prime = builder.const('u32', FNV_PRIME);
  const low = builder.array.load(floating.clock, zero);
  const high = builder.array.load(floating.clock, one);

  let hash = builder.int.xor(
    builder.const('u32', FNV_OFFSET_BASIS),
    builder.const('u32', floating.seed),
  );
  hash = builder.int.mul(builder.int.xor(hash, builder.const('u32', floating.netId)), prime);
  hash = builder.int.mul(builder.int.xor(hash, low), prime);
  hash = builder.int.mul(builder.int.xor(hash, high), prime);

  // Two multiply-xor-shift rounds avalanche the FNV word so the sampled bit is
  // not just the parity of its inputs (see `mixFloatingHash`).
  let mixed = builder.int.mul(
    builder.int.xor(hash, builder.int.lshr(hash, builder.const('u32', 16))),
    builder.const('u32', 0x7feb352d),
  );
  mixed = builder.int.mul(
    builder.int.xor(mixed, builder.int.lshr(mixed, builder.const('u32', 15))),
    builder.const('u32', 0x846ca68b),
  );
  mixed = builder.int.xor(mixed, builder.int.lshr(mixed, builder.const('u32', 16)));

  const odd = builder.int.cmp('eq', builder.int.and(mixed, one), one);
  const settled = builder.bool.and(
    builder.int.cmp('eq', low, zero),
    builder.int.cmp('eq', high, zero),
  );
  return builder.bool.and(odd, builder.bool.not(settled));
}
