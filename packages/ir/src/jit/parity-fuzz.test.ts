/**
 * J09 parity fuzzing: seeded random IR programs executed by the reference
 * interpreter and by every JIT configuration. A failure message always names
 * the seed, profile and configuration so the program can be reproduced.
 *
 * ## What is compared (checkpoint contract, J16)
 *
 * The JIT is compared with the reference at *checkpoints*, never per host
 * dispatch:
 *
 * - a bounded step budget makes every step a checkpoint, so truncating at any
 *   budget must produce exactly the reference prefix (see "matches at every
 *   step boundary");
 * - otherwise the end of an `execute` call — one tick — is the checkpoint.
 *
 * Intermediate dispatches are deliberately not part of the contract: a region
 * fuses several artifacts into a single host call, so the JIT performs fewer
 * dispatches than the reference performs artifact entries, and may keep
 * promoted storage, the step counter and the control flags in locals across
 * those vanished boundaries (see `CheckpointGranularity`). Everything a caller
 * can observe at a checkpoint — storage, epochs, provider cache contents, the
 * step count and every error field — must still match exactly, which is what
 * {@link runOracle} diffs.
 */
import { describe, expect, it } from 'vitest';
import {
  PARITY_CONFIGS,
  formatDivergence,
  jitConfig,
  runOracle,
  runProgram,
} from './testing/oracle';
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

  it('matches at tick boundaries under every checkpoint granularity', () => {
    // Same program, three contracts: the strictest one keeps every MIR block
    // observable, the other two fuse across them. All three must agree with
    // the reference at the end of every tick.
    const configs = [
      PARITY_CONFIGS[0]!,
      jitConfig('jit-per-instruction', {
        tier: 'compiled',
        tierUpThreshold: 0,
        checkpointGranularity: 'per-instruction',
      }),
      jitConfig('jit-per-tick', { tier: 'compiled', tierUpThreshold: 0 }),
      jitConfig('jit-per-safepoint', {
        tier: 'compiled',
        tierUpThreshold: 0,
        checkpointGranularity: 'per-safepoint',
      }),
    ];
    for (const seed of [2, 13, 29, 61]) {
      for (const profile of PROFILES) {
        const divergence = runOracle(randomProgram({ seed, profile }), configs);
        if (divergence !== undefined) throw new Error(formatDivergence(divergence));
      }
    }
  }, 120_000);

  it('matches at the tick boundary when the step budget is unreachable', () => {
    // An unbounded budget turns every per-item budget check into dead code, so
    // a region batches the step counter and flushes it only at exits. The
    // reference still sees the exact step count at the tick boundary.
    for (const seed of [7, 18, 44]) {
      const program: RandomProgram = {
        ...randomProgram({ seed }),
        maxSteps: Number.MAX_SAFE_INTEGER,
      };
      const divergence = runOracle(program, PARITY_CONFIGS);
      if (divergence !== undefined) throw new Error(formatDivergence(divergence));
    }
  }, 120_000);

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
