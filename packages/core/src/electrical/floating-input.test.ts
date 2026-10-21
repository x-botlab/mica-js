import { describe, expect, it } from 'vitest';
import { createFloatingInput, resolveElectricalNetwork, type FloatingInputSample } from '../index';

function voltage(sample: FloatingInputSample): number {
  expect(sample.state).toBe('ready');
  if (sample.state !== 'ready') throw new Error('Expected ready sample');
  return sample.voltage;
}

const vectors = [
  [0, 0.31208, 1.155351],
  [100, 0.31327, 1.046522],
  [101, 0.271498, 1.067295],
  [4294967296, 0.22421, 1.087303],
  [7200000000000000, 0.177746, 1.055952],
] as const;

// BigInt arithmetic is an independent oracle for the specified 32-bit bit operations.
function reference(
  seed: number,
  instanceId: string,
  pinName: string,
  count: number,
  supply: number,
  time: number,
): number {
  const mask = 0xffffffffn;
  let hash = 0x811c9dc5n;
  for (const byte of new TextEncoder().encode(
    JSON.stringify(['mica-floating-v2', seed, instanceId, pinName, count]),
  )) {
    hash = ((hash ^ BigInt(byte)) * 0x01000193n) & mask;
  }
  if (hash === 0n) hash = 1n;
  let initial = hash;
  initial = (initial ^ (initial << 13n)) & mask;
  initial = (initial ^ (initial >> 17n)) & mask;
  initial = (initial ^ (initial << 5n)) & mask;
  const mix = (value: bigint): bigint => {
    value = ((value ^ (value >> 16n)) * 0x7feb352dn) & mask;
    value = ((value ^ (value >> 15n)) * 0x846ca68bn) & mask;
    return (value ^ (value >> 16n)) & mask;
  };
  const timeBits = BigInt(time);
  const random = Number(mix(mix(hash ^ (timeBits & mask)) ^ (timeBits >> 32n))) / 0x100000000;
  const v0 = (Number(initial) / 0x100000000) * supply;
  return Math.min(supply, Math.max(0, v0 + (random * 2 - 1) * 0.1));
}

