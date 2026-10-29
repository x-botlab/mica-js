import { describe, expect, it } from 'vitest';
import {
  assertInRange,
  readEnum,
  readNumber,
  readOptionalRangedNumber,
  readOptions,
  readRangedNumber,
  requireListener,
} from './validate';

describe('readOptions', () => {
  it('accepts a missing options object', () => {
    expect(readOptions(undefined, ['volume'], 'options')).toEqual({});
  });

  it('rejects values that are not plain objects', () => {
    expect(() => readOptions(null, ['volume'], 'options')).toThrow(TypeError);
    expect(() => readOptions([], ['volume'], 'options')).toThrow(TypeError);
    expect(() => readOptions(3, ['volume'], 'options')).toThrow(TypeError);
    expect(() => readOptions(new Map(), ['volume'], 'options')).toThrow(TypeError);
  });

  it('rejects unknown keys and explicit undefined', () => {
    expect(() => readOptions({ loop: true }, ['volume'], 'options')).toThrow(TypeError);
    expect(() => readOptions({ volume: undefined }, ['volume'], 'options')).toThrow(TypeError);
  });
});

describe('readNumber', () => {
  it('separates wrong types from non-finite numbers', () => {
    expect(() => readNumber('1', 'options.volume')).toThrow(TypeError);
    expect(() => readNumber(Number.NaN, 'options.volume')).toThrow(RangeError);
    expect(() => readNumber(Number.POSITIVE_INFINITY, 'options.volume')).toThrow(RangeError);
    expect(readNumber(0.5, 'options.volume')).toBe(0.5);
  });

  it('requires a value when no fallback was given', () => {
    expect(() => readNumber(undefined, 'options.frequency')).toThrow(TypeError);
    expect(readNumber(undefined, 'options.volume', 1)).toBe(1);
  });
});

describe('assertInRange', () => {
  it('checks both bounds', () => {
    expect(assertInRange(0, { min: 0, max: 1 }, 'x')).toBe(0);
    expect(assertInRange(1, { min: 0, max: 1 }, 'x')).toBe(1);
    expect(() => assertInRange(1.1, { min: 0, max: 1 }, 'x')).toThrow(RangeError);
    expect(() => assertInRange(-0.1, { min: 0, max: 1 }, 'x')).toThrow(RangeError);
  });

  it('excludes the lower bound when asked', () => {
    expect(() => assertInRange(0, { min: 0, max: 24000, exclusiveMin: true }, 'hz')).toThrow(
      RangeError,
    );
    expect(assertInRange(0.1, { min: 0, max: 24000, exclusiveMin: true }, 'hz')).toBe(0.1);
  });

  it('requires integers when asked', () => {
    expect(() => assertInRange(8000.5, { min: 8000, max: 96000, integer: true }, 'rate')).toThrow(
      RangeError,
    );
    expect(assertInRange(22050, { min: 8000, max: 96000, integer: true }, 'rate')).toBe(22050);
  });
});

describe('readRangedNumber', () => {
  it('reads a default and validates the range', () => {
    expect(readRangedNumber({}, 'volume', 'options', { min: 0, max: 1 }, 1)).toBe(1);
    expect(readRangedNumber({ volume: 0 }, 'volume', 'options', { min: 0, max: 1 }, 1)).toBe(0);
    expect(() => readRangedNumber({ volume: 2 }, 'volume', 'options', { min: 0, max: 1 })).toThrow(
      RangeError,
    );
  });

  it('treats an absent optional value as undefined', () => {
    expect(readOptionalRangedNumber({}, 'rate', 'options', { min: 0.25, max: 4 })).toBeUndefined();
    expect(readOptionalRangedNumber({ rate: 2 }, 'rate', 'options', { min: 0.25, max: 4 })).toBe(2);
    expect(() =>
      readOptionalRangedNumber({ rate: 8 }, 'rate', 'options', { min: 0.25, max: 4 }),
    ).toThrow(RangeError);
  });
});

describe('readEnum', () => {
  it('accepts members and rejects everything else', () => {
    expect(readEnum({ type: 'square' }, 'type', ['sine', 'square'], 'options', 'sine')).toBe(
      'square',
    );
    expect(readEnum({}, 'type', ['sine', 'square'], 'options', 'sine')).toBe('sine');
    expect(() => readEnum({ type: 'noise' }, 'type', ['sine'], 'options', 'sine')).toThrow(
      RangeError,
    );
    expect(() => readEnum({ type: 4 }, 'type', ['sine'], 'options', 'sine')).toThrow(RangeError);
  });

  it('supports numeric choices', () => {
    expect(readEnum({ channels: 2 }, 'channels', [1, 2] as const, 'options', 1)).toBe(2);
    expect(() => readEnum({ channels: 3 }, 'channels', [1, 2] as const, 'options', 1)).toThrow(
      RangeError,
    );
  });
});

describe('requireListener', () => {
  it('requires a function', () => {
    expect(() => requireListener(undefined, 'listener')).toThrow(TypeError);
    expect(() => requireListener('x', 'listener')).toThrow(TypeError);
    expect(() => requireListener(() => {}, 'listener')).not.toThrow();
  });
});
