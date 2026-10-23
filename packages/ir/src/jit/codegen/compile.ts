/**
 * `compileFunction`: MIR → JavaScript source → host function (J6).
 *
 * Source generation happens once per function and environment; construction
 * uses `new Function` only. A blocked environment (CSP, `unsafe-eval`
 * restrictions) surfaces as {@link JitCodegenUnavailable}, which the execution
 * engine (J7) treats as "fall back to the reference interpreter".
 */
import { analyzeCFG } from '../cfg';
import type { FunctionSummary } from '../effects';
import type { MFunction } from '../mir';
import { analyzeRepresentation } from '../repr';
import type { CompiledFn, JitFrame, JitHelpers, JitRuntime } from '../runtime-core';
import { emitFunction } from './emit';
import type { EmitEnv, EmittedFunction } from './emit';

/** Raised when the host forbids dynamic code generation. */
export class JitCodegenUnavailable extends Error {
  override readonly name = 'JitCodegenUnavailable';
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Everything generated code needs from the surrounding engine. */
export interface CompileEnv {
  readonly rt: JitRuntime;
  readonly helpers: JitHelpers;
  /** Module-wide constant table (`LowerContext.constants`). */
  readonly constants: readonly unknown[];
  /** Model memory references, indexed by resolved memory indices. */
  readonly memoryRefs: readonly unknown[];
  /** Host endianness; selects the typed-view or DataView fast path. */
  readonly littleEndian: boolean;
  readonly summaries?: ReadonlyMap<number, FunctionSummary>;
  /** Dependency set when compiling a provider artifact. */
  readonly artifactDependencies?: readonly unknown[];
  /** Debug: force the `switch (pc)` form. */
  readonly forceSwitch?: boolean;
}

/** A compiled function plus everything needed to debug or unwind it. */
export interface CompiledFunction {
  readonly fn: CompiledFn;
  readonly source: string;
  readonly frame: JitFrame;
  readonly structured: boolean;
  /** Why the structurizer fell back to `switch (pc)`, when it did. */
  readonly fallback: string | undefined;
  readonly constants: readonly unknown[];
}

interface CacheEntry {
  readonly env: CompileEnv;
  readonly emitted: EmittedFunction;
}

const sourceCache = new WeakMap<MFunction, CacheEntry>();

function emit(mfn: MFunction, env: CompileEnv): EmittedFunction {
  const cached = sourceCache.get(mfn);
  if (cached !== undefined && cached.env === env) return cached.emitted;
  const emitEnv: EmitEnv = {
    constants: env.constants,
    littleEndian: env.littleEndian,
    memoryRefs: env.memoryRefs,
    ...(env.summaries === undefined ? {} : { summaries: env.summaries }),
    ...(env.artifactDependencies === undefined
      ? {}
      : { artifactDependencies: env.artifactDependencies }),
    ...(env.forceSwitch === undefined ? {} : { forceSwitch: env.forceSwitch }),
  };
  const emitted = emitFunction(mfn, emitEnv);
  sourceCache.set(mfn, { env, emitted });
  return emitted;
}

/**
 * Compile one function. Lowering, CFG analysis and representation analysis are
 * idempotent, so calling this again for the same `MFunction` reuses the source.
 */
export function compileFunctionWithSource(mfn: MFunction, env: CompileEnv): CompiledFunction {
  analyzeCFG(mfn);
  analyzeRepresentation(mfn, env.summaries);
  const emitted = emit(mfn, env);
  let factory: (rt: JitRuntime, k: readonly unknown[], helpers: JitHelpers) => CompiledFn;
  try {
    factory = new Function('rt', 'k', 'H', emitted.source) as (
      rt: JitRuntime,
      k: readonly unknown[],
      helpers: JitHelpers,
    ) => CompiledFn;
  } catch (cause) {
    throw new JitCodegenUnavailable(
      'JIT code generation is unavailable: the host refused to construct a function',
      cause,
    );
  }
  const fn = factory(env.rt, emitted.constants, env.helpers);
  return {
    fn,
    source: emitted.source,
    frame: emitted.frame,
    structured: emitted.structured,
    fallback: emitted.fallback,
    constants: emitted.constants,
  };
}

/** Compile one function and return only the callable. */
export function compileFunction(mfn: MFunction, env: CompileEnv): CompiledFn {
  return compileFunctionWithSource(mfn, env).fn;
}