describe('mica-floating-v2', () => {
  it.each(vectors)('replays both #24 episodes at %s ps', (time, first, second) => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    floating.beginFloating(3.3);
    expect(voltage(floating.sample(3.3, time))).toBeCloseTo(first, 6);
    expect(voltage(floating.sample(3.3, time))).toBe(
      reference(12345, 'device-1', 'AIN', 1, 3.3, time),
    );
    floating.beginFloating(3.3);
    expect(voltage(floating.sample(3.3, time))).toBeCloseTo(second, 6);
    expect(voltage(floating.sample(3.3, time))).toBe(
      reference(12345, 'device-1', 'AIN', 2, 3.3, time),
    );
  });

  it.each([0, 1, 12345, 0xffffffff])(
    'matches the independent oracle for seed %s and raw Unicode identities',
    (seed) => {
      for (const [instanceId, pinName] of [
        ['a:b', 'c'],
        ['a', 'b:c'],
        [' device ', ' A '],
        ['\u00e9', '\u03a9'],
        ['e\u0301', '\ud83d\ude00'],
        ['\ud800', '\udfff'],
        ['\u0000', '"\\'],
      ]) {
        const floating = createFloatingInput(seed, instanceId!, pinName!);
        for (let count = 1; count <= 3; count += 1) {
          floating.beginFloating(3.3);
          for (const time of [0, 1, 0xffffffff, 0x100000000, 0x100000001, 7200000000000000]) {
            expect(voltage(floating.sample(3.3, time))).toBe(
              reference(seed, instanceId!, pinName!, count, 3.3, time),
            );
          }
        }
      }
    },
  );

  it('replaces the exact zero FNV stage hash with one', () => {
    const floating = createFloatingInput(0, 'zero-hash', '45:0O +');
    let rawHash = 0x811c9dc5n;
    for (const byte of new TextEncoder().encode(
      JSON.stringify(['mica-floating-v2', 0, 'zero-hash', '45:0O +', 1]),
    )) {
      rawHash = ((rawHash ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
    }
    expect(rawHash).toBe(0n);
    floating.beginFloating(1000);
    const samples = [0, 1, 100, 4294967296].map((time) => {
      const actual = voltage(floating.sample(1000, time));
      expect(actual).toBe(reference(0, 'zero-hash', '45:0O +', 1, 1000, time));
      return actual;
    });
    expect(samples.some((value) => value > 0)).toBe(true);
  });

  it('does not advance randomness for reads, observers, disabled reads or other pins', () => {
    const baseline = createFloatingInput(12345, 'device-1', 'AIN');
    const observed = createFloatingInput(12345, 'device-1', 'AIN');
    const unrelated = createFloatingInput(12345, 'other', 'AIN');
    baseline.beginFloating(3.3);
    observed.beginFloating(3.3);
    unrelated.beginFloating(5);
    for (const [time] of vectors) {
      const expected = baseline.sample(3.3, time);
      for (let index = 0; index < 10; index += 1) {
        expect(observed.sample(3.3, time)).toEqual(expected);
        expect(observed.sample(NaN, Infinity, false)).toEqual({ state: 'disabled' });
        unrelated.beginFloating(index);
        unrelated.sample(index, time);
        resolveElectricalNetwork({ networkId: `unrelated-${index}`, pins: [] });
      }
      expect(observed.sample(3.3, time)).toEqual(expected);
    }
  });

  it('uses high time bits and never advances virtual time itself', () => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    floating.beginFloating(3.3);
    const first = floating.sample(3.3, 0);
    expect(floating.sample(3.3, 0x100000000)).not.toEqual(first);
    expect(floating.sample(3.3, 0)).toEqual(first);
  });

  it('counts every gated physical episode and initializes at the recovery resolution point', () => {
    const deferred = createFloatingInput(12345, 'device-1', 'AIN');
    const immediate = createFloatingInput(12345, 'device-1', 'AIN');
    deferred.beginFloating();
    immediate.beginFloating(1);
    expect(deferred.sample(NaN, -1, false)).toEqual({ state: 'disabled' });
    deferred.beginFloating();
    immediate.beginFloating(1);
    deferred.beginFloating();
    immediate.beginFloating(3.3);
    expect(deferred.sample(3.3, 100)).toEqual(immediate.sample(3.3, 100));
    expect(voltage(deferred.sample(3.3, 100))).toBe(
      reference(12345, 'device-1', 'AIN', 3, 3.3, 100),
    );
    // A later business read at a different supply must reuse the recovery-initialized V0.
    expect(deferred.sample(5, 101)).toEqual(immediate.sample(5, 101));
  });

  it('keeps V0 fixed when supply changes, clamps to current rails and restores the same value', () => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    floating.beginFloating(3.3);
    const original = floating.sample(3.3, 100);
    expect(floating.sample(5, 100)).toEqual(original);
    expect(floating.sample(0.1, 100)).toEqual({ state: 'ready', voltage: 0.1 });
    expect(floating.sample(0, 100)).toEqual({ state: 'ready', voltage: 0 });
    expect(floating.sample(3.3, 100)).toEqual(original);
  });

  it('initializes with zero supply and clamps negative noise to zero', () => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    floating.beginFloating(0);
    expect(floating.sample(0, 0)).toEqual({ state: 'ready', voltage: 0 });
    expect(floating.sample(3.3, 0)).toEqual({ state: 'ready', voltage: 0.08748125103302301 });
    expect(floating.sample(3.3, 4294967296)).toEqual({ state: 'ready', voltage: 0 });
  });

  it('generates a new V0 on re-entry after a determined network', () => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    floating.beginFloating(3.3);
    const first = floating.sample(3.3, 0);
    // The integration layer tracks the driven interval, then registers the next entry.
    floating.beginFloating(3.3);
    const second = floating.sample(3.3, 0);
    expect(second).not.toEqual(first);
    expect(voltage(second)).toBeCloseTo(1.155351, 6);
  });

  it('never exposes disabled placeholders as available voltage', () => {
    const floating = createFloatingInput(12345, 'device-1', 'AIN');
    expect(floating.sample(NaN, NaN, false)).toEqual({ state: 'disabled' });
    expect(floating.sample(0, 0, false)).not.toHaveProperty('voltage');
    expect(() => floating.sample(3.3, 0)).toThrow('Call beginFloating');
    floating.beginFloating();
    expect(Object.isFrozen(floating)).toBe(true);
    expect(Object.isFrozen(floating.sample(3.3, 0))).toBe(true);
    expect(Object.isFrozen(floating.sample(3.3, 0, false))).toBe(true);
  });
});

