/**
 * The scalar optimization pipeline (J11).
 *
 * Order: `sccp → gvn → range → licm → dce`. Every pass is independently
 * switchable; disabling one never makes another incorrect, only less
 * profitable. When `verify` is set the MIR verifier runs after every pass.
 */
import { verifyMIR } from '../verify';
import type { MFunction } from '../mir';
import { optimizeFunction as dce } from './dce';
import { optimizeFunction as gvn } from './gvn';
import { optimizeFunction as licm } from './licm';
import { optimizeFunction as range } from './range';
import { optimizeFunction as sccp } from './sccp';
import type { OptimizeOptions } from './util';

/** Canonical pipeline order and the `IRJITOptimization` literal union. */
export const OPTIMIZATION_PASS_NAMES = ['sccp', 'gvn', 'range', 'licm', 'dce'] as const;

export type OptimizationPass = (typeof OPTIMIZATION_PASS_NAMES)[number];

/** Per-pass switches; a missing entry means "enabled". */
export type OptimizationSwitches = Readonly<Partial<Record<OptimizationPass, boolean>>>;

export interface PipelineOptions extends OptimizeOptions {
  readonly passes?: OptimizationSwitches;
  /** Run `verifyMIR` after every pass (production debug switch). */
  readonly verify?: boolean;
}

const RUNNERS: Readonly<
  Record<OptimizationPass, (fn: MFunction, options: OptimizeOptions) => MFunction>
> = {
  sccp,
  gvn,
  range,
  licm,
  dce,
};

/** All passes enabled; used as the default tuning. */
export const ALL_OPTIMIZATIONS: Readonly<Record<OptimizationPass, true>> = Object.freeze({
  sccp: true,
  gvn: true,
  range: true,
  licm: true,
  dce: true,
});

function enabled(switches: OptimizationSwitches | undefined, pass: OptimizationPass): boolean {
  return switches?.[pass] !== false;
}

/**
 * Run the enabled passes in canonical order. The input function is never
 * mutated; a disabled pipeline returns it unchanged.
 */
export function runOptimizationPipeline(fn: MFunction, options: PipelineOptions = {}): MFunction {
  let current = fn;
  for (const pass of OPTIMIZATION_PASS_NAMES) {
    if (!enabled(options.passes, pass)) continue;
    current = RUNNERS[pass](current, options);
    if (options.verify === true) verifyMIR(current);
  }
  return current;
}

/** Convenience re-exports so tests and `passes/index.ts` can name each pass. */
export const runSCCP = sccp;
export const runGVN = gvn;
export const runRange = range;
export const runLICM = licm;
export const runDCE = dce;
