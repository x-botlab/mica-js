/**
 * `createIRJIT`: the compiled execution engine (J7).
 *
 * The engine shares the reference interpreter's creation contract: it calls
 * {@link prepareEngine}, exposes the captured `storage` and implements the same
 * `execute(target, args, context)` method. Model functions and provider
 * artifacts are lowered to MIR but compiled lazily on first use, so creating an
 * engine never depends on `new Function`.
 *
 * Execution drives one compiled function and keeps consuming `TAIL` transfers
 * until a real value comes back. Provider dispatch and invalidated checkpoint
 * recovery therefore never grow the JavaScript stack. Errors unwind through the
 * compiled frames (`JitUnwind`) and are translated into the same
 * `IRExecutionError` (code, message, location, call stack, steps) the reference
 * interpreter produces.
 *
 * When code generation is unavailable (CSP, disabled `unsafe-eval`) the factory
 * transparently returns the reference interpreter over the very same engine
 * setup, so callers get identical results and storage. If a lazy compilation
 * fails after creation, later executions use the same fallback.
 */
import { IRProviderError } from './errors';
import { makeLocation, prepareExecution, sameResultTypes, wrapExecutionError } from './engine-host';
import { prepareEngine } from './engine-setup';
import type { EngineSetup, Target } from './engine-setup';
import { IRExecutionError, createIRInterpreterFromSetup } from './interpreter';
import type {
  IRExecutionContext,
  IRExecutionResult,
  IRInterpreter,
  IRInterpreterOptions,
} from './interpreter';
import type { IRResourceDependency, StorageControl } from './storage';
import type { FunctionDefinition, IRModule, RuntimeScalar, ScalarType } from './types';
import type { ProviderArtifact } from './provider';
import {
  compileFunctionWithSource,
  compileRegionWithSource,
  JitCodegenUnavailable,
} from './jit/codegen/compile';
import type { CompileEnv, CompiledFunction, CompiledRegion } from './jit/codegen/compile';
import { DispatchRegistry, REGION_THRESHOLD, providerDispatchInfo } from './jit/dispatch-ic';
import type { ArtifactState, ProviderDispatchInfo } from './jit/dispatch-ic';
import { computeSummaries } from './jit/effects';
import { attachRegion, collectRegionMembers } from './jit/region';
import { runHeapFunction } from './jit/heap-tier';
import type { HeapEntry, HeapRunOptions } from './jit/heap-tier';
import { Op, lowerFunction } from './jit/mir';
import type { LayoutProfile, MFunction } from './jit/mir';
import { createInlineContext, inlineFunction } from './jit/passes/inline';
import type { InlineContext } from './jit/passes/inline';
import { runJitOptimizationPipeline } from './jit/passes';
import { createLowerContext } from './jit/resolve';
import type { LowerContext } from './jit/resolve';
import {
  JitRuntime,
  JitUnwind,
  TAIL,
  createJitHelpers,
  fromJitResult,
  storageInternalsOf,
  toJitArgument,
} from './jit/runtime-core';
import type { CompiledFn, JitHelpers } from './jit/runtime-core';
import { verifyMIR } from './jit/verify';

/** Optimization switches (J11–J14). */
export type IRJITOptimization =
  | 'sccp'
  | 'gvn'
  | 'range'
  | 'licm'
  | 'dce'
  | 'loadElim'
  | 'scalarPromotion'
  | 'boundsElim'
  | 'dispatchIC'
  | 'checkpointFast'
  | 'regions'
  | 'region-compile'
  | 'inline';

/** JIT execution tier. */
export type IRJITTier = 'auto' | 'heap' | 'compiled';

/** Compile-time policy for hosts that forbid dynamic code generation. */
export type IRJITCodegen = 'auto' | 'require';

/** When functions are compiled relative to engine creation. */
export type IRJITWarmup = 'lazy' | 'eager';

export interface IRJITTuning {
  /**
   * `'auto'` compiles and falls back when needed, `'heap'` always uses the
   * reference interpreter, `'compiled'` always compiles. Default `'auto'`.
   */
  readonly tier?: IRJITTier;
  /**
   * `'auto'` silently falls back when `new Function` is unavailable;
   * `'require'` reports `invalid-options` at creation. Default `'auto'`.
   */
  readonly codegen?: IRJITCodegen;
  /**
   * `'lazy'` compiles a model function the first time it is called (default);
   * `'eager'` compiles every model function during creation. Provider artifacts
   * are always compiled on their first materialization.
   */
  readonly warmup?: IRJITWarmup;
  /**
   * Number of heap-tier runs before an artifact is compiled. The first
   * `artifactWarmup` dispatches run through the iterative heap tier, then the
   * artifact is compiled (tier-1, or tier-2 when `tierUpThreshold` is 0).
   * Non-negative safe integer, default 1.
   */
  readonly artifactWarmup?: number;
  /**
   * Maximum nesting depth of compiled frames before the engine re-enters the
   * function with a fresh compiled segment. Positive safe integer, default 1000.
   */
  readonly maxCompiledDepth?: number;
  /**
   * Tier-1 entries before a function is recompiled at Tier 2 (J13). `0`
   * compiles on first use; `Infinity` disables tiering. Default 1000.
   */
  readonly tierUpThreshold?: number;
  /** Optimization switches; unknown keys are rejected by `invalid-options`. */
  readonly optimizations?: Readonly<Partial<Record<IRJITOptimization, boolean>>>;
  /** Debug aids; `verify` runs the MIR verifier after lowering. Default off. */
  readonly debug?: { readonly verify?: boolean };
}

export interface IRJITOptions extends IRInterpreterOptions {
  readonly jit?: IRJITTuning;
}

