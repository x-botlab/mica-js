import { describe, expect, it } from 'vitest';
import { ms, ns, ps, seconds, us } from './time';

describe('testbench durations', () => {
  it('accepts fractional units when they resolve to whole picoseconds', () => {
    expect(ms(0.01)).toBe(10_000_000);
    expect(ns(0.001)).toBe(ps(1));
    expect(us(0.5)).toBe(500_000);
    expect(seconds(0.001)).toBe(ms(1));
  });

  it('rejects fractional picoseconds and values beyond the simulation clock', () => {
    expect(() => ns(0.0001)).toThrow();
    expect(() => seconds(10_000)).toThrow();
    expect(() => ms(-0.01)).toThrow();
  });
});
