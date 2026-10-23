/**
 * `compileFunction`: MIR → JavaScript source → host function (J6).
 *
 * Source generation happens once per function and environment; construction
 * uses `new Function` only. A blocked environment (CSP, `unsafe-eval`
 * restrictions) surfaces as {@link JitCodegenUnavailable}, which the execution
 * engine (J7) treats as "fall back to the reference interpreter".
 */
import { analyzeCFG } from '../cfg';
import type { ArtifactState, DispatchKey, ProviderDispatchInfo } from '../dispatch-ic';
import type { FunctionSummary } from '../effects';
import type { LayoutProfile, MFunction } from '../mir';
import { analyzeRepresentation } from '../repr';
import type { CompiledFn, JitFrame, JitHelpers, JitRuntime } from '../runtime-core';
import { createRegionRuntime } from '../region';
import { emitFunction, emitRegion } from './emit';
import type { EmitEnv, EmittedFunction } from './emit';
import type { ScalarType } from '../../types';

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
  /** Artifact state of the function being compiled (J14 checkpoint fast path). */
  readonly artifactState?: ArtifactState;
  /** Provider metadata for dispatch ICs and region keys (J14). */
  readonly providers?: readonly ProviderDispatchInfo[];
  /** Dispatch inline caches and jump cache; default on. */
  readonly dispatchIC?: boolean;
  /** Checkpoint epoch guard; default on. */
  readonly checkpointFast?: boolean;
  /**
   * Tier-2 block weights (J13): generated branches and `switch` cases put the
   * hottest block first. Omitted for tier-1 and regions.
   */
  readonly layout?: LayoutProfile;
  /**
   * Emit the tier-1 prologue counter that promotes to tier 2 (J13). The
   * generated code reads `rt.counters[i]`, `rt.tierUpThreshold` and calls
   * `rt.tierUp(i)` exactly when the counter reaches the threshold.
   */
  readonly tierUp?: boolean;
  /**
   * Fully resolved optimizer switches (J11/J12). Present only when the caller
   * wants the MIR optimization pipeline to run for this compilation.
   */
  readonly optimizations?: Readonly<Record<string, boolean>>;
  /** Debug: run `verifyMIR` after every optimization pass. */
  readonly verify?: boolean;
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
    ...(env.artifactState === undefined ? {} : { artifactState: env.artifactState }),
    ...(env.providers === undefined ? {} : { providers: env.providers }),
    ...(env.dispatchIC === undefined ? {} : { dispatchIC: env.dispatchIC }),
    ...(env.checkpointFast === undefined ? {} : { checkpointFast: env.checkpointFast }),
    ...(env.layout === undefined ? {} : { layout: env.layout }),
    ...(env.tierUp === undefined ? {} : { tierUp: env.tierUp }),
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

/* -------------------------------------------------------------------------
 * Region compilation (J14)
 * ---------------------------------------------------------------------- */

/** One artifact offered to the region compiler. */
export interface RegionCompileMember {
  readonly state: ArtifactState;
  readonly mir: MFunction;
  readonly key: readonly DispatchKey[];
  readonly keyTypes: readonly ScalarType[];
  readonly providerIndex: number;
  readonly params: readonly ScalarType[];
}

/** A compiled region callable plus its members and per-member frames. */
export interface CompiledRegion {
  /** `(memberIndex, ...arguments)`; arguments use MIR representations. */
  readonly fn: CompiledFn;
  readonly source: string;
  readonly members: readonly ArtifactState[];
  readonly frames: readonly JitFrame[];
}

/**
 * Compile a hot dispatch chain into one JavaScript function. The region shares
 * the normal emitter (instruction templates, step batching, control-flow
 * structuring) and only adds the member selector and the in-region dispatch
 * edges.
 */
export function compileRegionWithSource(
  members: readonly RegionCompileMember[],
  env: CompileEnv,
): CompiledRegion {
  if (members.length === 0) throw new Error('JIT region compilation needs at least one member');
  const runtime = createRegionRuntime(members);
  const emitted = emitRegion(
    members.map((member) => ({
      state: member.state,
      mir: member.mir,
      key: member.key,
      keyTypes: member.keyTypes,
      params: member.params,
      providerIndex: member.providerIndex,
    })),
    {
      constants: env.constants,
      littleEndian: env.littleEndian,
      memoryRefs: env.memoryRefs,
      ...(env.summaries === undefined ? {} : { summaries: env.summaries }),
      ...(env.providers === undefined ? {} : { providers: env.providers }),
      ...(env.dispatchIC === undefined ? {} : { dispatchIC: env.dispatchIC }),
      ...(env.checkpointFast === undefined ? {} : { checkpointFast: env.checkpointFast }),
      ...(env.forceSwitch === undefined ? {} : { forceSwitch: env.forceSwitch }),
    },
    runtime,
  );
  let factory: (rt: JitRuntime, k: readonly unknown[], helpers: JitHelpers) => CompiledFn;
  try {
    factory = new Function('rt', 'k', 'H', emitted.source) as (
      rt: JitRuntime,
      k: readonly unknown[],
      helpers: JitHelpers,
    ) => CompiledFn;
  } catch (cause) {
    throw new JitCodegenUnavailable(
      'JIT code generation is unavailable: the host refused to construct a region function',
      cause,
    );
  }
  return {
    fn: factory(env.rt, emitted.constants, env.helpers),
    source: emitted.source,
    members: members.map((member) => member.state),
    frames: emitted.frames,
  };
}