/**
 * Internal diagnostics for tests and debugging. This symbol is deliberately not
 * re-exported from the package entry point.
 */
export const jitInternals: unique symbol = Symbol('mica.ir.jit.internals');

export interface IRJITInternals {
  /** `'reference'` while code generation is unavailable. */
  readonly mode: 'reference' | 'jit';
  readonly tier: IRJITTier;
  readonly warmup: IRJITWarmup;
  /** Successful compilations of model functions, including eager warmup. */
  readonly compiledFunctions: number;
  /** Successful compilations of provider artifacts, including recompiles. */
  readonly compiledArtifacts: number;
  /** Artifacts recompiled because a deep dependency changed. */
  readonly recompiledArtifacts: number;
  /** Dispatch site IC hits (J14). */
  readonly icHits: number;
  /** Dispatch site IC misses that reached `materialize`. */
  readonly icMisses: number;
  /** Provider jump-cache hits. */
  readonly jumpHits: number;
  /** Regions compiled from hot dispatch chains. */
  readonly regions: number;
  /** Tier-2 recompilations (model functions and artifacts, J13). */
  readonly tier2Compilations: number;
  /** Source of the most recently compiled region (debug aid for tests). */
  readonly regionSource: string | undefined;
  /** Dispatch site snapshots (debug aid for tests). */
  readonly dispatchSites: readonly {
    readonly states: readonly unknown[];
    readonly keys: readonly unknown[];
    readonly es: readonly number[];
    readonly cs: readonly number[];
    readonly count: number;
    readonly next: number;
    readonly hits: number;
    readonly misses: number;
  }[];
}

interface ResolvedTuning {
  readonly tier: IRJITTier;
  readonly codegen: IRJITCodegen;
  readonly warmup: IRJITWarmup;
  readonly artifactWarmup: number;
  readonly maxCompiledDepth: number;
  readonly tierUpThreshold: number;
  readonly verify: boolean;
  /** Fully resolved per-pass switches (missing user entries default to true). */
  readonly optimizations: Readonly<Record<IRJITOptimization, boolean>>;
  readonly dispatchIC: boolean;
  readonly checkpointFast: boolean;
  readonly regions: boolean;
  readonly inline: boolean;
}

interface ArtifactEntry extends ArtifactState {
  readonly mir: MFunction;
  /** Provider indices this artifact may dispatch/checkpoint to. */
  readonly providers: readonly number[];
  compiled: CompiledFunction;
  /** Tier-1 and Tier-2 compilation results; both stay available after tiering. */
  tier1: CompiledFunction | undefined;
  tier2: CompiledFunction | undefined;
  /** Heap-tier warmup wrapper (J13), when `artifactWarmup > 0`. */
  warmup: CompiledFn | undefined;
  /** Number of heap-tier runs completed before compilation. */
  uses: number;
  /** A failed warmup compile keeps the artifact on the heap tier. */
  heapOnly: boolean;
  dependencies: readonly IRResourceDependency[];
  storageEpoch: number;
  providerEpoch: number;
  validatedEpoch: number;
  entries: number;
  region: CompiledRegion | undefined;
  regionIndex: number;
}

type PreparedExecution = ReturnType<typeof prepareExecution>;

interface SavedRuntime {
  readonly steps: number;
  readonly committed: number;
  readonly limit: number;
  readonly context: IRExecutionContext;
  readonly tailFn: CompiledFn | undefined;
  readonly tailArgs: unknown[] | undefined;
  readonly tailState: ArtifactState | undefined;
  readonly currentState: ArtifactState | undefined;
  readonly depth: number;
  readonly ret: unknown[] | undefined;
}

const PLACEHOLDER_CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'jit',
  virtualTime: 0,
});

const JIT_OPTION_KEYS: ReadonlySet<string> = new Set([
  'tier',
  'codegen',
  'warmup',
  'artifactWarmup',
  'maxCompiledDepth',
  'tierUpThreshold',
  'optimizations',
  'debug',
]);

const DEBUG_KEYS: ReadonlySet<string> = new Set(['verify']);

/** Default switch state: every pass enabled. */
const OPTIMIZATION_DEFAULTS: Readonly<Record<IRJITOptimization, boolean>> = Object.freeze({
  sccp: true,
  gvn: true,
  range: true,
  licm: true,
  dce: true,
  loadElim: true,
  scalarPromotion: true,
  boundsElim: true,
  dispatchIC: true,
  checkpointFast: true,
  regions: true,
  'region-compile': true,
  inline: true,
});

/** Optimization names accepted by `jit.optimizations`. */
const OPTIMIZATION_NAMES: ReadonlySet<string> = new Set(
  Object.keys(OPTIMIZATION_DEFAULTS) as IRJITOptimization[],
);

/**
 * Create a compiled IR engine. The returned interpreter implements exactly the
 * reference `IRInterpreter` contract and owns one instance storage.
 */
export function createIRJIT(module: IRModule, options: IRJITOptions): IRInterpreter {
  // 1. Every creation-time error shared with the reference engine comes first.
  const setup = prepareEngine(module, options);
  // 2. Resolve JIT tuning once; invalid values are option errors.
  const tuning = resolveTuning(options.jit);
  // 3. `heap` never needs code generation.
  if (tuning.tier === 'heap') return createIRInterpreterFromSetup(setup);
  const probe = probeCodegen();
  if (!probe.ok) {
    if (tuning.codegen === 'require') throw unavailable(probe.cause);
    return createIRInterpreterFromSetup(setup);
  }
  try {
    return new JITInterpreter(setup, tuning);
  } catch (cause) {
    if (!(cause instanceof JitCodegenUnavailable)) throw cause;
    if (tuning.codegen === 'require') throw unavailable(cause);
    return createIRInterpreterFromSetup(setup);
  }
}

