/**
 * J09 parity fuzzing: seeded random IR programs executed by the reference
 * interpreter and by every JIT configuration. A failure message always names
 * the seed, profile and configuration so the program can be reproduced.
 */
import { describe, expect, it } from 'vitest';
import { PARITY_CONFIGS, formatDivergence, runOracle, runProgram } from './testing/oracle';
import type { RandomProgram, RandomProfile } from './testing/random-ir';
import { randomProgram } from './testing/random-ir';

const PROFILES: readonly RandomProfile[] = [
  'float-heavy',
  'provider-heavy',
  'deep-recursion',
  'storage-heavy',
];

function check(seed: number, profile?: RandomProfile, configs = PARITY_CONFIGS): void {
  const program = randomProgram({ seed, ...(profile === undefined ? {} : { profile }) });
  const divergence = runOracle(program, configs);
  if (divergence !== undefined) throw new Error(formatDivergence(divergence));
}

describe('JIT parity fuzzing', () => {
  it('matches the reference on the fixed CI seed set (150 programs)', () => {
    for (let seed = 1; seed <= 150; seed += 1) check(seed);
  }, 120_000);

  it.each(PROFILES)(
    'matches the reference for 25 %s programs',
    (profile) => {
      for (let seed = 1_000; seed < 1_025; seed += 1) check(seed, profile);
    },
    120_000,
  );

  it('captures complete storage and provider snapshots', () => {
    const program = randomProgram({ seed: 11 });
    const reference = runProgram(program, PARITY_CONFIGS[0]!);
    expect(reference.creationError).toBeUndefined();
    expect(reference.invocations).toHaveLength(program.invocations.length);

    const epochs = reference.invocations.map((invocation) => invocation.providerCacheEpoch);
    // key=1 (generate), firmware update (regenerate), key=1 (cache hit), key=2 (generate)
    expect(epochs).toEqual([1, 2, 2, 3]);
    expect(reference.invocations.at(-1)!.providerKeys).toEqual([1, 1, 2]);

    const snapshots = reference.invocations.map((invocation) => JSON.stringify(invocation.storage));
    expect(snapshots.every((snapshot) => snapshot.length > 10)).toBe(true);

    // Storage must actually change between invocations for the snapshot to be useful.
    expect(new Set(snapshots).size).toBeGreaterThan(1);
  });

  it('records provider cache-epoch parity on every configuration', () => {
    const program = randomProgram({ seed: 17 });
    const records = PARITY_CONFIGS.map((config) => runProgram(program, config));
    const expected = records[0]!.invocations.map((invocation) => invocation.providerCacheEpoch);
    expect(expected).toEqual([1, 2, 2, 3]);
    for (const record of records.slice(1)) {
      expect(record.invocations.map((invocation) => invocation.providerCacheEpoch)).toEqual(
        expected,
      );
    }
  });

  it('matches at every step boundary from 0 to completion', () => {
    const base = randomProgram({ seed: 23, maxDepth: 1 });
    const complete = runProgram(base, PARITY_CONFIGS[0]!);
    const total = complete.invocations.reduce(
      (sum, invocation) => Math.max(sum, invocation.steps),
      0,
    );
    expect(total).toBeGreaterThan(5);

    for (let maxSteps = 0; maxSteps <= total; maxSteps += 1) {
      const bounded: RandomProgram = { ...base, maxSteps };
      const divergence = runOracle(bounded, PARITY_CONFIGS);
      if (divergence !== undefined) throw new Error(formatDivergence(divergence));
    }
  }, 120_000);

  it('matches when the budget is exhausted inside a provider dispatch', () => {
    for (const seed of [31, 47, 58]) {
      const base = randomProgram({ seed, profile: 'provider-heavy' });
      for (const maxSteps of [6, 12, 20]) {
        const divergence = runOracle({ ...base, maxSteps }, PARITY_CONFIGS);
        if (divergence !== undefined) throw new Error(formatDivergence(divergence));
      }
    }
  });

  it('reports the failing seed, profile and configuration', () => {
    const message = formatDivergence({
      seed: 99,
      profile: 'default',
      config: 'jit',
      path: 'invocations[1].steps',
      expected: 12,
      actual: 13,
    });
    expect(message).toContain('seed=99');
    expect(message).toContain('profile=default');
    expect(message).toContain('config=jit');
    expect(message).toContain('invocations[1].steps');
  });
});
