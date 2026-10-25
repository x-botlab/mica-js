/**
 * `compileFunction`: MIR → JavaScript source → host function (J6).
 *
 * Source generation happens once per function and environment; construction
 * uses `new Function` only. A blocked environment (CSP, `unsafe-eval`
 * restrictions) surfaces as {@link JitCodegenUnavailable}, which the execution
 * engine (J7) treats as "fall back to the reference interpreter".
 */
import { analyzeCFG } from '../cfg';
import type {
  ArtifactState,
  DispatchKey,
  ProviderDispatchInfo,
  RegionHandle,
} from '../dispatch-ic';
import type { FunctionSummary } from '../effects';
import type { LayoutProfile, MFunction } from '../mir';
import { analyzeRepresentation } from '../repr';
import type { CompiledFn, JitFrame, JitHelpers, JitRuntime } from '../runtime-core';
import { createRegionExitProfile, createRegionRuntime, regionKeyOf } from '../region';
import type { RegionDirectCallDep, RegionExitProfile, RegionRuntimeState } from '../region';
import { emitFunction, emitRegion } from './emit';
import type { EmitEnv, EmittedFunction, EmittedRegion, ResolvedRegionDirectCall } from './emit';
import type { CheckpointGranularity, MemoryDefinition, ScalarType } from '../../types';

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
  /** Model memory definitions (region element promotion, J14). */
  readonly memories?: readonly MemoryDefinition[];
  /**
   * How often the compiled code must reproduce reference state. `'per-tick'`
   * (the default) lets a region batch the step counter and hoist the control
   * flags; `'per-instruction'` keeps every MIR block observable.
   */
  readonly checkpointGranularity?: CheckpointGranularity;
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

/**
 * A step budget at or above this bound is unreachable in practice: `rt.steps`
 * counts executed instructions, and no run can execute `Number.MAX_SAFE_INTEGER`
 * of them (the counter itself loses integer precision there). Compiling such a
 * runtime without the exact per-item budget copy removes half the generated
 * code.
 */
const UNBOUNDED_STEPS = Number.MAX_SAFE_INTEGER;

/** Whether generated code must be able to stop at an exact step. */
function needsExactSteps(rt: JitRuntime): boolean {
  // Step observers and host budgets poll every step (`limit` stays at -1).
  if (rt.mode !== 'none') return true;
  return rt.maxSteps < UNBOUNDED_STEPS;
}

/**
 * Emitted-source budget of one region function.
 *
 * The host engine only optimizes functions below a bytecode limit (V8 stops at
 * 60 KiB of bytecode); an interpreted region is several times slower than an
 * optimized one, so crossing that line costs far more than the dispatch it
 * saves. Measured on the M3 workload the emitted text is about 1.7× the
 * bytecode size, and the direct-call guards of J15 add ~20% to it, so 80 KiB of
 * source keeps a region near 47 KiB of bytecode — enough headroom that later
 * growth does not silently push the function out of the optimizing tiers.
 * Members are dropped (coldest first) until the region fits.
 */
const REGION_SOURCE_BUDGET = 120_000;

