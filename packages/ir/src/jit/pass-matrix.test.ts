/**
 * J09 optimization pass matrix.
 *
 * Every row is one JIT configuration run against a small regression suite. As
 * J11–J14 add entries to `IRJITOptimization`, add the name to
 * `OPTIMIZATION_PASSES`; the matrix then automatically gains an
 * "only this pass disabled" row and the all-disabled row covers it too.
 */
import { describe, expect, it } from 'vitest';
import type { IRJITOptimization, IRJITTuning } from '../jit-runtime';
import { REFERENCE_CONFIG, formatDivergence, jitConfig, runOracle } from './testing/oracle';
import type { RandomProfile } from './testing/random-ir';
import { randomProgram } from './testing/random-ir';

/**
 * Canonical switch names. `satisfies` makes the list fail to typecheck as soon
 * as a new pass is added to `IRJITOptimization` without being listed here.
 */
export const OPTIMIZATION_PASSES = [
  'sccp',
  'gvn',
  'range',
  'licm',
  'unroll',
  'dce',
  'loadElim',
  'scalarPromotion',
  'boundsElim',
  'dispatchIC',
  'checkpointFast',
  'regions',
  'region-compile',
  'regionDirectCall',
  'inline',
] as const satisfies readonly IRJITOptimization[];

type MissingOptimization = Exclude<IRJITOptimization, (typeof OPTIMIZATION_PASSES)[number]>;

/**
 * Fails to typecheck when `IRJITOptimization` grows without a matching entry
 * above: `MissingOptimization` stops being `never`, so `true` no longer fits.
 */
export const OPTIMIZATION_PASSES_ARE_EXHAUSTIVE: MissingOptimization extends never ? true : false =
  true;

export interface PassMatrixRow {
  readonly name: string;
  readonly tuning: IRJITTuning;
}

function allDisabled(
  passes: readonly IRJITOptimization[],
): Partial<Record<IRJITOptimization, boolean>> {
  const disabled: Record<string, boolean> = {};
  for (const pass of passes as readonly string[]) disabled[pass] = false;
  return disabled as Partial<Record<IRJITOptimization, boolean>>;
}

export const PASS_MATRIX_ROWS: readonly PassMatrixRow[] = Object.freeze([
  // `tierUpThreshold: 0` compiles Tier-2 immediately; without it the inline
  // switch would never be observable because the first call is Tier-1.
  { name: 'default', tuning: { tier: 'compiled', tierUpThreshold: 0 } },
  {
    name: 'all-disabled',
    tuning: {
      tier: 'compiled',
      tierUpThreshold: 0,
      optimizations: allDisabled(OPTIMIZATION_PASSES),
    },
  },
  ...OPTIMIZATION_PASSES.map((pass) => ({
    name: `without-${pass}`,
    tuning: {
      tier: 'compiled' as const,
      tierUpThreshold: 0,
      optimizations: allDisabled([pass]),
    },
  })),
]);

const REGRESSION_SUITE: readonly { readonly seed: number; readonly profile?: RandomProfile }[] = [
  { seed: 201 },
  { seed: 202 },
  { seed: 203 },
  { seed: 204 },
  { seed: 205, profile: 'float-heavy' },
  { seed: 206, profile: 'float-heavy' },
  { seed: 207, profile: 'provider-heavy' },
  { seed: 208, profile: 'provider-heavy' },
  { seed: 209, profile: 'deep-recursion' },
  { seed: 210, profile: 'storage-heavy' },
];

function checkRow(row: PassMatrixRow): void {
  const config = jitConfig(row.name, row.tuning);
  for (const entry of REGRESSION_SUITE) {
    const program = randomProgram({
      seed: entry.seed,
      ...(entry.profile === undefined ? {} : { profile: entry.profile }),
    });
    const divergence = runOracle(program, [REFERENCE_CONFIG, config]);
    if (divergence !== undefined) {
      throw new Error(
        `pass matrix configuration "${row.name}" diverged on seed=${entry.seed} ` +
          `profile=${program.profile}\n${formatDivergence(divergence)}`,
      );
    }
  }
}

describe('JIT optimization pass matrix', () => {
  it('has one row for the default configuration and one for all passes disabled', () => {
    expect(PASS_MATRIX_ROWS[0]!.name).toBe('default');
    expect(PASS_MATRIX_ROWS[1]!.name).toBe('all-disabled');
  });

  it('covers every switch in IRJITOptimization exactly once', () => {
    expect(OPTIMIZATION_PASSES_ARE_EXHAUSTIVE).toBe(true);
    expect(new Set(OPTIMIZATION_PASSES).size).toBe(OPTIMIZATION_PASSES.length);
    for (const pass of OPTIMIZATION_PASSES) {
      expect(PASS_MATRIX_ROWS.filter((row) => row.name === `without-${pass}`)).toHaveLength(1);
    }
    expect(PASS_MATRIX_ROWS).toHaveLength(OPTIMIZATION_PASSES.length + 2);
  });

  it('uses unique row names', () => {
    const names = PASS_MATRIX_ROWS.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(PASS_MATRIX_ROWS.map((row) => [row.name, row] as const))(
    'configuration %s matches the reference on the regression suite',
    (_name, row) => {
      checkRow(row);
    },
    120_000,
  );

  it('reports the concrete configuration in failure messages', () => {
    const message =
      'pass matrix configuration "without-inline" diverged on seed=7 profile=default\n' +
      formatDivergence({
        seed: 7,
        profile: 'default',
        config: 'without-inline',
        path: 'invocations[0].values[0]',
        expected: 1,
        actual: 2,
      });
    expect(message).toContain('without-inline');
    expect(message).toContain('seed=7');
    expect(message).toContain('invocations[0].values[0]');
  });
});
