import type { FloatType, HexBits } from './types';

/** Exact floating data for movement; never decode/re-encode a NaN to copy it. */
export interface FloatBits {
  readonly type: FloatType;
  readonly bits: HexBits;
}

export type RuntimeScalar = boolean | number | FloatBits;

type Format = {
  fraction: number;
  bias: number;
  minimum: number;
  maximum: number;
  digits: number;
};

const FORMATS: Record<FloatType, Format> = {
  f32: { fraction: 23, bias: 127, minimum: -126, maximum: 127, digits: 8 },
  f64: { fraction: 52, bias: 1023, minimum: -1022, maximum: 1023, digits: 16 },
};

export interface DecodedFloat {
  kind: 'finite' | 'infinity' | 'nan';
  negative: boolean;
  coefficient: bigint;
  exponent: number;
}

export function pack(type: FloatType, bits: bigint): FloatBits {
  return Object.freeze({
    type,
    bits: `0x${bits.toString(16).padStart(FORMATS[type].digits, '0')}` as HexBits,
  });
}

export function decode(value: FloatBits): DecodedFloat {
  const format = FORMATS[value.type];
  const bits = BigInt(value.bits);
  const fraction = BigInt(format.fraction);
  const coefficient = bits & ((1n << fraction) - 1n);
  const exponent = Number((bits >> fraction) & BigInt(2 * format.bias + 1));
  return {
    negative: bits >> BigInt(format.digits * 4 - 1) !== 0n,
    kind: exponent === 2 * format.bias + 1 ? (coefficient === 0n ? 'infinity' : 'nan') : 'finite',
    coefficient: exponent === 0 ? coefficient : coefficient + (1n << fraction),
    exponent: (exponent === 0 ? format.minimum : exponent - format.bias) - format.fraction,
  };
}

export function special(
  type: FloatType,
  kind: 'nan' | 'infinity' | 'zero',
  negative = false,
): FloatBits {
  const format = FORMATS[type];
  const sign = negative ? 1n << BigInt(format.digits * 4 - 1) : 0n;
  if (kind === 'zero') return pack(type, sign);
  const exponent = BigInt(2 * format.bias + 1) << BigInt(format.fraction);
  return pack(
    type,
    kind === 'nan' ? exponent | (1n << BigInt(format.fraction - 1)) : sign | exponent,
  );
}

export function fromNumber(type: FloatType, value: number): FloatBits {
  if (Number.isNaN(value)) return special(type, 'nan');
  const view = new DataView(new ArrayBuffer(8));
  if (type === 'f32') {
    view.setFloat32(0, value, false);
    return pack(type, BigInt(view.getUint32(0, false)));
  }
  view.setFloat64(0, value, false);
  return pack(type, view.getBigUint64(0, false));
}

export function toNumber(value: FloatBits): number {
  const view = new DataView(new ArrayBuffer(8));
  if (value.type === 'f32') {
    view.setUint32(0, Number(BigInt(value.bits)), false);
    return view.getFloat32(0, false);
  }
  view.setBigUint64(0, BigInt(value.bits), false);
  return view.getFloat64(0, false);
}

function length(value: bigint): number {
  return value.toString(2).length;
}

/** Round n/d * 2^exponent directly, including gradual underflow and ties to even. */
export function round(
  type: FloatType,
  negative: boolean,
  numerator: bigint,
  denominator: bigint,
  exponent: number,
): FloatBits {
  if (numerator === 0n) return special(type, 'zero', negative);
  const format = FORMATS[type];
  const difference = length(numerator) - length(denominator);
  const below =
    difference >= 0
      ? numerator < denominator << BigInt(difference)
      : numerator << BigInt(-difference) < denominator;
  const leading = difference + exponent - Number(below);
  const step = Math.max(leading, format.minimum) - format.fraction;
  const shift = exponent - step;
  const n = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const d = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let significand = n / d;
  const remainder = n % d;
  if (2n * remainder > d || (2n * remainder === d && (significand & 1n) !== 0n)) {
    significand += 1n;
  }
  if (significand === 0n) return special(type, 'zero', negative);
  const width = length(significand) - 1;
  const resultExponent = width + step;
  if (resultExponent > format.maximum) return special(type, 'infinity', negative);
  const sign = negative ? 1n << BigInt(format.digits * 4 - 1) : 0n;
  if (resultExponent < format.minimum) return pack(type, sign | significand);
  const normalized =
    width > format.fraction
      ? significand >> BigInt(width - format.fraction)
      : significand << BigInt(format.fraction - width);
  return pack(
    type,
    sign |
      (BigInt(resultExponent + format.bias) << BigInt(format.fraction)) |
      (normalized - (1n << BigInt(format.fraction))),
  );
}

function sum(type: FloatType, left: DecodedFloat, right: DecodedFloat): FloatBits {
  const exponent = Math.min(left.exponent, right.exponent);
  const a = left.coefficient << BigInt(left.exponent - exponent);
  const b = right.coefficient << BigInt(right.exponent - exponent);
  const exact = (left.negative ? -a : a) + (right.negative ? -b : b);
  const negative = exact < 0n || (exact === 0n && left.negative && right.negative);
  return round(type, negative, exact < 0n ? -exact : exact, 1n, exponent);
}

export function arithmetic(
  type: FloatType,
  operation: string,
  operands: readonly FloatBits[],
): FloatBits {
  const values = operands.map(decode);
  if (values.some((value) => value.kind === 'nan')) return special(type, 'nan');
  const a = values[0]!;
  const b = values[1]!;
  const negative = a.negative !== b.negative;
  if (operation === 'float.sub') b.negative = !b.negative;
  if (operation === 'float.add' || operation === 'float.sub') {
    if (a.kind === 'infinity' || b.kind === 'infinity') {
      if (a.kind === b.kind && a.negative !== b.negative) return special(type, 'nan');
      return special(type, 'infinity', a.kind === 'infinity' ? a.negative : b.negative);
    }
    return sum(type, a, b);
  }
  if (operation === 'float.div') {
    if (
      (a.kind === 'infinity' && b.kind === 'infinity') ||
      (a.coefficient === 0n && b.coefficient === 0n)
    )
      return special(type, 'nan');
    if (a.kind === 'infinity' || b.coefficient === 0n) return special(type, 'infinity', negative);
    if (b.kind === 'infinity') return special(type, 'zero', negative);
    return round(type, negative, a.coefficient, b.coefficient, a.exponent - b.exponent);
  }
  const infinite = a.kind === 'infinity' || b.kind === 'infinity';
  if (infinite && (a.coefficient === 0n || b.coefficient === 0n)) return special(type, 'nan');
  if (operation === 'float.mul') {
    return infinite
      ? special(type, 'infinity', negative)
      : round(type, negative, a.coefficient * b.coefficient, 1n, a.exponent + b.exponent);
  }
  const c = values[2]!;
  if (infinite) {
    return c.kind === 'infinity' && c.negative !== negative
      ? special(type, 'nan')
      : special(type, 'infinity', negative);
  }
  if (c.kind === 'infinity') return special(type, 'infinity', c.negative);
  // Keep the entire product, including overflow/underflow bits, until the sum is rounded.
  return sum(
    type,
    {
      kind: 'finite',
      negative,
      coefficient: a.coefficient * b.coefficient,
      exponent: a.exponent + b.exponent,
    },
    c,
  );
}