function emit(mfn: MFunction, env: CompileEnv): EmittedFunction {
  const cached = sourceCache.get(mfn);
  if (cached !== undefined && cached.env === env) return cached.emitted;
  const emitEnv: EmitEnv = {
    constants: env.constants,
    littleEndian: env.littleEndian,
    memoryRefs: env.memoryRefs,
    exactSteps: needsExactSteps(env.rt),
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
export interface CompiledRegion extends RegionHandle {
  /** `(memberIndex, ...arguments)`; arguments use MIR representations. */
  readonly fn: CompiledFn;
  readonly source: string;
  readonly members: readonly ArtifactState[];
  readonly frames: readonly JitFrame[];
  /** Runtime epoch/key/profile table referenced by the generated code. */
  readonly runtime: RegionRuntimeState;
  /** Callee regions of the direct calls emitted into this compilation (J15). */
  readonly directCallDeps: readonly RegionDirectCallDep[];
}

/** One hot exit target the caller wants emitted as a direct region call (J15). */
export interface RegionDirectCallTarget {
  /** Provider index of the exit site that may transfer to the target. */
  readonly providerIndex: number;
  /** Target artifact; supplies the guard key and the callee region. */
  readonly state: ArtifactState;
  /** Storage epoch literal for the guard. */
  readonly epoch: number;
  /** Provider cache epoch literal for the guard. */
  readonly cacheEpoch: number;
}

/** Optional inputs of one region compilation. */
export interface RegionCompileOptions {
  /** Exit-target profile shared with generated code (J15). */
  readonly profile?: RegionExitProfile;
  /** Hot exit targets to guard and call directly (J15). */
  readonly directCalls?: readonly RegionDirectCallTarget[];
  /**
   * Continue cache-hit exits inside the target's region (J15). Enabled by the
   * `regionDirectCall` optimization switch.
   */
  readonly inlineTail?: boolean;
}

/**
 * Resolve the requested direct calls against the compiled member set: a target
 * is only usable when it belongs to a *different* compiled region. The result
 * carries literal guard values and the callee's function/entry index.
 */
function resolveDirectCalls(
  members: readonly RegionCompileMember[],
  providers: CompileEnv['providers'],
  requested: readonly RegionDirectCallTarget[] | undefined,
): { readonly calls: readonly ResolvedRegionDirectCall[]; readonly deps: RegionDirectCallDep[] } {
  if (requested === undefined || requested.length === 0) return { calls: [], deps: [] };
  const own = new Set(members.map((member) => member.state));
  const calls: ResolvedRegionDirectCall[] = [];
  const deps: RegionDirectCallDep[] = [];
  const seen = new Set<string>();
  for (const target of requested) {
    const state = target.state;
    if (own.has(state)) continue;
    const region = state.region;
    if (region === undefined || state.regionIndex < 0) continue;
    if (state.providerIndex !== target.providerIndex) continue;
    const info = providers?.[target.providerIndex];
    if (info === undefined || info.keyTypes.length !== state.key.length) continue;
    const signature = `${target.providerIndex}\u0000${state.key.join('\u0000')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    calls.push({
      providerIndex: target.providerIndex,
      keyTypes: info.keyTypes,
      key: state.key,
      epoch: target.epoch,
      cacheEpoch: target.cacheEpoch,
      fn: region.fn,
      entry: state.regionIndex,
    });
    const depSignature = `${region.key}\u0000${target.epoch}`;
    if (!deps.some((dep) => `${dep.key}\u0000${dep.epoch}` === depSignature)) {
      deps.push({ key: region.key, epoch: target.epoch });
    }
  }
  return { calls, deps };
}

/**
 * Compile a hot dispatch chain into one JavaScript function. The region shares
 * the normal emitter (instruction templates, step batching, control-flow
 * structuring) and only adds the member selector and the in-region dispatch
 * edges.
 *
 * When `options.directCalls` is present, the hottest exits of the region are
 * emitted as guarded calls into the region that owns the exit target (J15).
 */
export function compileRegionWithSource(
  members: readonly RegionCompileMember[],
  env: CompileEnv,
  options: RegionCompileOptions = {},
): CompiledRegion {
  if (members.length === 0) throw new Error('JIT region compilation needs at least one member');
  const profile = options.profile ?? createRegionExitProfile();
  const key = regionKeyOf(
    members[0]!.providerIndex,
    members.map((member) => member.state),
  );
  const build = (
    count: number,
  ): {
    readonly emitted: EmittedRegion;
    readonly members: readonly RegionCompileMember[];
    readonly runtime: RegionRuntimeState;
    readonly deps: readonly RegionDirectCallDep[];
  } => {
    const chosen = members.slice(0, count);
    const { calls, deps } = resolveDirectCalls(chosen, env.providers, options.directCalls);
    const runtime = createRegionRuntime(chosen, { key, profile });
    const emitted = emitRegion(
      chosen.map((member) => ({
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
        ...(env.memories === undefined ? {} : { memories: env.memories }),
        ...(env.checkpointGranularity === undefined
          ? {}
          : { checkpointGranularity: env.checkpointGranularity }),
        exactSteps: needsExactSteps(env.rt),
        ...(env.summaries === undefined ? {} : { summaries: env.summaries }),
        ...(env.providers === undefined ? {} : { providers: env.providers }),
        ...(env.dispatchIC === undefined ? {} : { dispatchIC: env.dispatchIC }),
        ...(env.checkpointFast === undefined ? {} : { checkpointFast: env.checkpointFast }),
        ...(env.forceSwitch === undefined ? {} : { forceSwitch: env.forceSwitch }),
      },
      runtime,
      calls,
      options.inlineTail === true,
    );
    return { emitted, members: chosen, runtime, deps };
  };
  // A region is one JavaScript function, and the host engine only optimizes
  // functions below a bytecode budget (V8 stops at 60 KiB). Keep the emitted
  // source well under the equivalent size, dropping trailing members until the
  // region fits.
  let built = build(members.length);
  while (built.members.length > 1 && built.emitted.source.length > REGION_SOURCE_BUDGET) {
    const ratio = REGION_SOURCE_BUDGET / built.emitted.source.length;
    const next = Math.max(
      1,
      Math.min(built.members.length - 1, Math.floor(built.members.length * ratio)),
    );
    built = build(next);
  }
  const emitted = built.emitted;
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
    key,
    fn: factory(env.rt, emitted.constants, env.helpers),
    source: emitted.source,
    members: built.members.map((member) => member.state),
    frames: emitted.frames,
    runtime: built.runtime,
    directCallDeps: built.deps,
  };
}
