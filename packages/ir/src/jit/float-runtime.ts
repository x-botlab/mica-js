/**
 * JIT floating-point runtime: boundary conversions, raw bit movement, and the
 * arithmetic helpers JIT-compiled code calls into.
 *
 * ## Value representation
 *
 * The reference interpreter keeps every floating SSA value as a frozen
 * `FloatBits { type, bits }` object. The JIT instead keeps values in host
 * registers as plain JS numbers whenever a number can reproduce the exact bit
 * string, and only falls back to bit patterns when it cannot.
 *
 * - **D representation** (`number`): `x` stands for `canon(T, x)`, the
 *   `FloatBits` the reference `fromNumber(type, x)` produces. For f32 the
 *   value must satisfy `Number.isNaN(x) || Math.fround(x) === x`. D therefore
 *   covers exactly the all-lowercase bit strings, with NaN limited to the
 *   canonical quiet NaN.
 * - **U representation** (`FloatValue = number | FloatBits`): a number as
 *   above, or a frozen `FloatBits` object for every value D cannot represent
 *   (uppercase hex digits, non-canonical NaN payloads, ...).
 *
 * Normalization rule: every `FloatBits` crossing into the JIT goes through
 * {@link fromBoundary}, which returns a `number` whenever D can represent the
 * value. Objects in U are therefore never D-representable; the rule does not
 * change results, it only makes the fast path hit more often.
 *
 * ## FMA
 *
 * - `fma32` multiplies exactly in double (24 + 24 <= 53 significand bits),
 *   sums with TwoSum, applies round-to-odd to the resulting 53-bit pair and
 *   finally rounds with `Math.fround`. Rounding to odd at 53 >= 24 + 2 bits
 *   and then rounding to nearest-even at 24 bits yields the correctly rounded
 *   result, subnormal targets included.
 * - `fma64` follows Boldo & Melquiond, "Emulation of FMA and correctly rounded
 *   sums: proved algorithms using rounding to odd" (2008): an exact Dekker
 *   product (Veltkamp split with 2^27 + 1), TwoSum, round-to-odd of the tail,
 *   then a final rounded sum. Inputs outside the proved fast-path range, and
 *   results that may be subnormal, fall back to the exact BigInt reference
 *   implementation in `float-ieee.ts`.
 */

import { arithmetic, fromNumber, special, toNumber } from '../float-ieee';
import type { FloatBits, FloatType, HexBits, IntegerType, Predicate } from '../types';

/** U representation: a plain `number` (D) or an exact, frozen `FloatBits`. */
export type FloatValue = number | FloatBits;

const CANONICAL_NAN: Record<FloatType, HexBits> = {
  f32: '0x7fc00000',
  f64: '0x7ff8000000000000',
};
const LOWERCASE_BITS = /^0x[0-9a-f]+$/;

/** Scratch buffer shared by the bit-level helpers; none of them re-enters. */
const scratch = new DataView(new ArrayBuffer(8));

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

function packBits(type: FloatType, bits: string): FloatBits {
  return Object.freeze({ type, bits: bits as HexBits });
}