function unavailable(cause: unknown): IRExecutionError {
  return new IRExecutionError(
    'invalid-options',
    'JIT code generation is unavailable in this environment',
    { cause },
  );
}

/** Probe the host's dynamic-code policy without keeping the constructor around. */
function probeCodegen(): { readonly ok: true } | { readonly ok: false; readonly cause: unknown } {
  try {
    new Function('return 1')();
    return { ok: true };
  } catch (cause) {
    return { ok: false, cause };
  }
}

function resolveTuning(value: unknown): ResolvedTuning {
  if (value === undefined) {
    return {
      tier: 'auto',
      codegen: 'auto',
      warmup: 'lazy',
      artifactWarmup: 1,
      maxCompiledDepth: 1000,
      tierUpThreshold: 1000,
      verify: false,
      optimizations: OPTIMIZATION_DEFAULTS,
      dispatchIC: true,
      checkpointFast: true,
      regions: true,
      inline: true,
    };
  }
  if (!isRecord(value)) throw optionsError('jit must be an object');
  for (const key of Object.keys(value)) {
    if (!JIT_OPTION_KEYS.has(key)) throw optionsError(`Unknown JIT option "${key}"`);
  }
  const tier = value.tier;
  if (tier !== undefined && tier !== 'auto' && tier !== 'heap' && tier !== 'compiled') {
    throw optionsError('jit.tier must be "auto", "heap", or "compiled"');
  }
  const codegen = value.codegen;
  if (codegen !== undefined && codegen !== 'auto' && codegen !== 'require') {
    throw optionsError('jit.codegen must be "auto" or "require"');
  }
  const warmup = value.warmup;
  if (warmup !== undefined && warmup !== 'lazy' && warmup !== 'eager') {
    throw optionsError('jit.warmup must be "lazy" or "eager"');
  }
  const artifactWarmup = value.artifactWarmup;
  if (
    artifactWarmup !== undefined &&
    (!Number.isSafeInteger(artifactWarmup) || (artifactWarmup as number) < 0)
  ) {
    throw optionsError('jit.artifactWarmup must be a non-negative safe integer');
  }
  const maxCompiledDepth = value.maxCompiledDepth;
  if (
    maxCompiledDepth !== undefined &&
    (!Number.isSafeInteger(maxCompiledDepth) || (maxCompiledDepth as number) < 1)
  ) {
    throw optionsError('jit.maxCompiledDepth must be a positive safe integer');
  }
  const tierUpThreshold = value.tierUpThreshold;
  if (
    tierUpThreshold !== undefined &&
    tierUpThreshold !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(tierUpThreshold) || (tierUpThreshold as number) < 0)
  ) {
    throw optionsError('jit.tierUpThreshold must be a non-negative safe integer');
  }
  const optimizations = value.optimizations;
  if (optimizations !== undefined) {
    if (!isRecord(optimizations)) throw optionsError('jit.optimizations must be an object');
    for (const key of Object.keys(optimizations)) {
      if (!OPTIMIZATION_NAMES.has(key)) {
        throw optionsError(`Unknown JIT optimization "${key}"`);
      }
      if (typeof optimizations[key] !== 'boolean') {
        throw optionsError(`JIT optimization "${key}" must be a boolean`);
      }
    }
  }
  const switches = (optimizations ?? {}) as Partial<Record<IRJITOptimization, boolean>>;
  const resolved: Record<IRJITOptimization, boolean> = { ...OPTIMIZATION_DEFAULTS };
  for (const name of Object.keys(resolved) as IRJITOptimization[]) {
    resolved[name] = switches[name] !== false;
  }
  const debug = value.debug;
  if (debug !== undefined) {
    if (!isRecord(debug)) throw optionsError('jit.debug must be an object');
    for (const key of Object.keys(debug)) {
      if (!DEBUG_KEYS.has(key)) throw optionsError(`Unknown JIT debug option "${key}"`);
    }
    if (debug.verify !== undefined && typeof debug.verify !== 'boolean') {
      throw optionsError('jit.debug.verify must be a boolean');
    }
  }
  return {
    tier: (tier as IRJITTier | undefined) ?? 'auto',
    codegen: (codegen as IRJITCodegen | undefined) ?? 'auto',
    warmup: (warmup as IRJITWarmup | undefined) ?? 'lazy',
    artifactWarmup: (artifactWarmup as number | undefined) ?? 1,
    maxCompiledDepth: (maxCompiledDepth as number | undefined) ?? 1000,
    tierUpThreshold: (tierUpThreshold as number | undefined) ?? 1000,
    verify: debug !== undefined && (debug as { verify?: boolean }).verify === true,
    optimizations: resolved,
    dispatchIC: resolved.dispatchIC,
    checkpointFast: resolved.checkpointFast,
    // `regions` and `region-compile` are aliases; both must stay enabled.
    regions: resolved.regions && resolved['region-compile'],
    inline: switches.inline !== false,
  };
}

