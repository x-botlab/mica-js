import { MAX_TIME_PS } from '@mica-js/core';

/**
 * RFC 0002 §4.5 — `mica-floating-v2` floating-node sampling.
 *
 * A node with no strong driver, no weak bias and no rail is not held at any
 * level, so the digital model must invent one. Doing that honestly (analog
 * noise around a slowly drifting operating point) is the scheduler path's job
 * (`createFloatingInput`); the unified IR stays boolean, so it samples the
 * *sign* of that noise instead:
 *
 * ```text
 * sample(net, t) = (mix32(fnv1a(seed, net, t)) & 1) === 1
 * ```
 *
 * The three properties the RFC requires fall out of that shape:
 *
 * - **deterministic** — the sample is a pure function of `(netId, simTimePs,
 *   seed)`, so replaying the same circuit at the same time yields the same
 *   level, and `Circuit.reset()` reproduces a run exactly;
 * - **pseudo-random in time** — consecutive times walk the FNV-1a avalanche, so
 *   the level wanders without carrying state (the whole 64-bit time is mixed,
 *   so the sequence does not repeat every 2^32 ps);
 * - **topology-dependent** — `seed` is a hash of the compiled netlist, so two
 *   different circuits do not flap in lockstep.
 *
 * The emitted solver inlines exactly the arithmetic below (see
 * `emitFloatingSample`), which keeps the hot path inside the IR and lets the
 * reference engine and the JIT agree bit-for-bit.
 *
 * ### The reset point
 *
 * `t = 0` is the settled level. Before the first tick advances the clock the
 * node keeps the level the rest of the model starts at (low), so creating a
 * circuit and immediately reading it stays deterministic instead of depending
 * on the noise draw of tick zero. Every later tick samples the sequence.
 */

/** Algorithm identifier of the sampling function below. */
export const FLOATING_ALGORITHM = 'mica-floating-v2';

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/**
 * Avalanche finalizer of the sample hash (the same `mix32` shape the scheduler
 * path's `mica-floating-v2` uses).
 *
 * FNV-1a alone is a poor bit generator at its low end: multiplying by an odd
 * prime preserves the parity of the input, so `hash & 1` would only ever be the
 * XOR of the low bits of `(seed, netId, time)`. With a 1 µs tick every sample
 * time is even, and the raw bit would never change. Two multiply-xor-shift
 * rounds spread every input bit over the whole word, so the sampled bit behaves
 * like a coin toss.
 */
export function mixFloatingHash(value: number): number {
  let mixed = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** Raised when a floating-sampler argument is outside its documented range. */
function assertU32(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Floating ${name} must be a u32 integer, received ${String(value)}`);
  }
}

function assertTime(simTimePs: unknown): asserts simTimePs is number {
  if (
    typeof simTimePs !== 'number' ||
    !Number.isInteger(simTimePs) ||
    simTimePs < 0 ||
    simTimePs > MAX_TIME_PS
  ) {
    throw new RangeError(
      `Floating sample time must be an integer number of picoseconds in [0, ${MAX_TIME_PS}], received ${String(simTimePs)}`,
    );
  }
}

/**
 * Mixes the topology seed with one node and one sample time.
 *
 * Both halves of `simTimePs` are folded in, so times `t` and `t + 2^32` — which
 * differ in the scheduler's range — do not collide. The result is avalanched by
 * {@link mixFloatingHash}, so any bit of it is usable.
 */
export function hashFloatingState(netId: number, simTimePs: number, seed: number): number {
  assertU32(netId, 'netId');
  assertU32(seed, 'seed');
  assertTime(simTimePs);
  // ToUint32 truncates modulo 2^32, which is exactly the low word.
  const low = simTimePs >>> 0;
  const high = Math.floor(simTimePs / 0x100000000) >>> 0;
  let hash = (FNV_OFFSET_BASIS ^ seed) >>> 0;
  hash = Math.imul(hash ^ netId, FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ low, FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ high, FNV_PRIME) >>> 0;
  return mixFloatingHash(hash);
}

/**
 * Samples the digital level of a floating node at `simTimePs`.
 *
 * @param netId - Compiled net index; keeps two floating nodes on independent
 *   sequences.
 * @param simTimePs - Sample time in picoseconds, counted from the reset point.
 * @param seed - Topology seed of the circuit.
 * @returns The sampled level; `false` at `simTimePs === 0`, the settled level.
 */
export function sampleFloating(netId: number, simTimePs: number, seed: number): boolean {
  assertU32(netId, 'netId');
  assertU32(seed, 'seed');
  assertTime(simTimePs);
  // Before the first advance the node has not started wandering yet.
  if (simTimePs === 0) return false;
  return (hashFloatingState(netId, simTimePs, seed) & 1) === 1;
}

/**
 * Derives the circuit seed from the compiled topology.
 *
 * The parts are hashed in the given order, so a caller that wants a stable
 * seed passes a canonical description (nets, endpoints and rails sorted by the
 * netlist, never by a hash map's iteration order). The result is avalanched, so
 * two topologies that differ in one character land far apart.
 */
export function hashTopology(parts: readonly string[]): number {
  const text = parts.join('\u0000');
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return mixFloatingHash(hash);
}
