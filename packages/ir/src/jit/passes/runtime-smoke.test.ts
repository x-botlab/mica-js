import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { createIRModule } from '../../index';
import { createIRInterpreter } from '../../interpreter';
import { prepareEngine } from '../../engine-setup';
import type { Target } from '../../engine-setup';
import { prepareExecution, wrapExecutionError } from '../../engine-host';
import type { IRExecutionContext, IRInterpreter, IRInterpreterOptions } from '../../interpreter';
import { IRExecutionError } from '../../interpreter';
import type { IRModule, RuntimeScalar, ScalarType } from '../../types';
import { compileFunctionWithSource } from '../codegen/compile';
import { computeSummaries } from '../effects';
import { createLowerContext, lowerFunction } from '../mir';
import {
  JitRuntime,
  JitUnwind,
  TAIL,
  createJitHelpers,
  fromJitResult,
  storageInternalsOf,
  toJitArgument,
} from '../runtime-core';
import { REFERENCE_CONFIG, runOracle } from '../testing/oracle';
import type { ParityConfig } from '../testing/oracle';
import { randomProgram } from '../testing/random-ir';
import type { RandomProfile } from '../testing/random-ir';
import { ALL_OPTIMIZATIONS, runOptimizationPipeline } from './pipeline';
import type { OptimizationSwitches } from './pipeline';

const CONTEXT: IRExecutionContext = Object.freeze({ instanceId: 'optimized', virtualTime: 0 });

function resultValues(
  types: readonly ScalarType[],
  result: unknown,
  runtime: JitRuntime,
): RuntimeScalar[] {
  if (types.length === 0) return [];
  if (types.length === 1) return [fromJitResult(types[0]!, result)];
  return types.map((type, index) => fromJitResult(type, runtime.ret[index]));
}

/** A JIT interpreter whose MIR goes through the scalar pipeline (providers off). */
function createOptimizedInterpreter(
  module: IRModule,
  options: IRInterpreterOptions,
  switches: OptimizationSwitches = ALL_OPTIMIZATIONS,
): IRInterpreter {
  const setup = prepareEngine(module, options);
  const lower = createLowerContext(setup.model, [...(setup.executors?.keys() ?? [])]);
  const mir = setup.model.functions.map((definition, index) => {
    const lowered = lowerFunction(lower, definition, index, definition.name);
    return runOptimizationPipeline(lowered, {
      constants: lower.constants,
      passes: switches,
    });
  });
  const summaries = computeSummaries(mir);
  const runtime = new JitRuntime({
    context: CONTEXT,
    maxSteps: setup.maxSteps,
    ...(setup.stepObserver === undefined ? {} : { stepObserver: setup.stepObserver }),
    ...(setup.stepBudget === undefined ? {} : { stepBudget: setup.stepBudget }),
  });
  const helpers = createJitHelpers(setup);
  const compiled = mir.map((fn) =>
    compileFunctionWithSource(fn, {
      rt: runtime,
      helpers,
      constants: lower.constants,
      memoryRefs: setup.model.memories.map((memory) => memory.ref),
      littleEndian: storageInternalsOf(setup.storage).littleEndianHost,
      summaries,
    }),
  );
  for (const entry of compiled) helpers.fns.push(entry.fn);

  let faulted = false;
  return {
    storage: setup.storage,
    execute(target: Target, args: readonly RuntimeScalar[], context: IRExecutionContext) {
      if (faulted) {
        throw new IRExecutionError(
          'instance-faulted',
          'The interpreter faulted; rebuild the instance',
        );
      }
      const prepared = prepareExecution(setup, target, args, context);
      const index = setup.indices.get(prepared.fn)!;
      const fn = compiled[index]!;
      try {
        runtime.begin(prepared.context);
      } catch (cause) {
        faulted = true;
        throw wrapExecutionError(cause, prepared.context, [], 0);
      }
      const inputs = prepared.inputs.map((value, position) =>
        toJitArgument(prepared.fn.params[position]!, value),
      );
      try {
        let result = fn.fn(...inputs);
        while (result === TAIL) result = runtime.runTail();
        runtime.flush();
        return Object.freeze({
          values: Object.freeze(resultValues(prepared.fn.results, result, runtime)),
          steps: runtime.steps,
        });
      } catch (cause) {
        faulted = true;
        try {
          runtime.flush();
        } catch {
          // The unwind below carries the original cause.
        }
        if (cause instanceof JitUnwind) {
          throw wrapExecutionError(
            cause.cause,
            prepared.context,
            [...cause.frames].reverse(),
            cause.steps,
          );
        }
        throw wrapExecutionError(cause, prepared.context, [], runtime.steps);
      }
    },
  };
}

const CONFIG: ParityConfig = Object.freeze({
  name: 'jit-scalar-opt',
  create: createOptimizedInterpreter,
});

const PROFILES: readonly RandomProfile[] = [
  'default',
  'float-heavy',
  'deep-recursion',
  'storage-heavy',
];

describe('optimized JIT parity smoke test', () => {
  it('executes an inserted LICM preheader with the reference step count', () => {
    const module = createIRModule();
    const fn = module.func('multi', { params: ['bool', 'u32'], results: ['u32'] });
    fn.body((b, [flag, factor]) => {
      const limit = b.const('u32', 10);
      const two = b.const('u32', 2);
      const left = b.block([]);
      const right = b.block([]);
      const head = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block(['u32']);
      b.branch(flag, { target: left, args: [] }, { target: right, args: [] });
      b.at(left, (b) => b.jump(head, [b.const('u32', 0)]));
      b.at(right, (b) => b.jump(head, [b.const('u32', 1)]));
      b.at(head, (b, [index]) =>
        b.branch(
          b.int.cmp('lt', index, limit),
          { target: body, args: [index] },
          { target: done, args: [index] },
        ),
      );
      b.at(body, (b, [index]) => b.jump(head, [b.int.add(index, b.int.mul(factor, two))]));
      b.at(done, (b, [index]) => b.return([index]));
    });
    const instructions = [...CORE_INSTRUCTION_NAMES];
    const validation = {
      supportedInstructions: instructions,
      authorizedInstructions: instructions,
      resources: [],
    };
    const reference = createIRInterpreter(module, { validation });
    const optimized = createOptimizedInterpreter(module, { validation });
    for (const args of [
      [true, 3],
      [false, 3],
      [true, 12],
      [false, 1],
    ] as const) {
      expect(optimized.execute(fn, args, CONTEXT)).toEqual(reference.execute(fn, args, CONTEXT));
    }
  });

  it.each(PROFILES)(
    'matches the reference for 40 %s programs without providers',
    (profile) => {
      for (let seed = 501; seed < 541; seed += 1) {
        const program = randomProgram({ seed, profile, provider: false });
        const divergence = runOracle(program, [REFERENCE_CONFIG, CONFIG]);
        if (divergence !== undefined) {
          throw new Error(JSON.stringify(divergence, null, 2));
        }
      }
    },
    120_000,
  );
});
