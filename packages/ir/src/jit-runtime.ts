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
import { compileFunctionWithSource, JitCodegenUnavailable } from './jit/codegen/compile';
import type { CompileEnv, CompiledFunction } from './jit/codegen/compile';
import { computeSummaries } from './jit/effects';
import { runHeapFunction } from './jit/heap-tier';
import type { HeapEntry } from './jit/heap-tier';
import { Op, lowerFunction } from './jit/mir';
import type { MFunction } from './jit/mir';
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

/**
 * Optimization switches. J11–J14 extend this into a literal union; until then
 * no optimization names are accepted and `optimizations` must be empty.
 */
export type IRJITOptimization = never;

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
   * Number of heap-tier runs before an artifact is compiled. Accepted for the
   * J0 tuning surface; this engine compiles an artifact on first dispatch.
   * Non-negative safe integer, default 1.
   */
  readonly artifactWarmup?: number;
  /**
   * Maximum nesting depth of compiled frames before the engine re-enters the
   * function with a fresh compiled segment. Positive safe integer, default 1000.
   */
  readonly maxCompiledDepth?: number;
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
}

interface ResolvedTuning {
  readonly tier: IRJITTier;
  readonly codegen: IRJITCodegen;
  readonly warmup: IRJITWarmup;
  readonly artifactWarmup: number;
  readonly maxCompiledDepth: number;
  readonly verify: boolean;
}

interface ArtifactEntry {
  readonly mir: MFunction;
  /** Provider indices this artifact may dispatch/checkpoint to. */
  readonly providers: readonly number[];
  compiled: CompiledFunction;
  dependencies: readonly IRResourceDependency[];
  storageEpoch: number;
  providerEpoch: number;
}

type PreparedExecution = ReturnType<typeof prepareExecution>;

interface SavedRuntime {
  readonly steps: number;
  readonly committed: number;
  readonly limit: number;
  readonly context: IRExecutionContext;
  readonly tailFn: CompiledFn | undefined;
  readonly tailArgs: unknown[] | undefined;
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
  'optimizations',
  'debug',
]);

const DEBUG_KEYS: ReadonlySet<string> = new Set(['verify']);

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
      verify: false,
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
  const optimizations = value.optimizations;
  if (optimizations !== undefined) {
    if (!isRecord(optimizations)) throw optionsError('jit.optimizations must be an object');
    for (const key of Object.keys(optimizations)) {
      throw optionsError(`Unknown JIT optimization "${key}"`);
    }
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
    verify: debug !== undefined && (debug as { verify?: boolean }).verify === true,
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
  readonly #artifactEntries = new WeakMap<ProviderArtifact, ArtifactEntry>();
  /** Deep-fallback entries keyed by compiled function index (model and artifact). */
  readonly #heapEntries = new Map<number, HeapEntry>();
  /** Compiled artifacts grouped by the provider that produced them. */
  readonly #artifactsByProvider = new Map<object, Set<ArtifactEntry>>();

  #faulted = false;
  #referenceOnly = false;
  #reference: IRInterpreter | undefined;
  #compiledFunctions = 0;
  #compiledArtifacts = 0;
  #recompiledArtifacts = 0;

  constructor(setup: EngineSetup, tuning: ResolvedTuning) {
    this.#setup = setup;
    this.#tuning = tuning;
    this.storage = setup.storage;

    const executorNames = [...(setup.executors?.keys() ?? [])];
    const lower = createLowerContext(setup.model, executorNames);
    this.#lower = lower;
    this.#mir = setup.model.functions.map((definition, index) =>
      lowerFunction(lower, definition, index, definition.name),
    );
    for (let index = 0; index < setup.model.functions.length; index += 1) {
      this.#heapEntries.set(index, {
        fn: setup.model.functions[index]!,
        functionIndex: index,
        artifact: undefined,
      });
    }
    if (tuning.verify) {
      for (const fn of this.#mir) verifyMIR(fn, lower);
    }
    const summaries = computeSummaries(this.#mir);

    const internals = storageInternalsOf(setup.storage);
    this.#control = internals.control;
    const runtime = new JitRuntime({
      context: PLACEHOLDER_CONTEXT,
      maxSteps: setup.maxSteps,
      ...(setup.stepObserver === undefined ? {} : { stepObserver: setup.stepObserver }),
      ...(setup.stepBudget === undefined ? {} : { stepBudget: setup.stepBudget }),
    });
    runtime.maxDepth = tuning.maxCompiledDepth;
    this.#runtime = runtime;

    const helpers = createJitHelpers(setup, {
      artifact: (artifact) => this.#artifactFunction(artifact),
    });
    this.#helpers = helpers;
    this.#compiled = new Array<CompiledFunction | undefined>(this.#mir.length);
    this.#env = {
      rt: runtime,
      helpers,
      constants: lower.constants,
      memoryRefs: setup.model.memories.map((memory) => memory.ref),
      littleEndian: internals.littleEndianHost,
      summaries,
    };

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
    const compiled = compileFunctionWithSource(mir, this.#env);
    this.#compiled[index] = compiled;
    this.#helpers.fns[index] = compiled.fn;
    this.#compiledFunctions += 1;
    return compiled;
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
      return runHeapFunction(this.#setup, this.#runtime, entry, args);
    };
  }

  // --- Provider artifacts ------------------------------------------------

  /**
   * Return the compiled function for one materialized artifact. Compilation
   * happens on the first dispatch (never at engine creation) and a cached
   * artifact is recompiled when its dependency chain changed.
   */
  #artifactFunction(artifact: ProviderArtifact): CompiledFn {
    validateArtifact(artifact);
    let entry = this.#artifactEntries.get(artifact);
    if (entry === undefined) {
      entry = this.#compileArtifact(artifact);
    } else if (this.#dependenciesChanged(entry)) {
      if (!this.#deepDependenciesValid(entry, new Set())) {
        entry = this.#recompileArtifact(entry, artifact);
      } else {
        entry.storageEpoch = this.#control.epoch;
        entry.providerEpoch = this.#setup.providers.cacheEpoch;
      }
    }
    this.#helpers.fns[artifact.index] = entry.compiled.fn;
    return entry.compiled.fn;
  }

  #compileArtifact(artifact: ProviderArtifact): ArtifactEntry {
    const mir = lowerFunction(this.#lower, artifact.fn, artifact.index, artifact.name);
    if (this.#tuning.verify) verifyMIR(mir, this.#lower);
    const compiled = compileFunctionWithSource(mir, {
      ...this.#env,
      artifactDependencies: artifact.dependencies,
    });
    this.#compiledArtifacts += 1;
    const entry: ArtifactEntry = {
      mir,
      providers: providerIndices(mir),
      compiled,
      dependencies: artifact.dependencies,
      storageEpoch: this.#control.epoch,
      providerEpoch: this.#setup.providers.cacheEpoch,
    };
    this.#artifactEntries.set(artifact, entry);
    this.#heapEntries.set(artifact.index, {
      fn: artifact.fn,
      functionIndex: artifact.index,
      artifact,
    });
    this.#registerEntry(entry, artifact);
    return entry;
  }

  #recompileArtifact(entry: ArtifactEntry, artifact: ProviderArtifact): ArtifactEntry {
    this.#recompiledArtifacts += 1;
    const compiled = compileFunctionWithSource(entry.mir, {
      ...this.#env,
      artifactDependencies: artifact.dependencies,
    });
    this.#compiledArtifacts += 1;
    entry.compiled = compiled;
    entry.dependencies = artifact.dependencies;
    entry.storageEpoch = this.#control.epoch;
    entry.providerEpoch = this.#setup.providers.cacheEpoch;
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