function hexDigits(value: number, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

function decodeBits(type: FloatType, bits: HexBits): number {
  if (type === 'f32') {
    scratch.setUint32(0, Number.parseInt(bits.slice(2), 16), false);
    return scratch.getFloat32(0, false);
  }
  scratch.setUint32(0, Number.parseInt(bits.slice(2, 10), 16), false);
  scratch.setUint32(4, Number.parseInt(bits.slice(10), 16), false);
  return scratch.getFloat64(0, false);
}

/** True when the bit string encodes a NaN, whatever its payload or case. */
function isNaNBits(type: FloatType, bits: string): boolean {
  if (type === 'f32') {
    const raw = Number.parseInt(bits.slice(2), 16);
    return (raw & 0x7f800000) === 0x7f800000 && (raw & 0x007fffff) !== 0;
  }
  const exponent = bits.slice(2, 5);
  return (exponent === '7ff' || exponent === 'fff') && /[1-9a-f]/i.test(bits.slice(5));
}

// ---------------------------------------------------------------------------
// Boundary conversions
// ---------------------------------------------------------------------------

/**
 * `FloatBits` captured from a boundary → U. All-lowercase bit strings that are
 * either not NaN or exactly the canonical NaN become a `number` (D).
 */
export function fromBoundary(type: FloatType, value: FloatBits): FloatValue {
  const { bits } = value;
  if (LOWERCASE_BITS.test(bits) && (bits === CANONICAL_NAN[type] || !isNaNBits(type, bits))) {
    return decodeBits(type, bits);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

/**
 * U → frozen `FloatBits`, exactly matching the reference `fromNumber(type, x)`
 * for numbers (lowercase, zero padded, canonical NaN). Objects pass through.
 */
export function toBoundary(type: FloatType, value: FloatValue): FloatBits {
  if (typeof value === 'object') return value;
  if (Number.isNaN(value)) return special(type, 'nan');
  if (type === 'f32') {
    scratch.setFloat32(0, value, false);
    return packBits(type, `0x${hexDigits(scratch.getUint32(0, false), 8)}`);
  }
  scratch.setFloat64(0, value, false);
  const high = hexDigits(scratch.getUint32(0, false), 8);
  const low = hexDigits(scratch.getUint32(4, false), 8);
  return packBits(type, `0x${high}${low}`);
}

/** Numeric value of a U value; identical to the reference `toNumber`. */
export function toNum(value: FloatValue): number {
  return typeof value === 'number' ? value : decodeBits(value.type, value.bits);
}

// ---------------------------------------------------------------------------
// Raw bit movement (load, store, bitcast)
// ---------------------------------------------------------------------------

/**
 * Raw f32 bits (u32) → U. Only a non-canonical NaN payload stays an object, so
 * the payload survives a load/store round trip.
 */
export function fromRaw32(raw: number): FloatValue {
  const bits = raw >>> 0;
  if ((bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0) {
    return bits === 0x7fc00000 ? Number.NaN : packBits('f32', `0x${hexDigits(bits, 8)}`);
  }
  scratch.setUint32(0, bits, false);
  return scratch.getFloat32(0, false);
}

/** Raw f64 bits (two u32 words, high first) → U. */
export function fromRaw64(hi: number, lo: number): FloatValue {
  const high = hi >>> 0;
  const low = lo >>> 0;
  if ((high & 0x7ff00000) === 0x7ff00000 && ((high & 0x000fffff) !== 0 || low !== 0)) {
    if (high === 0x7ff80000 && low === 0) return Number.NaN;
    return packBits('f64', `0x${hexDigits(high, 8)}${hexDigits(low, 8)}`);
  }
  scratch.setUint32(0, high, false);
  scratch.setUint32(4, low, false);
  return scratch.getFloat64(0, false);
}

/** U → raw f32 bits (u32). Never depends on the engine's NaN payload policy. */
export function raw32(value: FloatValue): number {
  if (typeof value === 'object') {
    const hex = value.bits.slice(2);
    return Number.parseInt(hex.slice(Math.max(0, hex.length - 8)), 16) >>> 0;
  }
  if (Number.isNaN(value)) return 0x7fc00000;
  scratch.setFloat32(0, value, false);
  return scratch.getUint32(0, false);
}

/**
 * U → raw f64 bits, written as `out[0] = low word`, `out[1] = high word`.
 * Never depends on the engine's NaN payload policy.
 */
export function raw64(value: FloatValue, out: Uint32Array): void {
  if (typeof value === 'object') {
    const hex = value.bits.slice(2);
    if (hex.length <= 8) {
      out[0] = Number.parseInt(hex, 16) >>> 0;
      out[1] = 0;
      return;
    }
    out[0] = Number.parseInt(hex.slice(hex.length - 8), 16) >>> 0;
    out[1] = Number.parseInt(hex.slice(0, hex.length - 8), 16) >>> 0;
    return;
  }
  if (Number.isNaN(value)) {
    out[0] = 0;
    out[1] = 0x7ff80000;
    return;
  }
  scratch.setFloat64(0, value, false);
  out[0] = scratch.getUint32(4, false);
  out[1] = scratch.getUint32(0, false);
}

// ---------------------------------------------------------------------------
// Exact double-double primitives
// ---------------------------------------------------------------------------

/** Knuth's TwoSum: `s + e === a + b` exactly, for finite inputs without overflow. */
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const v = s - a;
  return [s, a - (s - v) + (b - v)];
}

/** Veltkamp splitter, `2^27 + 1`; valid while `|a| * splitter` does not overflow. */
const SPLITTER = 134217729;

/** Dekker's exact product: returns `[p, e]` with `p + e === a * b` exactly. */
function exactMult(a: number, b: number): [number, number] {
  const product = a * b;
  const scaledA = SPLITTER * a;
  const highA = scaledA - (scaledA - a);
  const lowA = a - highA;
  const scaledB = SPLITTER * b;
  const highB = scaledB - (scaledB - b);
  const lowB = b - highB;
  const error = highA * highB - product + highA * lowB + lowA * highB + lowA * lowB;
  return [product, error];
}

/**
 * Round the exact value `value + error` to 53 significant bits, forcing an odd
 * last mantissa bit whenever the result is inexact (round-to-odd).
 * Requires `|error| <= ulp(value) / 2` and a finite, non-zero `value`.
 */
function roundToOdd(value: number, error: number): number {
  if (error === 0 || value === 0 || !Number.isFinite(value)) return value;
  scratch.setFloat64(0, value, false);
  let low = scratch.getUint32(4, false);
  if ((low & 1) !== 0) return value;
  let high = scratch.getUint32(0, false);
  // Moving away from zero grows the magnitude, which grows the bit pattern for
  // both signs because the sign bit sits above the magnitude.
  if (value > 0 === error > 0) {
    low += 1;
    if (low > 0xffffffff) {
      low = 0;
      high += 1;
    }
  } else if (low === 0) {
    low = 0xffffffff;
    high -= 1;
  } else {
    low -= 1;
  }
  scratch.setUint32(0, high >>> 0, false);
  scratch.setUint32(4, low >>> 0, false);
  return scratch.getFloat64(0, false);
}

// ---------------------------------------------------------------------------
// Fused multiply-add
// ---------------------------------------------------------------------------

/**
 * `roundToNearest(a * b + c)` for f32 operands held in D.
 *
 * The product of two 24-bit significands is exact in double and stays inside
 * the double exponent range, so a single TwoSum of the product and the addend
 * captures the whole exact result. Rounding that pair to odd at 53 bits and
 * then letting `Math.fround` round to 24 bits is exact even when the result is
 * an f32 subnormal.
 */
export function fma32(a: number, b: number, c: number): number {
  const product = a * b;
  const sum = product + c;
  // Infinite or NaN results: the product is already exact, so one rounding is
  // the correctly rounded answer.
  if (!Number.isFinite(sum)) return Math.fround(sum);
  const [value, error] = twoSum(product, c);
  return Math.fround(roundToOdd(value, error));
}

/** Lower bound of the operands covered by the proved fma64 fast path. */
const FMA64_MIN_OPERAND = 2 ** -480;
/** Upper bound of the operands covered by the proved fma64 fast path. */
const FMA64_MAX_OPERAND = 2 ** 480;
/** Lower bound of the addend covered by the proved fma64 fast path. */
const FMA64_MIN_ADDEND = 2 ** -960;
/** Upper bound of the addend covered by the proved fma64 fast path. */
const FMA64_MAX_ADDEND = 2 ** 960;
/** Below this magnitude the fast path's proof no longer covers the result. */
const FMA64_MIN_RESULT = 2 ** -968;

/**
 * Whether `fma64` can take the Boldo–Melquiond fast path for these inputs:
 * all three operands finite and non-zero, `2^-480 <= |a|, |b| <= 2^480` and
 * `2^-960 <= |c| <= 2^960`. Excluded values (zero, NaN, infinity, extreme
 * exponents) fall out of the range comparisons.
 */
export function fma64FastPathApplies(a: number, b: number, c: number): boolean {
  const left = Math.abs(a);
  const right = Math.abs(b);
  const addend = Math.abs(c);
  return (
    left >= FMA64_MIN_OPERAND &&
    left <= FMA64_MAX_OPERAND &&
    right >= FMA64_MIN_OPERAND &&
    right <= FMA64_MAX_OPERAND &&
    addend >= FMA64_MIN_ADDEND &&
    addend <= FMA64_MAX_ADDEND
  );
}

/**
 * `roundToNearest(a * b + c)` for f64 operands: Boldo–Melquiond fast path with
 * the exact BigInt implementation as the fallback.
 */
export function fma64(a: number, b: number, c: number): number {
  if (fma64FastPathApplies(a, b, c)) {
    const [high, low] = exactMult(a, b);
    const [head, tail] = twoSum(c, high);
    const [middle, rest] = twoSum(tail, low);
    const value = head + roundToOdd(middle, rest);
    // Zero, overflow and (near-)subnormal results are outside the proved range.
    if (value !== 0 && Number.isFinite(value) && Math.abs(value) >= FMA64_MIN_RESULT) {
      return value;
    }
  }
  return toNumber(
    arithmetic('f64', 'float.fma', [
      fromNumber('f64', a),
      fromNumber('f64', b),
      fromNumber('f64', c),
    ]),
  );
}

// ---------------------------------------------------------------------------
// IR operations (J6 may inline these; they are the reference for the JIT)
// ---------------------------------------------------------------------------

export function floatAdd(type: FloatType, a: number, b: number): number {
  // Double rounding is harmless for f32: 53 >= 2 * 24 + 2.
  return type === 'f32' ? Math.fround(a + b) : a + b;
}

export function floatSub(type: FloatType, a: number, b: number): number {
  return type === 'f32' ? Math.fround(a - b) : a - b;
}

export function floatMul(type: FloatType, a: number, b: number): number {
  return type === 'f32' ? Math.fround(a * b) : a * b;
}

export function floatDiv(type: FloatType, a: number, b: number): number {
  return type === 'f32' ? Math.fround(a / b) : a / b;
}

const PREDICATES: Record<Predicate, (left: number, right: number) => boolean> = {
  eq: (left, right) => left === right,
  ne: (left, right) => left !== right,
  lt: (left, right) => left < right,
  le: (left, right) => left <= right,
  gt: (left, right) => left > right,
  ge: (left, right) => left >= right,
};

export function floatCompare(predicate: Predicate, a: number, b: number): boolean {
  return PREDICATES[predicate](a, b);
}

/** `x !== x`; NaN (whatever the payload) is the only self-unequal value. */
export function floatIsNaN(value: number): boolean {
  return value !== value;
}

export function floatIsFinite(value: number): boolean {
  return Number.isFinite(value);
}

/** `convert.intToFloat`: integral values are exact for f64, rounded for f32. */
export function intToFloat(type: FloatType, value: number): number {
  return type === 'f32' ? Math.fround(value) : value;
}

/**
 * `convert.float`: f32 → f64 is exact, f64 → f32 rounds to nearest-even. NaN
 * stays NaN, i.e. the canonical NaN in D.
 */
export function convertFloat(type: FloatType, value: number): number {
  return type === 'f32' ? Math.fround(value) : value;
}

const INTEGER_LIMITS: Record<IntegerType, readonly [number, number]> = {
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffffffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x80000000, 0x7fffffff],
};

/**
 * `convert.floatToInt` fast path. Returns `null` when the value is out of range
 * (or not finite); the caller must then raise the reference error through
 * `evaluateFloatInstruction`, which owns the message and error type.
 */
export function floatToInt(target: IntegerType, value: number): number | null {
  const truncated = Math.trunc(value);
  const [minimum, maximum] = INTEGER_LIMITS[target];
  if (!Number.isFinite(truncated) || truncated < minimum || truncated > maximum) return null;
  return truncated === 0 ? 0 : truncated;
}