function optionsError(message: string): IRExecutionError {
  return new IRExecutionError('invalid-options', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class JITInterpreter implements IRInterpreter {
  readonly storage: EngineSetup['storage'];

  readonly #setup: EngineSetup;
  readonly #tuning: ResolvedTuning;
  readonly #lower: LowerContext;
  readonly #mir: readonly MFunction[];
  readonly #env: CompileEnv;
  readonly #runtime: JitRuntime;
  readonly #helpers: JitHelpers;
  readonly #control: StorageControl;
  readonly #compiled: (CompiledFunction | undefined)[];
  /** Tier-2 model functions, kept alongside tier-1 for diagnostics (J13). */
  readonly #tier2: (CompiledFunction | undefined)[];
  /** Shared callee table, summaries and SCC map used by the inliner. */
  readonly #inline: InlineContext;
  /** Artifact entries by compiled index for `rt.tierUp(index)` (J13). */
  readonly #artifactsByIndex = new Map<number, ArtifactEntry>();
  readonly #artifactEntries = new WeakMap<ProviderArtifact, ArtifactEntry>();
  /** Deep-fallback entries keyed by compiled function index (model and artifact). */
  readonly #heapEntries = new Map<number, HeapEntry>();
  /** Compiled artifacts grouped by the provider that produced them. */
  readonly #artifactsByProvider = new Map<object, Set<ArtifactEntry>>();
  /** Provider metadata for dispatch ICs and region keys. */
  readonly #providerInfo: readonly ProviderDispatchInfo[];
  /** Dispatch sites, jump caches and transition counts. */
  readonly #dispatch: DispatchRegistry;

  #faulted = false;
  #referenceOnly = false;
  #reference: IRInterpreter | undefined;
  #compiledFunctions = 0;
  #compiledArtifacts = 0;
  #recompiledArtifacts = 0;
  #tier2Compilations = 0;
  #regions = 0;
  #regionSource: string | undefined;

  constructor(setup: EngineSetup, tuning: ResolvedTuning) {
    this.#setup = setup;
    this.#tuning = tuning;
    this.storage = setup.storage;

    const executorNames = [...(setup.executors?.keys() ?? [])];
    const lower = createLowerContext(setup.model, executorNames);
    this.#lower = lower;
    const lowered = setup.model.functions.map((definition, index) =>
      lowerFunction(lower, definition, index, definition.name),
    );
    if (tuning.verify) {
      for (const fn of lowered) verifyMIR(fn, lower);
    }
    const passes = tuning.optimizations;
    this.#mir = lowered.map((fn) =>
      runJitOptimizationPipeline(fn, { memories: setup.model.memories }, lower, {
        passes,
        verify: tuning.verify,
        observer: setup.stepObserver !== undefined,
        constants: lower.constants,
      }),
    );
    for (let index = 0; index < setup.model.functions.length; index += 1) {
      this.#heapEntries.set(index, {
        fn: setup.model.functions[index]!,
        functionIndex: index,
        artifact: undefined,
      });
    }
    const summaries = computeSummaries(this.#mir);
    this.#inline = createInlineContext(this.#mir, summaries);

    const internals = storageInternalsOf(setup.storage);
    this.#control = internals.control;
    const runtime = new JitRuntime({
      context: PLACEHOLDER_CONTEXT,
      maxSteps: setup.maxSteps,
      ...(setup.stepObserver === undefined ? {} : { stepObserver: setup.stepObserver }),
      ...(setup.stepBudget === undefined ? {} : { stepBudget: setup.stepBudget }),
    });
    runtime.maxDepth = tuning.maxCompiledDepth;
    runtime.tierUpThreshold = tuning.tierUpThreshold;
    runtime.tierUp = (index) => this.#tierUp(index);
    this.#runtime = runtime;

    this.#providerInfo = providerDispatchInfo(setup.model.providers);
    this.#dispatch = new DispatchRegistry(this.#providerInfo);
    const helpers = createJitHelpers(setup, {
      artifact: (artifact, providerIndex) => this.#artifactState(artifact, providerIndex),
      dispatch: this.#dispatch,
    });
    this.#helpers = helpers;
    this.#compiled = new Array<CompiledFunction | undefined>(this.#mir.length);
    this.#tier2 = new Array<CompiledFunction | undefined>(this.#mir.length);
    this.#env = {
      rt: runtime,
      helpers,
      constants: lower.constants,
      memoryRefs: setup.model.memories.map((memory) => memory.ref),
      littleEndian: internals.littleEndianHost,
      summaries,
      providers: this.#providerInfo,
      dispatchIC: tuning.dispatchIC,
      checkpointFast: tuning.checkpointFast,
      optimizations: tuning.optimizations,
      verify: tuning.verify,
    };
    runtime.regionTrigger = (state) => this.#maybeFormRegion(state);

    // Every slot starts as a stub: generated code only ever calls `H.fns[i]`,
    // so replacing the slot is enough to swap in compiled code (J13 relies on
    // the same indirection for tiering).
    for (let index = 0; index < this.#mir.length; index += 1) {
      helpers.fns[index] = this.#lazySlot(index);
    }
    if (tuning.warmup === 'eager') {
      for (let index = 0; index < this.#mir.length; index += 1) this.#compileModel(index);
    }
    this.#installDeepFallback();

    const mode = (): 'reference' | 'jit' => (this.#referenceOnly ? 'reference' : 'jit');
    const compiledFunctions = (): number => this.#compiledFunctions;
    const compiledArtifacts = (): number => this.#compiledArtifacts;
    const recompiledArtifacts = (): number => this.#recompiledArtifacts;
    const tier2Compilations = (): number => this.#tier2Compilations;
    const icHits = (): number => this.#dispatch.stats().icHits;
    const icMisses = (): number => this.#dispatch.stats().icMisses;
    const jumpHits = (): number => this.#dispatch.jumpHits;
    const regions = (): number => this.#regions;
    const regionSource = (): string | undefined => this.#regionSource;
    const dispatchSites = (): IRJITInternals['dispatchSites'] =>
      this.#dispatch.sites.map((site) => ({
        states: [...site.states],
        keys: site.keys.map((keys) => (keys === undefined ? undefined : [...keys])),
        es: [...site.es],
        cs: [...site.cs],
        count: site.count,
        next: site.next,
        hits: site.hits,
        misses: site.misses,
      }));
    Object.defineProperty(this, jitInternals, {
      enumerable: false,
      configurable: false,
      value: Object.freeze({
        get mode(): 'reference' | 'jit' {
          return mode();
        },
        tier: tuning.tier,
        warmup: tuning.warmup,
        get compiledFunctions(): number {
          return compiledFunctions();
        },
        get compiledArtifacts(): number {
          return compiledArtifacts();
        },
        get recompiledArtifacts(): number {
          return recompiledArtifacts();
        },
        get tier2Compilations(): number {
          return tier2Compilations();
        },
        get icHits(): number {
          return icHits();
        },
        get icMisses(): number {
          return icMisses();
        },
        get jumpHits(): number {
          return jumpHits();
        },
        get regions(): number {
          return regions();
        },
        get regionSource(): string | undefined {
          return regionSource();
        },
        get dispatchSites(): IRJITInternals['dispatchSites'] {
          return dispatchSites();
        },
      }) satisfies IRJITInternals,
    });
    Object.freeze(this);
  }

  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context: IRExecutionContext,
  ): IRExecutionResult {
    if (this.#faulted) {
      throw new IRExecutionError(
        'instance-faulted',
        'The interpreter faulted; rebuild the instance',
      );
    }
    // Validation and argument capture match the reference exactly, including
    // the fact that these failures do not fault the instance.
    const prepared = prepareExecution(this.#setup, target, args, context);
    if (this.#referenceOnly) return this.#runReference(prepared);

    const index = this.#setup.indices.get(prepared.fn);
    if (index === undefined) {
      throw new IRExecutionError('invalid-target', 'Target does not belong to this interpreter');
    }
    let entry: CompiledFunction;
    try {
      entry = this.#compileModel(index);
    } catch (cause) {
      if (cause instanceof JitCodegenUnavailable) {
        return this.#fallback(prepared);
      }
      throw cause;
    }

    const saved = this.#saveRuntime();
    try {
      try {
        // May consult `stepBudget.remaining` for the first time.
        this.#runtime.begin(prepared.context);
      } catch (cause) {
        this.#faulted = true;
        throw wrapExecutionError(cause, prepared.context, [entryLocation(prepared.fn, index)], 0);
      }
      // Re-entrant execution keeps the outer nesting depth (the JS stack is
      // shared), while a top-level call starts from zero.
      this.#runtime.depth = saved.depth;

      try {
        const inputs = prepared.inputs.map((value, position) =>
          toJitArgument(prepared.fn.params[position]!, value),
        );
        let result = entry.fn(...inputs);
        while (result === TAIL) result = this.#runtime.runTail();
        // Every started step is committed before returning (R3).
        this.#runtime.flush();
        const values = resultValues(prepared.fn.results, result, this.#runtime);
        return Object.freeze({
          values: Object.freeze(values),
          steps: this.#runtime.steps,
        });
      } catch (cause) {
        this.#faulted = true;
        try {
          this.#runtime.flush();
        } catch {
          // Host accounting failures surface through the unwind below.
        }
        if (cause instanceof JitUnwind) {
          if (cause.cause instanceof JitCodegenUnavailable) this.#referenceOnly = true;
          throw wrapExecutionError(
            cause.cause,
            prepared.context,
            [...cause.frames].reverse(),
            cause.steps,
          );
        }
        // Everything else originates outside generated code (a final budget
        // flush, result conversion). The reference wraps these too.
        throw wrapExecutionError(cause, prepared.context, [], this.#runtime.steps);
      }
    } finally {
      this.#restoreRuntime(saved);
    }
  }

  // --- Model functions ---------------------------------------------------

  #lazySlot(index: number): CompiledFn {
    return (...args: unknown[]) => this.#compileModel(index).fn(...args);
  }

  #compileModel(index: number): CompiledFunction {
    const existing = this.#compiled[index];
    if (existing !== undefined) return existing;
    const mir = this.#mir[index];
    if (mir === undefined) throw new Error(`JIT has no model function ${index}`);
    const tier2 = this.#tuning.tierUpThreshold === 0;
    const compiled = this.#compileMIR(mir, tier2);
    this.#compiled[index] = compiled;
    if (tier2) {
      this.#tier2[index] = compiled;
      this.#tier2Compilations += 1;
    } else {
      this.#armTierCounter(index);
    }
    this.#helpers.fns[index] = compiled.fn;
    this.#compiledFunctions += 1;
    return compiled;
  }

  /** True when the engine should emit tier-1 entry counters. */
  #tieringEnabled(): boolean {
    return Number.isFinite(this.#tuning.tierUpThreshold) && this.#tuning.tierUpThreshold > 0;
  }

  #armTierCounter(index: number): void {
    if (!this.#tieringEnabled()) return;
    this.#runtime.counters[index] ??= 0;
  }

  /**
   * Compile one function, optionally through the tier-2 pipeline (inline +
   * profile-biased layout). `tier2` is false for tier-1 and true for the
   * first compile when `tierUpThreshold` is 0 or for a promotion.
   */
  #compileMIR(
    mir: MFunction,
    tier2: boolean,
    artifactDependencies?: readonly unknown[],
    artifactState?: ArtifactState,
  ): CompiledFunction {
    let optimized = mir;
    let layout: LayoutProfile | undefined;
    if (tier2) {
      // Even when `inline` is disabled, the pass supplies the layout weights;
      // `maxInstructions: 0` makes it a pure layout/profile computation.
      const result = inlineFunction(mir, this.#inline, {
        ...(this.#tuning.inline ? {} : { maxInstructions: 0 }),
        profile: { calls: this.#callProfile() },
      });
      optimized = result.fn;
      layout = result.layout;
      if (this.#tuning.verify) verifyMIR(optimized, this.#lower);
    }
    return compileFunctionWithSource(optimized, {
      ...this.#env,
      ...(artifactDependencies === undefined ? {} : { artifactDependencies }),
      ...(artifactState === undefined ? {} : { artifactState }),
      ...(layout === undefined ? {} : { layout }),
      ...(!tier2 && this.#tieringEnabled() ? { tierUp: true } : {}),
    });
  }

  /** Tier-1 invocation counts, used to rank inlining candidates. */
  #callProfile(): ReadonlyMap<number, number> {
    const calls = new Map<number, number>();
    for (let index = 0; index < this.#mir.length; index += 1) {
      const count = this.#runtime.counters[index];
      if (count !== undefined && count > 0) calls.set(index, count);
    }
    return calls;
  }

  /**
   * Synchronous Tier-2 promotion (J13). The activation that triggered the
   * counter keeps running its tier-1 body; replacing `H.fns[i]` routes every
   * later call (including recursive calls) through the new code.
   */
  #tierUp(index: number): void {
    this.#runtime.counters[index] = -1;
    if (index < this.#mir.length) {
      if (this.#tier2[index] !== undefined) return;
      const mir = this.#mir[index];
      if (mir === undefined) return;
      try {
        const compiled = this.#compileMIR(mir, true);
        this.#tier2[index] = compiled;
        this.#compiled[index] = compiled;
        this.#helpers.fns[index] = compiled.fn;
        this.#compiledFunctions += 1;
        this.#tier2Compilations += 1;
      } catch (cause) {
        if (!(cause instanceof JitCodegenUnavailable)) throw cause;
      }
      return;
    }

    const entry = this.#artifactsByIndex.get(index);
    if (entry === undefined || entry.tier2 !== undefined) return;
    if (entry.tier1 === undefined && entry.tier2 === undefined) return;
    try {
      const compiled = this.#compileMIR(entry.mir, true, entry.dependencies, entry);
      entry.tier2 = compiled;
      entry.compiled = compiled;
      entry.entries = 0;
      this.#helpers.fns[index] = compiled.fn;
      this.#compiledArtifacts += 1;
      this.#tier2Compilations += 1;
    } catch (cause) {
      if (!(cause instanceof JitCodegenUnavailable)) throw cause;
    }
  }

  /**
   * Deep-recursion fallback used by the compiled prologue. The reference
   * interpreter is iterative; compiled code is not, so a very deep call chain
   * restarts a bounded compiled segment instead of exhausting the JS stack.
   */
  #installDeepFallback(): void {
    this.#runtime.deep = (functionIndex: number, ...args: unknown[]): unknown => {
      const entry = this.#heapEntries.get(functionIndex);
      if (entry === undefined) {
        throw new Error(`JIT deep fallback for function ${functionIndex} is unavailable`);
      }
      return runHeapFunction(this.#setup, this.#runtime, entry, args, this.#heapOptions());
    };
  }

  /** Hooks used by every heap-tier run started by this engine (J13). */
  #heapOptions(): HeapRunOptions {
    return {
      onArtifact: (artifact, providerIndex) => this.#noteHeapArtifact(artifact, providerIndex),
    };
  }

  /**
   * A provider artifact was dispatched from heap code. Register it so
   * `artifactWarmup` and tiering see the run even when the compiled parents
   * never touched it.
   */
  #noteHeapArtifact(artifact: ProviderArtifact, providerIndex: number): void {
    const entry = this.#artifactState(artifact, providerIndex);
    if (entry.tier1 !== undefined || entry.tier2 !== undefined) {
      // It already has compiled code; heap execution still counts for tiering.
      this.#runtime.noteEntry(artifact.index);
      return;
    }
    entry.uses += 1;
    // Do not form a dispatch region while the artifact is still warming.
    entry.entries = 0;
    if (!entry.heapOnly && entry.uses >= this.#tuning.artifactWarmup) {
      this.#tryCompileArtifact(entry);
    }
  }

  // --- Provider artifacts ------------------------------------------------

  /**
   * Return the state for one materialized artifact. Compilation happens on the
   * first dispatch (never at engine creation) and a cached artifact is
   * recompiled when its dependency chain changed. The state object is stable
   * across recompiles, so an IC entry keeps pointing at the current function.
   */
  #artifactState(artifact: ProviderArtifact, providerIndex: number): ArtifactEntry {
    validateArtifact(artifact);
    let entry = this.#artifactEntries.get(artifact);
    if (entry === undefined) {
      entry = this.#compileArtifact(artifact, providerIndex);
    } else if (this.#dependenciesChanged(entry)) {
      if (!this.#deepDependenciesValid(entry, new Set())) {
        entry = this.#recompileArtifact(entry, artifact);
      } else {
        entry.storageEpoch = this.#control.epoch;
        entry.providerEpoch = this.#setup.providers.cacheEpoch;
        entry.validatedEpoch = this.#control.epoch;
      }
    }
    this.#helpers.fns[artifact.index] = entry.compiled.fn;
    return entry;
  }

  #compileArtifact(artifact: ProviderArtifact, providerIndex: number): ArtifactEntry {
    const lowered = lowerFunction(this.#lower, artifact.fn, artifact.index, artifact.name);
    if (this.#tuning.verify) verifyMIR(lowered, this.#lower);
    const mir = runJitOptimizationPipeline(
      lowered,
      { memories: this.#setup.model.memories },
      this.#lower,
      {
        passes: this.#tuning.optimizations,
        verify: this.#tuning.verify,
        observer: this.#setup.stepObserver !== undefined,
        constants: this.#lower.constants,
      },
    );
    // The state must exist before code generation: the checkpoint fast path
    // embeds it as a constant. With `artifactWarmup > 0` the initial function
    // is the heap-tier wrapper; it is replaced once the artifact is hot.
    const placeholder: CompiledFunction = {
      fn: () => {
        throw new Error('JIT artifact state used before compilation finished');
      },
      source: '',
      frame: { locations: [], stepsAfter: new Int32Array(0) },
      structured: true,
      fallback: undefined,
      constants: [],
    };
    const entry: ArtifactEntry = {
      artifact,
      key: artifact.key,
      providerIndex,
      mir,
      providers: providerIndices(mir),
      compiled: placeholder,
      tier1: undefined,
      tier2: undefined,
      warmup: undefined,
      uses: 0,
      heapOnly: false,
      dependencies: artifact.dependencies,
      storageEpoch: this.#control.epoch,
      providerEpoch: this.#setup.providers.cacheEpoch,
      validatedEpoch: this.#control.epoch,
      entries: 0,
      region: undefined,
      regionIndex: -1,
    };
    this.#artifactEntries.set(artifact, entry);
    this.#artifactsByIndex.set(artifact.index, entry);
    this.#heapEntries.set(artifact.index, {
      fn: artifact.fn,
      functionIndex: artifact.index,
      artifact,
    });
    this.#registerEntry(entry, artifact);
    if (this.#tuning.artifactWarmup > 0) {
      entry.warmup = this.#artifactWarmupWrapper(entry);
      entry.compiled = Object.freeze({ ...placeholder, fn: entry.warmup });
    } else {
      this.#compileArtifactTier(entry);
    }
    return entry;
  }

  /** Heap-tier wrapper used until `artifactWarmup` runs have completed. */
  #artifactWarmupWrapper(entry: ArtifactEntry): CompiledFn {
    return (...args: unknown[]): unknown => {
      if (entry.tier1 !== undefined || entry.tier2 !== undefined) {
        return entry.compiled.fn(...args);
      }
      const heap = this.#heapEntries.get(entry.artifact.index);
      if (heap === undefined) {
        throw new Error(`JIT heap entry for artifact ${entry.artifact.index} is unavailable`);
      }
      const result = runHeapFunction(this.#setup, this.#runtime, heap, args, this.#heapOptions());
      entry.uses += 1;
      entry.entries = 0;
      if (!entry.heapOnly && entry.uses >= this.#tuning.artifactWarmup) {
        this.#tryCompileArtifact(entry);
      }
      if (entry.tier1 !== undefined || entry.tier2 !== undefined) {
        this.#helpers.fns[entry.artifact.index] = entry.compiled.fn;
      }
      return result;
    };
  }

  /** Compile an artifact at the tier selected by `tierUpThreshold`. */
  #compileArtifactTier(entry: ArtifactEntry): void {
    const tier2 = this.#tuning.tierUpThreshold === 0;
    const compiled = this.#compileMIR(entry.mir, tier2, entry.dependencies, entry);
    if (tier2) {
      entry.tier2 = compiled;
      this.#tier2Compilations += 1;
    } else {
      entry.tier1 = compiled;
      this.#armTierCounter(entry.artifact.index);
    }
    entry.compiled = compiled;
    entry.warmup = undefined;
    entry.entries = 0;
    this.#helpers.fns[entry.artifact.index] = compiled.fn;
    this.#compiledArtifacts += 1;
  }

  /** Warmup compilation is best effort: keep the heap tier when codegen is blocked. */
  #tryCompileArtifact(entry: ArtifactEntry): void {
    try {
      this.#compileArtifactTier(entry);
    } catch (cause) {
      if (!(cause instanceof JitCodegenUnavailable)) throw cause;
      entry.heapOnly = true;
      entry.uses = 0;
    }
  }

  #recompileArtifact(entry: ArtifactEntry, artifact: ProviderArtifact): ArtifactEntry {
    // While an artifact is still warming there is no compiled code to refresh;
    // keep the wrapper and update the epochs so the next dispatch is clean.
    if (entry.tier1 === undefined && entry.tier2 === undefined) {
      entry.dependencies = artifact.dependencies;
      entry.storageEpoch = this.#control.epoch;
      entry.providerEpoch = this.#setup.providers.cacheEpoch;
      entry.validatedEpoch = this.#control.epoch;
      return entry;
    }
    this.#recompiledArtifacts += 1;
    const tier2 = entry.tier2 !== undefined || this.#tuning.tierUpThreshold === 0;
    const compiled = this.#compileMIR(entry.mir, tier2, artifact.dependencies, entry);
    entry.compiled = compiled;
    if (tier2) {
      entry.tier2 = compiled;
      this.#tier2Compilations += 1;
    } else {
      entry.tier1 = compiled;
      this.#armTierCounter(entry.artifact.index);
    }
    this.#compiledArtifacts += 1;
    entry.dependencies = artifact.dependencies;
    entry.storageEpoch = this.#control.epoch;
    entry.providerEpoch = this.#setup.providers.cacheEpoch;
    entry.validatedEpoch = this.#control.epoch;
    return entry;
  }

  #registerEntry(entry: ArtifactEntry, artifact: ProviderArtifact): void {
    const ref = artifact.definition.ref;
    let entries = this.#artifactsByProvider.get(ref);
    if (entries === undefined) {
      entries = new Set();
      this.#artifactsByProvider.set(ref, entries);
    }
    entries.add(entry);
  }

  #dependenciesChanged(entry: ArtifactEntry): boolean {
    return (
      entry.storageEpoch !== this.#control.epoch ||
      entry.providerEpoch !== this.#setup.providers.cacheEpoch
    );
  }

  /**
   * R-6: a cached artifact is only reusable when every artifact it may dispatch
   * to is still valid too. Provider calls are visible in the MIR, so the check
   * walks the whole provider chain instead of only the artifact's own reads.
   */
  #deepDependenciesValid(entry: ArtifactEntry, seen: Set<ArtifactEntry>): boolean {
    if (seen.has(entry)) return true;
    seen.add(entry);
    if (!this.#setup.storage.validateDependencies(entry.dependencies)) return false;
    for (const index of entry.providers) {
      const provider = this.#setup.model.providers[index];
      if (provider === undefined) continue;
      const children = this.#artifactsByProvider.get(provider.ref);
      if (children === undefined) continue;
      for (const child of children) {
        if (!this.#deepDependenciesValid(child, seen)) return false;
      }
    }
    return true;
  }

  // --- Region compilation (J14) ------------------------------------------

  /**
   * Called once an artifact reaches {@link REGION_THRESHOLD} entries. The
   * hottest dispatch chain rooted at it is compiled into a single JavaScript
   * state machine; every member then routes through it in `runTail`.
   */
  #maybeFormRegion(state: ArtifactState): void {
    if (!this.#tuning.regions || state.region !== undefined) return;
    const info = this.#providerInfo[state.providerIndex];
    if (info === undefined) return;
    // Promoted locals are not namespaced per member yet; keeping such
    // artifacts on the normal dispatch path is correctness-preserving.
    if (state.mir.promotions.length > 0) {
      state.entries = REGION_THRESHOLD + 1;
      return;
    }
    const members = collectRegionMembers(state, this.#dispatch).filter(
      (member) => member.mir.promotions.length === 0,
    );
    if (members.length === 0) return;
    try {
      const region = compileRegionWithSource(
        members.map((member) => ({
          state: member,
          mir: member.mir,
          key: member.key,
          keyTypes: info.keyTypes,
          providerIndex: member.providerIndex,
          params: info.params,
        })),
        this.#env,
      );
      attachRegion(region);
      this.#regions += 1;
      this.#regionSource = region.source;
    } catch {
      // Keep normal dispatch. Moving past the threshold avoids recompiling a
      // broken region on every subsequent entry.
      state.entries = REGION_THRESHOLD + 1;
    }
  }

  // --- Reference fallback ------------------------------------------------

  #runReference(prepared: PreparedExecution): IRExecutionResult {
    const reference = this.#referenceEngine();
    try {
      return reference.execute(prepared.fn.ref, prepared.inputs, prepared.context);
    } catch (cause) {
      this.#faulted = true;
      throw cause;
    }
  }

  #fallback(prepared: PreparedExecution): IRExecutionResult {
    // A lazy compilation failed (for example because the host disabled
    // `unsafe-eval` after creation). No compiled step ran yet, so handing the
    // whole execution to the reference engine is observationally equivalent.
    this.#referenceOnly = true;
    return this.#runReference(prepared);
  }

  #referenceEngine(): IRInterpreter {
    let reference = this.#reference;
    if (reference === undefined) {
      reference = createIRInterpreterFromSetup(this.#setup);
      this.#reference = reference;
    }
    return reference;
  }

  // --- Execution state ---------------------------------------------------

  #saveRuntime(): SavedRuntime {
    const runtime = this.#runtime;
    return {
      steps: runtime.steps,
      committed: runtime.committed,
      limit: runtime.limit,
      context: runtime.context,
      tailFn: runtime.tailFn,
      tailArgs: runtime.tailArgs,
      tailState: runtime.tailState,
      currentState: runtime.currentState,
      depth: runtime.depth,
      ret: runtime.ret.length === 0 ? undefined : [...runtime.ret],
    };
  }

  #restoreRuntime(saved: SavedRuntime): void {
    const runtime = this.#runtime;
    runtime.steps = saved.steps;
    runtime.committed = saved.committed;
    runtime.limit = saved.limit;
    runtime.context = saved.context;
    runtime.tailFn = saved.tailFn;
    runtime.tailArgs = saved.tailArgs;
    runtime.tailState = saved.tailState;
    runtime.currentState = saved.currentState;
    runtime.depth = saved.depth;
    runtime.ret.length = 0;
    if (saved.ret !== undefined) runtime.ret.push(...saved.ret);
  }
}

