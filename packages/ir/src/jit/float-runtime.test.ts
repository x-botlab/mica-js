/**
 * Tests for the JIT floating-point runtime.
 *
 * Everything is checked against the reference implementation in `float.ts` /
 * `float-ieee.ts`: results must be character-identical bit strings, including
 * NaN canonicalization and signed zero. Inputs are generated from a fixed seed
 * so failures are reproducible.
 */

import { describe, expect, it } from 'vitest';
import { evaluateFloatInstruction, IRFloatEvaluationError } from '../float';
import { fromNumber, toNumber } from '../float-ieee';
import { INTEGER_TYPES, valueKind } from '../types';
import type {
  FloatBits,
  FloatType,
  HexBits,
  InstructionNode,
  IntegerType,
  Predicate,
  RuntimeScalar,
  ScalarType,
} from '../types';
import {
  convertFloat,
  fma32,
  fma64,
  fma64FastPathApplies,
  floatAdd,
  floatCompare,
  floatDiv,
  floatIsFinite,
  floatIsNaN,
  floatMul,
  floatSub,
  floatToInt,
  fromBoundary,
  fromRaw32,
  fromRaw64,
  intToFloat,
  raw32,
  raw64,
  toBoundary,
  toNum,
} from './float-runtime';

// Raise these locally for soak runs; CI keeps the suite well under 10 seconds.
const BIT_SAMPLES = 3000;
const OP_CASES = 1500;
const FMA_CASES = 2500;
const COMPARISON_CASES = 400;