describe('floating input runtime validation and failure atomicity', () => {
  it.each([NaN, Infinity, -Infinity, 0.5, '1', null, undefined])(
    'rejects non-u32 seed %s with TypeError',
    (seed) => {
      expect(() => createFloatingInput(seed as number, 'device', 'P')).toThrow(TypeError);
      expect(() => createFloatingInput(seed as number, 'device', 'P')).toThrow('seed:');
    },
  );

  it.each([-1, 0x100000000])('rejects out-of-range seed %s with RangeError', (seed) => {
    expect(() => createFloatingInput(seed, 'device', 'P')).toThrow(RangeError);
  });

  it.each([
    ['', 'P'],
    ['device', ''],
    [null, 'P'],
    ['device', 1],
  ])('rejects invalid identity %s/%s', (instance, pin) => {
    expect(() => createFloatingInput(0, instance as string, pin as string)).toThrow(TypeError);
  });

  it.each([NaN, Infinity, -Infinity, 0.5, '1', null, undefined])(
    'rejects invalid time %s without initializing deferred V0',
    (time) => {
      const floating = createFloatingInput(12345, 'device-1', 'AIN');
      floating.beginFloating();
      expect(() => floating.sample(5, time as number)).toThrow(TypeError);
      expect(() => floating.sample(5, time as number)).toThrow('timePs:');
      expect(voltage(floating.sample(3.3, 0))).toBe(reference(12345, 'device-1', 'AIN', 1, 3.3, 0));
    },
  );

  it.each([-1, 7200000000000001])('rejects out-of-range time %s', (time) => {
    const floating = createFloatingInput(0, 'device', 'P');
    floating.beginFloating(3.3);
    expect(() => floating.sample(3.3, time)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, -1, '3.3', null])(
    'rejects invalid supply %s without advancing or replacing an episode',
    (supply) => {
      const floating = createFloatingInput(12345, 'device-1', 'AIN');
      floating.beginFloating(3.3);
      const before = floating.sample(3.3, 0);
      const kind = supply === -1 ? RangeError : TypeError;
      expect(() => floating.beginFloating(supply as number)).toThrow(kind);
      expect(() => floating.sample(supply as number, 0)).toThrow(kind);
      expect(floating.sample(3.3, 0)).toEqual(before);
      floating.beginFloating(3.3);
      expect(voltage(floating.sample(3.3, 0))).toBe(reference(12345, 'device-1', 'AIN', 2, 3.3, 0));
    },
  );

  it('rejects invalid enabled flags and accepts the full finite supply range', () => {
    const floating = createFloatingInput(0xffffffff, 'device', 'P');
    expect(() => floating.sample(3.3, 0, 0 as unknown as boolean)).toThrow(TypeError);
    floating.beginFloating(Number.MAX_VALUE);
    const result = voltage(floating.sample(Number.MAX_VALUE, 7200000000000000));
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(Number.MAX_VALUE);
  });
});
