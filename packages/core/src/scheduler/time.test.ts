import { describe, expect, it } from 'vitest';
import { addTime, MAX_TIME_PS, subtractTime, timePs, toTimePs } from './time';
import type { TimeUnit } from './time';

describe('integer picosecond time', () => {
  it('accepts both inclusive boundaries and normalizes negative zero', () => {
    for (const input of [0, 1, MAX_TIME_PS - 1, MAX_TIME_PS]) expect(timePs(input)).toBe(input);
    expect(Object.is(timePs(-0), 0)).toBe(true);
    expect(timePs(JSON.parse(JSON.stringify(MAX_TIME_PS)) as number)).toBe(MAX_TIME_PS);
  });

  it.each([undefined, null, '1', true, 1n, NaN, Infinity, -Infinity, 0.5, -0.5])(
    'rejects non-number or nonfinite/noninteger time %s before range checks',
    (input) => {
      expect(() => timePs(input as number)).toThrow(TypeError);
    },
  );

  it.each([-1, MAX_TIME_PS + 1, Number.MAX_SAFE_INTEGER, 1e30])(
    'rejects integer outside bounds %s',
    (input) => {
      expect(() => timePs(input)).toThrow(RangeError);
      expect(() => timePs(input)).toThrow(String(input));
    },
  );

  it.each<[TimeUnit, number, number]>([
    ['ps', 1, 1],
    ['ns', 1, 1_000],
    ['us', 1, 1_000_000],
    ['µs', 1, 1_000_000],
    ['ms', 1, 1_000_000_000],
    ['s', 1, 1_000_000_000_000],
    ['s', 7_200, MAX_TIME_PS],
    ['ns', 7_200_000_000_000, MAX_TIME_PS],
  ])('converts %s integer units exactly', (unit, input, expected) => {
    expect(toTimePs(input, unit)).toBe(expected);
    expect(toTimePs(0, unit)).toBe(0);
    expect(() => toTimePs(-1, unit)).toThrow(RangeError);
    expect(() => toTimePs(0.5, unit)).toThrow(TypeError);
  });

  it('treats µs (Unicode) as equivalent to us (ASCII)', () => {
    const ascii = toTimePs(1, 'us');
    const unicode = toTimePs(1, 'µs');
    expect(ascii).toBe(unicode);
    expect(ascii).toBe(1_000_000);
    expect(unicode).toBe(1_000_000);
    expect(toTimePs(7_200_000_000, 'µs')).toBe(MAX_TIME_PS);
    expect(toTimePs(0, 'µs')).toBe(toTimePs(0, 'us'));
    expect(() => toTimePs(-1, 'µs')).toThrow(RangeError);
    expect(() => toTimePs(0.5, 'µs')).toThrow(TypeError);
    expect(() => toTimePs(7_200_000_001, 'µs')).toThrow(RangeError);
  });

  it('accepts both us and µs as valid units', () => {
    expect(() => toTimePs(1, 'us')).not.toThrow();
    expect(() => toTimePs(1, 'µs')).not.toThrow();
  });

  it('rejects invalid units with a TypeError naming the unit', () => {
    // @ts-expect-error 'xs' is not a TimeUnit
    expect(() => toTimePs(1, 'xs')).toThrow(TypeError);
    // @ts-expect-error 'xs' is not a TimeUnit
    expect(() => toTimePs(1, 'xs')).toThrow('unit');
  });

  it('rejects unknown units and conversion overflow', () => {
    for (const unit of ['minutes', '__proto__', undefined]) {
      expect(() => toTimePs(1, unit as TimeUnit)).toThrow(TypeError);
    }
    expect(() => toTimePs(7_201, 's')).toThrow(RangeError);
    expect(() => toTimePs(MAX_TIME_PS, 'ns')).toThrow(/conversion.*ns to ps/);
  });

  it('validates both operands and operation results', () => {
    expect(addTime(MAX_TIME_PS - 1, 1)).toBe(MAX_TIME_PS);
    expect(subtractTime(MAX_TIME_PS, MAX_TIME_PS - 1)).toBe(1);
    expect(subtractTime(9, 9)).toBe(0);
    expect(() => addTime(MAX_TIME_PS, 1)).toThrow(/addition/);
    expect(() => subtractTime(1, 2)).toThrow(/subtraction/);
    expect(() => addTime(0, NaN)).toThrow(/right/);
    expect(() => subtractTime(-1, 0)).toThrow(/later/);
    expect(() => subtractTime(0, Infinity)).toThrow(TypeError);
    expect(() => addTime(-1, 1)).toThrow(RangeError);
  });
});