const FLOAT_TYPES: readonly FloatType[] = ['f32', 'f64'];
const FLOAT_PREDICATES: readonly Predicate[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'];

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function uint32(random: () => number): number {
  return Math.floor(random() * 0x1_0000_0000) >>> 0;
}

function hex32(raw: number): HexBits {
  return `0x${(raw >>> 0).toString(16).padStart(8, '0')}`;
}

function hex64(high: number, low: number): HexBits {
  return `0x${(high >>> 0).toString(16).padStart(8, '0')}${(low >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

/** Randomly uppercases hex digits to exercise the non-D paths. */
function randomCase(bits: HexBits, random: () => number): HexBits {
  return bits.replace(/[0-9a-f]/g, (digit) =>
    random() < 0.5 ? digit.toUpperCase() : digit,
  ) as HexBits;
}

function capture(type: FloatType, bits: HexBits): FloatBits {
  return Object.freeze({ type, bits });
}

function f32Bits(sign: number, exponent: number, fraction: number): HexBits {
  return hex32(((sign << 31) | (exponent << 23) | fraction) >>> 0);
}

function f64Bits(
  sign: number,
  exponent: number,
  fractionHigh: number,
  fractionLow: number,
): HexBits {
  return hex64(
    ((sign << 31) | ((exponent & 0x7ff) << 20) | (fractionHigh & 0xfffff)) >>> 0,
    fractionLow,
  );
}

/** Exponents (unbiased) that sit on or next to the fma64 fast-path bounds. */
const THRESHOLD_EXPONENTS = [
  -1022, -1000, -969, -968, -961, -960, -959, -500, -481, -480, -479, -1, 0, 1, 479, 480, 481, 500,
  959, 960, 961, 968, 969, 1023,
];

/** Random bit patterns covering the distributions the spec calls out. */
function sampleBits(type: FloatType, random: () => number): HexBits {
  const sign = random() < 0.5 ? 1 : 0;
  const shape = Math.floor(random() * 7);
  if (type === 'f32') {
    switch (shape) {
      case 0:
        return hex32(uint32(random));
      case 1: // exponent concentrated near zero
        return f32Bits(sign, 127 + Math.floor(random() * 9) - 4, uint32(random) & 0x7fffff);
      case 2: // any normal value
        return f32Bits(sign, 1 + Math.floor(random() * 254), uint32(random) & 0x7fffff);
      case 3: // subnormal
        return f32Bits(sign, 0, (uint32(random) & 0x7fffff) | 1);
      case 4: // near the largest finite value
        return f32Bits(sign, 254, uint32(random) & 0x7fffff);
      case 5: // exact power of two
        return f32Bits(sign, 1 + Math.floor(random() * 254), 0);
      default:
        return f32Bits(sign, 127, uint32(random) & 0x7fffff);
    }
  }
  switch (shape) {
    case 0:
      return hex64(uint32(random), uint32(random));
    case 1: {
      const exponent = THRESHOLD_EXPONENTS[Math.floor(random() * THRESHOLD_EXPONENTS.length)]!;
      return f64Bits(
        sign,
        exponent + 1023,
        random() < 0.2 ? 0 : uint32(random) & 0xfffff,
        uint32(random),
      );
    }
    case 2: // exponent concentrated near zero
      return f64Bits(
        sign,
        1023 + Math.floor(random() * 9) - 4,
        uint32(random) & 0xfffff,
        uint32(random),
      );
    case 3: // any normal value
      return f64Bits(
        sign,
        1 + Math.floor(random() * 2046),
        uint32(random) & 0xfffff,
        uint32(random),
      );
    case 4: // subnormal
      return f64Bits(sign, 0, uint32(random) & 0xfffff, uint32(random) | 1);
    case 5: // near the largest finite value
      return f64Bits(sign, 2046, uint32(random) & 0xfffff, uint32(random));
    default: // exact power of two
      return f64Bits(sign, 1 + Math.floor(random() * 2046), 0, 0);
  }
}

/** Value a bit pattern denotes, as a D number of the given type. */
function numberFrom(type: FloatType, bits: HexBits): number {
  return toNum(fromBoundary(type, capture(type, bits)));
}

function neighbour(type: FloatType, value: number, random: () => number): number {
  const step = random() < 0.5 ? 1 : -1;
  if (type === 'f32') {
    const raw = (raw32(toBoundary(type, value)) + step) >>> 0;
    return toNum(fromRaw32(raw));
  }
  const words = new Uint32Array(2);
  raw64(toBoundary(type, value), words);
  const raw =
    (BigInt(words[1]!) * 0x1_0000_0000n + BigInt(words[0]!) + BigInt(step)) & 0xffffffffffffffffn;
  return toNum(fromRaw64(Number(raw >> 32n), Number(raw & 0xffffffffn)));
}

// ---------------------------------------------------------------------------
// Reference plumbing
// ---------------------------------------------------------------------------

const nodeCache = new Map<string, InstructionNode>();

function referenceNode(
  op: string,
  operandTypes: readonly ScalarType[],
  target: ScalarType,
  literal?: string | number,
): InstructionNode {
  const key = `${op}|${operandTypes.join(',')}|${target}|${String(literal)}`;
  const cached = nodeCache.get(key);
  if (cached !== undefined) return cached;
  const operands: InstructionNode['operands'][number][] = operandTypes.map((type) => ({
    kind: 'ssa',
    value: { [valueKind]: 'ssa-value', type },
  }));
  if (literal !== undefined) operands.unshift({ kind: 'literal', value: literal });
  const node: InstructionNode = {
    op,
    operands,
    results: [{ [valueKind]: 'ssa-value', type: target }],
  };
  nodeCache.set(key, node);
  return node;
}

function referenceBits(node: InstructionNode, operands: readonly RuntimeScalar[]): HexBits {
  const result = evaluateFloatInstruction(node, operands);
  if (typeof result !== 'object') throw new Error('Expected FloatBits from the reference');
  return result.bits;
}

function referenceFma(type: FloatType, a: number, b: number, c: number): HexBits {
  return referenceBits(referenceNode('float.fma', [type, type, type], type), [
    fromNumber(type, a),
    fromNumber(type, b),
    fromNumber(type, c),
  ]);
}

// ---------------------------------------------------------------------------
// Failure collection: thousands of assertions, one report
// ---------------------------------------------------------------------------

interface Checker {
  check(condition: boolean, message: () => string): void;
  finish(): void;
}

function createChecker(limit = 4): Checker {
  const failures: string[] = [];
  let count = 0;
  return {
    check(condition, message) {
      if (condition) return;
      count += 1;
      if (failures.length < limit) failures.push(message());
    },
    finish() {
      expect(failures, `${count} failing case(s)`).toEqual([]);
    },
  };
}

// ---------------------------------------------------------------------------
// Boundary representation
// ---------------------------------------------------------------------------

describe('boundary representation', () => {
  it('packs numbers exactly like the reference fromNumber', () => {
    const random = createRandom(0x51ed_1001);
    const checker = createChecker();
    const fixed = [
      0,
      -0,
      1,
      -1,
      0.5,
      -2.5,
      Number.NaN,
      Infinity,
      -Infinity,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      2 ** -149,
      2 ** -126,
      -(2 ** -1074),
    ];
    for (const type of FLOAT_TYPES) {
      const values = [...fixed];
      for (let index = 0; index < BIT_SAMPLES; index += 1) {
        values.push(toNumber(capture(type, sampleBits(type, random))));
      }
      for (const value of values) {
        const expected = fromNumber(type, value).bits;
        const actual = toBoundary(type, value);
        checker.check(
          actual.type === type && actual.bits === expected,
          () => `${type} ${value}: expected ${expected}, received ${actual.bits}`,
        );
        checker.check(Object.isFrozen(actual), () => `${type} ${value}: result is not frozen`);
      }
    }
    checker.finish();
  });

  it('round-trips f32 bit patterns through D and U', () => {
    const random = createRandom(0x51ed_1002);
    const checker = createChecker();
    const raws = [
      0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x007fffff, 0x807fffff, 0x00800000,
      0x80800000, 0x3f800000, 0xbf800000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000,
      0x7fc00000, 0xffc00000, 0x7fc00001, 0xffc00001, 0x7fffffff, 0xffffffff,
    ];
    for (let index = 0; index < BIT_SAMPLES; index += 1) raws.push(uint32(random));
    for (const raw of raws) {
      const bits = hex32(raw);
      const captured = capture('f32', randomCase(bits, random));
      const value = fromBoundary('f32', captured);
      const expected = toNumber(captured);
      const actual = toNum(value);
      checker.check(
        toBoundary('f32', value).bits === captured.bits,
        () =>
          `f32 ${captured.bits}: toBoundary(fromBoundary(x)) = ${toBoundary('f32', value).bits}`,
      );
      checker.check(
        raw32(value) === raw,
        () => `f32 ${captured.bits}: raw32 = ${hex32(raw32(value))}`,
      );
      checker.check(
        Number.isNaN(expected) ? Number.isNaN(actual) : Object.is(expected, actual),
        () => `f32 ${captured.bits}: toNum = ${String(actual)}`,
      );
      checker.check(
        Number.isNaN(expected) || Math.fround(actual) === actual,
        () => `f32 ${captured.bits}: D value is not f32-representable`,
      );
    }
    checker.finish();
  });

  it('round-trips f64 bit patterns through D and U', () => {
    const random = createRandom(0x51ed_1003);
    const checker = createChecker();
    const words: [number, number][] = [
      [0x00000000, 0x00000000],
      [0x80000000, 0x00000000],
      [0x00000000, 0x00000001],
      [0x80000000, 0x00000001],
      [0x000fffff, 0xffffffff],
      [0x00100000, 0x00000000],
      [0x3ff00000, 0x00000000],
      [0xbff00000, 0x00000000],
      [0x7fefffff, 0xffffffff],
      [0x7ff00000, 0x00000000],
      [0xfff00000, 0x00000000],
      [0x7ff80000, 0x00000000],
      [0xfff80000, 0x00000000],
      [0x7ff80000, 0x00000001],
      [0x7fffffff, 0xffffffff],
    ];
    for (let index = 0; index < BIT_SAMPLES; index += 1) {
      words.push([uint32(random), uint32(random)]);
    }
    const out = new Uint32Array(2);
    for (const [high, low] of words) {
      const bits = hex64(high, low);
      const captured = capture('f64', randomCase(bits, random));
      const value = fromBoundary('f64', captured);
      const expected = toNumber(captured);
      const actual = toNum(value);
      raw64(value, out);
      checker.check(
        toBoundary('f64', value).bits === captured.bits,
        () =>
          `f64 ${captured.bits}: toBoundary(fromBoundary(x)) = ${toBoundary('f64', value).bits}`,
      );
      checker.check(
        out[0] === low && out[1] === high,
        () => `f64 ${captured.bits}: raw64 = ${hex64(out[1]!, out[0]!)}`,
      );
      checker.check(
        Number.isNaN(expected) ? Number.isNaN(actual) : Object.is(expected, actual),
        () => `f64 ${captured.bits}: toNum = ${String(actual)}`,
      );
    }
    checker.finish();
  });

  it('normalizes exactly the D-representable values', () => {
    const lowercaseNaN = capture('f32', '0x7fc00000');
    const uppercaseNaN = capture('f32', '0x7FC00000');
    const payloadNaN = capture('f32', '0x7fc00001');
    const negativeNaN = capture('f32', '0xffc00000');
    const lowercaseOne = capture('f32', '0x3f800000');
    const uppercaseOne = capture('f32', '0x3F800000');

    expect(typeof fromBoundary('f32', lowercaseNaN)).toBe('number');
    expect(Number.isNaN(fromBoundary('f32', lowercaseNaN))).toBe(true);
    expect(fromBoundary('f32', uppercaseNaN)).toBe(uppercaseNaN);
    expect(fromBoundary('f32', payloadNaN)).toBe(payloadNaN);
    expect(fromBoundary('f32', negativeNaN)).toBe(negativeNaN);
    expect(fromBoundary('f32', lowercaseOne)).toBe(1);
    expect(fromBoundary('f32', uppercaseOne)).toBe(uppercaseOne);
    expect(Object.is(fromBoundary('f32', lowercaseOne), toNumber(lowercaseOne))).toBe(true);

    const canonical64 = capture('f64', '0x7ff8000000000000');
    expect(typeof fromBoundary('f64', canonical64)).toBe('number');
    expect(fromBoundary('f64', capture('f64', '0x7FF8000000000000'))).not.toBe(
      fromBoundary('f64', canonical64),
    );
    expect(fromBoundary('f64', capture('f64', '0x7ff8000000000001'))).toEqual(
      capture('f64', '0x7ff8000000000001'),
    );
  });

  it('passes objects through toBoundary and freezes loose ones', () => {
    const captured = capture('f64', '0xfff8000000000001');
    expect(toBoundary('f64', captured)).toBe(captured);
    const loose: FloatBits = { type: 'f64', bits: '0x7ff8000000000002' };
    const normalized = fromBoundary('f64', loose);
    expect(normalized).toBe(loose);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(toBoundary('f64', normalized).bits).toBe('0x7ff8000000000002');
  });

  it('preserves NaN classes through raw bit movement', () => {
    expect(Number.isNaN(fromRaw32(0x7fc00000))).toBe(true);
    expect(fromRaw32(0x7fc00001)).toEqual(capture('f32', '0x7fc00001'));
    expect(fromRaw32(0xffc00000)).toEqual(capture('f32', '0xffc00000'));
    expect(raw32(Number.NaN)).toBe(0x7fc00000);
    expect(raw32(fromRaw32(0x7fc00001))).toBe(0x7fc00001);

    expect(Number.isNaN(fromRaw64(0x7ff80000, 0))).toBe(true);
    expect(fromRaw64(0x7ff80000, 1)).toEqual(capture('f64', '0x7ff8000000000001'));
    const out = new Uint32Array(2);
    raw64(Number.NaN, out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7ff80000);
    raw64(capture('f64', '0x7ff8000000000001'), out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0x7ff80000);
  });
});

// ---------------------------------------------------------------------------
// IR operations
// ---------------------------------------------------------------------------

describe('IR operations', () => {
  it('matches the reference for add, sub, mul and div', () => {
    const random = createRandom(0x0b0b_0001);
    const checker = createChecker();
    const operations: readonly [string, (type: FloatType, a: number, b: number) => number][] = [
      ['float.add', floatAdd],
      ['float.sub', floatSub],
      ['float.mul', floatMul],
      ['float.div', floatDiv],
    ];
    for (const [op, compute] of operations) {
      for (const type of FLOAT_TYPES) {
        const node = referenceNode(op, [type, type], type);
        for (let index = 0; index < OP_CASES; index += 1) {
          const aBits = randomCase(sampleBits(type, random), random);
          const bBits = randomCase(sampleBits(type, random), random);
          const expected = referenceBits(node, [capture(type, aBits), capture(type, bBits)]);
          const a = numberFrom(type, aBits);
          const b = numberFrom(type, bBits);
          const actual = toBoundary(type, compute(type, a, b)).bits;
          checker.check(
            actual === expected,
            () => `${op} ${type} ${aBits} ${bBits}: expected ${expected}, received ${actual}`,
          );
        }
      }
    }
    checker.finish();
  });

  it('matches the reference for comparisons and classification', () => {
    const random = createRandom(0x0b0b_0002);
    const checker = createChecker();
    for (const type of FLOAT_TYPES) {
      for (const predicate of FLOAT_PREDICATES) {
        const node = referenceNode('float.cmp', [type, type], 'bool', predicate);
        for (let index = 0; index < COMPARISON_CASES; index += 1) {
          const aBits = randomCase(sampleBits(type, random), random);
          const bBits = randomCase(sampleBits(type, random), random);
          const expected = evaluateFloatInstruction(node, [
            capture(type, aBits),
            capture(type, bBits),
          ]);
          const actual = floatCompare(predicate, numberFrom(type, aBits), numberFrom(type, bBits));
          checker.check(
            actual === expected,
            () => `float.cmp ${predicate} ${type} ${aBits} ${bBits}: expected ${String(expected)}`,
          );
        }
      }
      const nanNode = referenceNode('float.isNaN', [type], 'bool');
      const finiteNode = referenceNode('float.isFinite', [type], 'bool');
      for (let index = 0; index < COMPARISON_CASES; index += 1) {
        const bits = randomCase(sampleBits(type, random), random);
        const value = numberFrom(type, bits);
        checker.check(
          floatIsNaN(value) === evaluateFloatInstruction(nanNode, [capture(type, bits)]),
          () => `float.isNaN ${type} ${bits}`,
        );
        checker.check(
          floatIsFinite(value) === evaluateFloatInstruction(finiteNode, [capture(type, bits)]),
          () => `float.isFinite ${type} ${bits}`,
        );
      }
    }
    checker.finish();
  });

  it('matches the reference for intToFloat and convertFloat', () => {
    const random = createRandom(0x0b0b_0003);
    const checker = createChecker();
    for (const target of FLOAT_TYPES) {
      for (const source of INTEGER_TYPES) {
        const node = referenceNode('convert.intToFloat', [source], target, target);
        const [minimum, maximum] = integerBounds(source);
        const values = [minimum, maximum, 0, 1, minimum + 1, maximum - 1].filter(
          (value) => value >= minimum && value <= maximum,
        );
        for (let index = 0; index < 50; index += 1) {
          values.push(minimum + Math.floor(random() * (maximum - minimum + 1)));
        }
        for (const value of values) {
          const expected = referenceBits(node, [value]);
          const actual = toBoundary(target, intToFloat(target, value)).bits;
          checker.check(
            actual === expected,
            () => `convert.intToFloat ${source}->${target} ${value}: expected ${expected}`,
          );
        }
      }
      const source = target === 'f32' ? 'f64' : 'f32';
      const node = referenceNode('convert.float', [source], target, target);
      for (let index = 0; index < OP_CASES; index += 1) {
        const bits = randomCase(sampleBits(source, random), random);
        const expected = referenceBits(node, [capture(source, bits)]);
        const actual = toBoundary(target, convertFloat(target, numberFrom(source, bits))).bits;
        checker.check(
          actual === expected,
          () =>
            `convert.float ${source}->${target} ${bits}: expected ${expected}, received ${actual}`,
        );
      }
    }
    checker.finish();
  });

  it('matches the reference for floatToInt and rejects the same overflow', () => {
    const random = createRandom(0x0b0b_0004);
    for (const target of INTEGER_TYPES) {
      const node = referenceNode('convert.floatToInt', ['f64'], target, target);
      const [minimum, maximum] = integerBounds(target);
      const values = [
        0,
        -0,
        1,
        -1,
        1.5,
        -1.5,
        minimum - 0.5,
        minimum,
        maximum,
        maximum + 0.5,
        minimum - 1,
        maximum + 1,
        Number.NaN,
        Infinity,
        -Infinity,
        1e300,
        -(2 ** 62),
        2 ** 62,
      ];
      for (let index = 0; index < 100; index += 1) {
        values.push((random() - 0.5) * 2 ** (Math.floor(random() * 80) - 40));
      }
      for (const value of values) {
        const operand = fromNumber('f64', value);
        const actual = floatToInt(target, toNumber(operand));
        let expected: number | null = null;
        let error: unknown = null;
        try {
          expected = evaluateFloatInstruction(node, [operand]) as number;
        } catch (caught) {
          error = caught;
        }
        if (error === null) {
          expect(actual, `${target} ${value}`).toBe(expected);
        } else {
          expect(actual, `${target} ${value}`).toBeNull();
          expect(error).toBeInstanceOf(IRFloatEvaluationError);
          expect((error as IRFloatEvaluationError).code).toBe('integer-overflow');
          expect((error as IRFloatEvaluationError).message).toBe(
            `Float cannot be converted to ${target}`,
          );
        }
      }
    }
  });
});

function integerBounds(type: IntegerType): readonly [number, number] {
  switch (type) {
    case 'u8':
      return [0, 0xff];
    case 'u16':
      return [0, 0xffff];
    case 'u32':
      return [0, 0xffffffff];
    case 'i8':
      return [-0x80, 0x7f];
    case 'i16':
      return [-0x8000, 0x7fff];
    case 'i32':
      return [-0x80000000, 0x7fffffff];
  }
}

// ---------------------------------------------------------------------------
// fma32
// ---------------------------------------------------------------------------

describe('fma32', () => {
  it('rounds the classic double-rounding traps exactly', () => {
    // (1 + 2^-23)(1 - 2^-24) = 1 + 2^-24 - 2^-47, which the naive product
    // rounds to 1; subtracting 1 afterwards loses the whole result.
    const a = Math.fround(1 + 2 ** -23);
    const b = Math.fround(1 - 2 ** -24);
    const naive = Math.fround(Math.fround(a * b) + -1);
    expect(naive).toBe(0);
    expect(fma32(a, b, -1)).toBe(2 ** -24 - 2 ** -47);
    expect(toBoundary('f32', fma32(a, b, -1)).bits).toBe(referenceFma('f32', a, b, -1));
  });

  it('rounds subnormal results correctly', () => {
    const checker = createChecker();
    const cases: readonly [number, number, number][] = [
      [2 ** -75, 2 ** -75, 0],
      [2 ** -75, 2 ** -75, 2 ** -149],
      [2 ** -149, 2 ** -149, 2 ** -149],
      [2 ** -126, 2 ** -24, -(2 ** -149)],
      [2 ** -74, 2 ** -74, -(2 ** -148)],
      [1, 2 ** -149, 0],
      [2 ** -149, 1, -(2 ** -149)],
    ];
    for (const [a, b, c] of cases) {
      const actual = fma32(a, b, c);
      checker.check(
        Math.fround(actual) === actual,
        () => `fma32(${a}, ${b}, ${c}) is not f32-representable`,
      );
      checker.check(
        toBoundary('f32', actual).bits === referenceFma('f32', a, b, c),
        () => `fma32(${a}, ${b}, ${c}) = ${toBoundary('f32', actual).bits}`,
      );
    }
    checker.finish();
  });

  it('matches the reference for special values', () => {
    const checker = createChecker();
    const specials = [
      0,
      -0,
      1,
      -1,
      Infinity,
      -Infinity,
      Number.NaN,
      2 ** -149,
      -(2 ** 149),
      3.5e38,
    ].map((value) => Math.fround(value));
    for (const a of specials) {
      for (const b of specials) {
        for (const c of specials) {
          const expected = referenceFma('f32', a, b, c);
          const actual = toBoundary('f32', fma32(a, b, c)).bits;
          checker.check(
            actual === expected,
            () => `fma32(${a}, ${b}, ${c}): expected ${expected}, received ${actual}`,
          );
        }
      }
    }
    checker.finish();
  });

  it('matches the reference for random inputs', () => {
    const random = createRandom(0xf32f_32f3);
    const checker = createChecker();
    for (let index = 0; index < FMA_CASES; index += 1) {
      const aBits = randomCase(sampleBits('f32', random), random);
      const bBits = randomCase(sampleBits('f32', random), random);
      const a = numberFrom('f32', aBits);
      const b = numberFrom('f32', bBits);
      let cBits: HexBits;
      if (index % 4 === 0) {
        // Cancel almost exactly: c ≈ -a*b, the hardest rounding case.
        cBits = toBoundary('f32', neighbour('f32', -(a * b), random)).bits;
      } else {
        cBits = randomCase(sampleBits('f32', random), random);
      }
      const c = numberFrom('f32', cBits);
      const expected = referenceFma('f32', a, b, c);
      const actual = toBoundary('f32', fma32(a, b, c)).bits;
      checker.check(
        actual === expected,
        () => `fma32(${aBits}, ${bBits}, ${cBits}): expected ${expected}, received ${actual}`,
      );
    }
    checker.finish();
  });
});

// ---------------------------------------------------------------------------
// fma64
// ---------------------------------------------------------------------------

describe('fma64', () => {
  it('rounds the classic double-rounding traps exactly', () => {
    const a = 1 + 2 ** -52;
    const b = 1 - 2 ** -52;
    expect(a * b + -1).toBe(0);
    expect(fma64(a, b, -1)).toBe(-(2 ** -104));
    expect(toBoundary('f64', fma64(a, b, -1)).bits).toBe(referenceFma('f64', a, b, -1));

    // The product underflows the naive computation, the exact result does not.
    expect(2 ** -1000 * 2 ** -1000).toBe(0);
    expect(fma64(2 ** -1000, 2 ** -1000, 2 ** -1000)).toBe(2 ** -1000);
  });

  it('matches the reference for special values', () => {
    const checker = createChecker();
    const specials = [
      0,
      -0,
      1,
      -1,
      Infinity,
      -Infinity,
      Number.NaN,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      2 ** -960,
    ];
    for (const a of specials) {
      for (const b of specials) {
        for (const c of specials) {
          const expected = referenceFma('f64', a, b, c);
          const actual = toBoundary('f64', fma64(a, b, c)).bits;
          checker.check(
            actual === expected,
            () => `fma64(${a}, ${b}, ${c}): expected ${expected}, received ${actual}`,
          );
        }
      }
    }
    checker.finish();
  });

  it('matches the reference for random inputs including cancellation', () => {
    const random = createRandom(0xf64f_64f6);
    const checker = createChecker();
    let fast = 0;
    for (let index = 0; index < FMA_CASES; index += 1) {
      const aBits = randomCase(sampleBits('f64', random), random);
      const bBits = randomCase(sampleBits('f64', random), random);
      const a = numberFrom('f64', aBits);
      const b = numberFrom('f64', bBits);
      let cBits: HexBits;
      if (index % 3 === 0) {
        cBits = toBoundary('f64', neighbour('f64', -(a * b), random)).bits;
      } else {
        cBits = randomCase(sampleBits('f64', random), random);
      }
      const c = numberFrom('f64', cBits);
      if (fma64FastPathApplies(a, b, c)) fast += 1;
      const expected = referenceFma('f64', a, b, c);
      const actual = toBoundary('f64', fma64(a, b, c)).bits;
      checker.check(
        actual === expected,
        () => `fma64(${aBits}, ${bBits}, ${cBits}): expected ${expected}, received ${actual}`,
      );
    }
    checker.finish();
    // The mixed sampler must reach both the fast path and the fallback.
    expect(fast, `fast path hit ${fast}/${FMA_CASES} cases`).toBeGreaterThan(FMA_CASES * 0.05);
  });

  it('matches the reference for random inputs inside the fast-path range', () => {
    const random = createRandom(0xf64f_64f7);
    const checker = createChecker();
    let outside = 0;
    for (let index = 0; index < FMA_CASES; index += 1) {
      const a = typicalMagnitude(random, 480);
      const b = typicalMagnitude(random, 480);
      const product = a * b;
      // Near-total cancellation, an independently scaled addend, and a much
      // smaller addend: the three shapes the fast path must round correctly.
      const c =
        index % 3 === 0
          ? neighbour('f64', -product, random)
          : index % 3 === 1
            ? typicalMagnitude(random, 960)
            : typicalMagnitude(random, 60);
      if (!fma64FastPathApplies(a, b, c)) outside += 1;
      const expected = referenceFma('f64', a, b, c);
      const actual = toBoundary('f64', fma64(a, b, c)).bits;
      checker.check(
        actual === expected,
        () => `fma64(${a}, ${b}, ${c}): expected ${expected}, received ${actual}`,
      );
    }
    checker.finish();
    expect(outside / FMA_CASES, `left the fast path ${outside}/${FMA_CASES} times`).toBeLessThan(
      0.05,
    );
  });

  it('agrees with the reference on both sides of the fast-path thresholds', () => {
    const checker = createChecker();
    const exponents = [-968, -961, -960, -959, -481, -480, -479, 0, 479, 480, 481, 959, 960, 961];
    for (const left of exponents) {
      for (const right of exponents) {
        for (const addend of exponents) {
          const a = 1.5 * 2 ** left;
          const b = -1.25 * 2 ** right;
          const c = 1.125 * 2 ** addend;
          const expected = referenceFma('f64', a, b, c);
          const actual = toBoundary('f64', fma64(a, b, c)).bits;
          checker.check(
            actual === expected,
            () => `fma64(${a}, ${b}, ${c}): expected ${expected}, received ${actual}`,
          );
        }
      }
    }
    checker.finish();
  });

  it('falls back when the fast-path result may be subnormal', () => {
    const a = 2 ** -480;
    const b = 2 ** -480 * (1 + 2 ** -52);
    const c = -(2 ** -960);
    expect(fma64FastPathApplies(a, b, c)).toBe(true);
    expect(fma64(a, b, c)).toBe(2 ** -1012);
    expect(toBoundary('f64', fma64(a, b, c)).bits).toBe(referenceFma('f64', a, b, c));

    // A zero result also leaves the proved range.
    expect(fma64FastPathApplies(2 ** -480, 2 ** 480, -1)).toBe(true);
    expect(toBoundary('f64', fma64(2 ** -480, 2 ** 480, -1)).bits).toBe(
      referenceFma('f64', 2 ** -480, 2 ** 480, -1),
    );
  });

  it('applies the documented fast-path bounds', () => {
    expect(fma64FastPathApplies(2 ** -480, 2 ** -480, 2 ** -960)).toBe(true);
    expect(fma64FastPathApplies(2 ** 480, 2 ** 480, 2 ** 960)).toBe(true);
    expect(fma64FastPathApplies(1, 1, 1)).toBe(true);
    expect(fma64FastPathApplies(2 ** -481, 1, 1)).toBe(false);
    expect(fma64FastPathApplies(2 ** 481, 1, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 2 ** -481, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 2 ** 481, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 1, 2 ** -961)).toBe(false);
    expect(fma64FastPathApplies(1, 1, 2 ** 961)).toBe(false);
    expect(fma64FastPathApplies(0, 1, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 0, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 1, 0)).toBe(false);
    expect(fma64FastPathApplies(Number.NaN, 1, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 1, Number.NaN)).toBe(false);
    expect(fma64FastPathApplies(Infinity, 1, 1)).toBe(false);
    expect(fma64FastPathApplies(1, 1, -Infinity)).toBe(false);
  });

  it('takes the fast path for inputs inside the proved range', () => {
    const random = createRandom(0xffff_0001);
    let slow = 0;
    const cases = 2000;
    for (let index = 0; index < cases; index += 1) {
      const a = typicalMagnitude(random, 400);
      const b = typicalMagnitude(random, 400);
      const c = typicalMagnitude(random, 960);
      if (!fma64FastPathApplies(a, b, c)) slow += 1;
      if (index % 8 === 0) {
        expect(toBoundary('f64', fma64(a, b, c)).bits).toBe(referenceFma('f64', a, b, c));
      }
    }
    // Uniform inputs restricted to the proved exponent range never fall back.
    expect(slow / cases).toBeLessThan(0.01);
  });
});

/** Normal finite double with an exponent in `[-limit + 1, limit - 1]`. */
function typicalMagnitude(random: () => number, limit: number): number {
  const exponent = Math.floor(random() * (2 * limit - 1)) - limit + 1;
  const value = (1 + random() * 0.5) * 2 ** exponent;
  return random() < 0.5 ? -value : value;
}