function validateArtifact(artifact: ProviderArtifact): void {
  const { definition, fn } = artifact;
  if (
    !sameResultTypes(fn.params, definition.params) ||
    !sameResultTypes(fn.results, definition.results)
  ) {
    throw new IRProviderError(
      'invalid-artifact',
      `Provider artifact "${artifact.name}" does not match its declared signature`,
    );
  }
}

/** Provider indices referenced by dispatch terminators or checkpoints. */
function providerIndices(mir: MFunction): readonly number[] {
  const providers = new Set<number>();
  for (const block of mir.blocks) {
    for (const inst of block.insts) {
      if (inst.op !== Op.Checkpoint) continue;
      const index = inst.refs[0];
      if (index !== undefined) providers.add(index);
    }
    if (block.term.kind === 'dispatch') providers.add(block.term.provider);
  }
  return [...providers];
}

function entryLocation(
  fn: FunctionDefinition,
  functionIndex: number,
): ReturnType<typeof makeLocation> {
  const body = fn.body!;
  const block = body.entry;
  const blockIndex = body.blocks.indexOf(block);
  return makeLocation(
    functionIndex,
    fn,
    blockIndex,
    block,
    block.instructions.length > 0 ? 0 : undefined,
  );
}

function resultValues(
  types: readonly ScalarType[],
  result: unknown,
  runtime: JitRuntime,
): RuntimeScalar[] {
  if (types.length === 0) return [];
  if (types.length === 1) return [fromJitResult(types[0]!, result)];
  return types.map((type, index) => fromJitResult(type, runtime.ret[index]));
}
