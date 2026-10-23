/**
 * Minimal test assembly for the J6 JIT (J7 owns the real `createIRJIT`).
 *
 * It validates the module through the same `prepareEngine` path as the
 * reference interpreter, lowers every function to MIR, compiles the whole
 * module in one batch, and drives a single execution (including `TAIL`
 * chains). Tests compare its results, step counts and errors with
 * `createIRInterpreter`.
 */
import type { EngineSetup, Target } from '../../engine-setup';
import { prepareEngine } from '../../engine-setup';
import { prepareExecution, wrapExecutionError } from '../../engine-host';
import type {
  IRExecutionContext,
  IRExecutionResult,
  IRInterpreterOptions,
} from '../../interpreter';
import type { IRModule, RuntimeScalar, ScalarType } from '../../types';
import { compileFunctionWithSource } from '../codegen/compile';
import type { CompileEnv, CompiledFunction } from '../codegen/compile';
import { computeSummaries } from '../effects';
import { lowerFunction } from '../mir';
import type { MFunction } from '../mir';
import { createLowerContext } from '../resolve';
import {
  JitRuntime,
  JitUnwind,
  TAIL,
  createJitHelpers,
  fromJitResult,
  storageInternalsOf,
  toJitArgument,
} from '../runtime-core';
import type { JitHelpers } from '../runtime-core';

export interface CompiledModule {
  readonly setup: EngineSetup;
  readonly runtime: JitRuntime;
  readonly helpers: JitHelpers;
  /** Compile-time environment; also proves the per-environment source cache. */
  readonly env: CompileEnv;
  readonly functions: readonly CompiledFunction[];
  readonly mir: readonly MFunction[];
  /** Execute `target` exactly like `IRInterpreter.execute`. */
  execute(
    target: Target,
    args: readonly RuntimeScalar[],
    context?: IRExecutionContext,
  ): IRExecutionResult;
  /** Generated source for one model function index. */
  source(functionIndex: number): string;
}

const DEFAULT_CONTEXT: IRExecutionContext = Object.freeze({
  instanceId: 'jit',
  virtualTime: 0,
});

/**
 * Compile every model function. Executor tables keep the declaration order of
 * `options.executors`, matching `createLowerContext` and `Helpers.executor`.
 */
export function compileModule(
  module: IRModule,
  options: IRInterpreterOptions,
  extra: { readonly forceSwitch?: boolean } = {},
): CompiledModule {
  const setup = prepareEngine(module, options);
  const executorNames = [...(setup.executors?.keys() ?? [])];
  const lower = createLowerContext(setup.model, executorNames);
  const mir = setup.model.functions.map((definition, index) =>
    lowerFunction(lower, definition, index, definition.name),
  );
  const summaries = computeSummaries(mir);

  const runtimeOptions = {
    context: DEFAULT_CONTEXT,
    maxSteps: setup.maxSteps,
    ...(setup.stepObserver === undefined ? {} : { stepObserver: setup.stepObserver }),
    ...(setup.stepBudget === undefined ? {} : { stepBudget: setup.stepBudget }),
  };
  const runtime = new JitRuntime(runtimeOptions);
  // Set immediately after the helpers exist; artifact compilation only happens
  // while executing, so the reference is always populated by then.
  const environment: { current: CompileEnv | undefined } = { current: undefined };
  const helpers = createJitHelpers(setup, {
    // J7 compiles artifacts lazily; the test assembly does the same so that
    // `dispatch` and invalidated `checkpoint` transfers can be exercised.
    artifact: (artifact) => {
      const existing = helpers.fns[artifact.index];
      if (existing !== undefined) return existing;
      const env = environment.current;
      if (env === undefined) throw new Error('JIT test assembly is not initialized');
      const mfn = lowerFunction(lower, artifact.fn, artifact.index, artifact.name);
      const compiledArtifact = compileFunctionWithSource(mfn, {
        ...env,
        artifactDependencies: artifact.dependencies,
      });
      helpers.fns[artifact.index] = compiledArtifact.fn;
      return compiledArtifact.fn;
    },
  });
  const compileEnv: CompileEnv = {
    rt: runtime,
    helpers,
    constants: lower.constants,
    memoryRefs: setup.model.memories.map((memory) => memory.ref),
    littleEndian: storageInternalsOf(setup.storage).littleEndianHost,
    summaries,
    ...(extra.forceSwitch === undefined ? {} : { forceSwitch: extra.forceSwitch }),
  };
  environment.current = compileEnv;
  const compiled = mir.map((fn) => compileFunctionWithSource(fn, compileEnv));
  for (const entry of compiled) helpers.fns.push(entry.fn);

  return {
    setup,
    runtime,
    helpers,
    env: compileEnv,
    functions: compiled,
    mir,
    execute(target, args, context = DEFAULT_CONTEXT) {
      // Reuse the reference pre-execution validation and argument capture.
      const prepared = prepareExecution(setup, target, args, context);
      const index = setup.indices.get(prepared.fn)!;
      const compiledFn = compiled[index]!;
      runtime.begin(prepared.context);
      const inputs = prepared.inputs.map((value, position) =>
        toJitArgument(prepared.fn.params[position]!, value),
      );
      try {
        let result = compiledFn.fn(...inputs);
        while (result === TAIL) result = runtime.runTail();
        // J7 owns this flush for the real engine: every started step is
        // committed before execute returns (R3).
        runtime.flush();
        const values = resultValues(prepared.fn.results, result, runtime);
        return Object.freeze({
          values: Object.freeze(values),
          steps: runtime.steps,
        });
      } catch (cause) {
        if (cause instanceof JitUnwind) {
          // ...and before an error escapes, with the original cause winning.
          try {
            runtime.flush();
          } catch {
            // Host accounting failures surface through the unwind below.
          }
          throw wrapExecutionError(
            cause.cause,
            prepared.context,
            [...cause.frames].reverse(),
            cause.steps,
          );
        }
        throw cause;
      }
    },
    source(functionIndex) {
      const entry = compiled[functionIndex];
      if (entry === undefined) throw new Error(`no compiled function ${functionIndex}`);
      return entry.source;
    },
  };
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
