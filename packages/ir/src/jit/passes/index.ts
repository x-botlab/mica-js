/**
 * Memory optimization passes (J12) and their canonical pipeline.
 *
 * Pipeline order (issue #152): `loadElim → scalarPromotion → boundsElim`.
 * Each pass is independently switchable and correct on its own.
 */
import type { MFunction } from '../mir';
import type { LowerContext } from '../resolve';
import { verifyMIR } from '../verify';
import { runLoadElim } from './load-elim';
import { runScalarPromotion } from './scalar-promotion';
import { runBoundsElim } from './bounds-elim';
import type { BoundsElimResult } from './bounds-elim';
import type { MemoryPassContext } from './memory-model';
import { runOptimizationPipeline } from './pipeline';

export { runLoadElim } from './load-elim';
export { runScalarPromotion } from './scalar-promotion';
export { runBoundsElim } from './bounds-elim';
export type { BoundsElimResult } from './bounds-elim';
export type { MemoryPassContext } from './memory-model';

// J11 scalar pipeline (owned by sibling files; re-exported for one import path).
export {
  runOptimizationPipeline,
  OPTIMIZATION_PASS_NAMES,
  ALL_OPTIMIZATIONS,
  runSCCP,
  runGVN,
  runRange,
  runLICM,
  runDCE,
} from './pipeline';
export type { OptimizationPass, OptimizationSwitches, PipelineOptions } from './pipeline';
export { analyzeRanges } from './range';
export type { Interval } from './range';

/** The three J12 switches as they appear in `IRJITOptimization`. */
export const MEMORY_OPTIMIZATIONS = ['loadElim', 'scalarPromotion', 'boundsElim'] as const;

export type MemoryOptimization = (typeof MEMORY_OPTIMIZATIONS)[number];

export interface MemoryPassOptions {
  /** Per-pass switches; a missing key means enabled. */
  readonly enabled?: Readonly<Partial<Record<MemoryOptimization, boolean>>>;
  /**
   * Step-observer mode (J7): `beforeStep` may observe storage at every step, so
   * store forwarding and scalar promotion are disabled. Load-to-load
   * elimination stays active (it does not change storage).
   */
  readonly observer?: boolean;
}

export interface MemoryPassReport {
  readonly loadElim: number;
  readonly scalarPromotion: number;
  readonly boundsElim: BoundsElimResult;
}

function enabled(options: MemoryPassOptions, pass: MemoryOptimization): boolean {
  return options.enabled?.[pass] !== false;
}

/**
 * Run the J12 pipeline on one function. The function is mutated in place.
 */
export function runMemoryPasses(
  fn: MFunction,
  context: MemoryPassContext,
  options: MemoryPassOptions = {},
): MemoryPassReport {
  const loadElim = enabled(options, 'loadElim')
    ? runLoadElim(fn, context, { storeForwarding: options.observer !== true })
    : 0;
  const scalarPromotion =
    options.observer === true || !enabled(options, 'scalarPromotion')
      ? 0
      : runScalarPromotion(fn, context);
  const boundsElim = enabled(options, 'boundsElim')
    ? runBoundsElim(fn, context)
    : { eliminated: 0, versioned: 0 };
  return {
    loadElim,
    scalarPromotion,
    boundsElim,
  };
}

export interface JitOptimizationOptions {
  /** Every J11/J12 pass switch; missing keys default to enabled. */
  readonly passes?: Readonly<Partial<Record<string, boolean>>>;
  /** Run `verifyMIR` after each pass group. */
  readonly verify?: boolean;
  /** Step-observer mode: disables storage-changing memory optimizations. */
  readonly observer?: boolean;
  /** Live module constant table for J11 float folding (`LowerContext.constants`). */
  readonly constants?: unknown[];
}

/**
 * Canonical whole-function pipeline: J11 scalar passes first, then J12 memory
 * passes. J11's passes rebuild the value table, so they must run before any
 * promotion descriptor or `uncheckedBounds` marker exists.
 */
export function runJitOptimizationPipeline(
  fn: MFunction,
  context: MemoryPassContext,
  lower: LowerContext,
  options: JitOptimizationOptions = {},
): MFunction {
  const pipelineOptions: Parameters<typeof runOptimizationPipeline>[1] = {
    ...(options.passes === undefined
      ? {}
      : {
          passes: options.passes as NonNullable<
            NonNullable<Parameters<typeof runOptimizationPipeline>[1]>['passes']
          >,
        }),
    // The constant table is live: SCCP appends folded `U` values to it and
    // code generation reads the same array through `LowerContext.constants`.
    ...(options.constants === undefined ? {} : { constants: options.constants }),
    ...(options.verify === undefined ? {} : { verify: options.verify }),
  };
  const current = runOptimizationPipeline(fn, pipelineOptions);
  const memoryOptions: MemoryPassOptions = {
    ...(options.passes === undefined
      ? {}
      : { enabled: options.passes as Readonly<Partial<Record<MemoryOptimization, boolean>>> }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  };
  runMemoryPasses(current, context, memoryOptions);
  if (options.verify === true) verifyMIR(current, lower);
  return current;
}
