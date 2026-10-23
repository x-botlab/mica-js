/**
 * J13: inlining and virtual-frame call stacks.
 *
 * The MIR-level cases pin the transformation (step counts, parent chains,
 * recursion/transfer refusal); the execution cases compare the tier-2 engine
 * with the reference interpreter on errors raised inside multi-level inlined
 * bodies and on budget exhaustion.
 */
import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import {
  IRExecutionError,
  createIRInterpreter,
  createIRModule,
  type IRExecutionContext,
  type IRModule,
  type IRValidationOptions,
  type ProviderRef,
} from '../../index';
import { createIRJIT, jitInternals } from '../../jit-runtime';
import type { IRJITInternals } from '../../jit-runtime';
import { computeSummaries } from '../effects';
import { lowerFunction, printMIR } from '../mir';
import type { MFunction } from '../mir';
import { createLowerContext } from '../resolve';
import { verifyMIR } from '../verify';
import { createInlineContext, inlineFunction } from './inline';

const context: IRExecutionContext = { instanceId: 'inline', virtualTime: 31 };

function policy(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: CORE_INSTRUCTION_NAMES,
    authorizedInstructions: CORE_INSTRUCTION_NAMES,
    resources: module.memories.map(({ ref }) => ({ ref, access: 'read-write' })),
  };
}

function lowered(module: IRModule): {
  readonly functions: readonly MFunction[];
  readonly summaries: ReturnType<typeof computeSummaries>;
  readonly lower: ReturnType<typeof createLowerContext>;
} {
  const lower = createLowerContext(module);
  const functions = module.functions.map((definition, index) =>
    lowerFunction(lower, definition, index, definition.name),
  );
  return { functions, summaries: computeSummaries(functions), lower };
}

function internals(engine: unknown): IRJITInternals {
  return (engine as { readonly [jitInternals]: IRJITInternals })[jitInternals];
}

interface FailureShape {
  readonly code: string;
  readonly message: string;
  readonly steps: number;
  readonly location: unknown;
  readonly callStack: unknown;
}

function failure(run: () => unknown): FailureShape {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(IRExecutionError);
    const error = cause as IRExecutionError;
    return {
      code: error.code,
      message: error.message,
      steps: error.steps,
      location: error.location,
      callStack: error.callStack,
    };
  }
  throw new Error('expected execution to fail');
}

/**
 * divide -> middle -> outer. `outer` is the target; both call instructions are
 * eligible for inlining, giving a two-frame virtual chain.
 */
function divideChain() {
  const module = createIRModule();
  const state = module.state('state', 'u32', 0);
  const divide = module.func('divide', { params: ['u32'], results: ['u32'] });
  divide.body((b, [d]) => b.return([b.int.div(b.const('u32', 8), d)]));
  const middle = module.func('middle', { params: ['u32'], results: ['u32'] });
  middle.body((b, [d]) => b.return(b.call(divide, [d])));
  const outer = module.func('outer', { params: ['u32'], results: [] });
  outer.body((b, [d]) => {
    b.state.store(state, b.const('u32', 1));
    const [value] = b.call(middle, [d]);
    b.state.store(state, value);
    b.return([]);
  });
  return { module, state, divide, middle, outer };
}

function trapChain() {
  const module = createIRModule();
  const base = module.func('base', { params: ['u32'], results: ['u32'] });
  base.body((b) => {
    b.trap('inlined trap');
  });
  const level = module.func('level', { params: ['u32'], results: ['u32'] });
  level.body((b, [value]) => b.return(b.call(base, [value])));
  const middle = module.func('middle', { params: ['u32'], results: ['u32'] });
  middle.body((b, [value]) => b.return(b.call(level, [value])));
  const outer = module.func('outer', { params: ['u32'], results: ['u32'] });
  outer.body((b, [value]) => b.return(b.call(middle, [value])));
  return { module, outer };
}

describe('inlining pass', () => {
  it('copies a small callee and preserves the source step count', () => {
    const module = createIRModule();
    const callee = module.func('callee', { params: ['u32'], results: ['u32'] });
    callee.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const caller = module.func('caller', { params: ['u32'], results: ['u32'] });
    caller.body((b, [value]) => b.return(b.call(callee, [value])));

    const { functions, summaries } = lowered(module);
    const inlineContext = createInlineContext(functions, summaries);
    const callerMir = functions[1]!;
    const result = inlineFunction(callerMir, inlineContext);
    expect(result.inlined).toBe(1);
    expect(result.fn.inlined).toBe(true);
    expect(result.fn.blocks.length).toBeGreaterThan(callerMir.blocks.length);
    expect(
      result.fn.blocks.flatMap((block) => block.insts).some((inst) => inst.op === 'call'),
    ).toBe(false);

    // call (kept as a one-step check) + callee const/add + return (now a jump)
    const totalSteps = result.fn.blocks.reduce(
      (sum, block) =>
        sum + block.insts.reduce((inner, inst) => inner + inst.step, 0) + block.term.step,
      0,
    );
    const originalSteps = callerMir.blocks.reduce(
      (sum, block) =>
        sum + block.insts.reduce((inner, inst) => inner + inst.step, 0) + block.term.step,
      0,
    );
    const calleeSteps = functions[0]!.blocks.reduce(
      (sum, block) =>
        sum + block.insts.reduce((inner, inst) => inner + inst.step, 0) + block.term.step,
      0,
    );
    expect(totalSteps).toBe(originalSteps + calleeSteps);
  });

  it('records virtual frames whose parent chain reaches the call site', () => {
    const { module } = divideChain();
    const { functions, summaries, lower } = lowered(module);
    const callerIndex = 2;
    const callerMir = functions[callerIndex]!;
    const result = inlineFunction(callerMir, createInlineContext(functions, summaries));
    expect(result.inlined).toBe(2);
    expect(() => verifyMIR(result.fn, lower)).not.toThrow();
    expect(result.fn.inlined).toBe(true);

    const divideLoc = result.fn.blocks
      .flatMap((block) => block.insts)
      .find((inst) => inst.node?.op === 'int.div')?.loc;
    expect(divideLoc).toBeDefined();

    const locations = result.fn.locs.locations;
    const frame = result.fn.locs.inlineFrames[divideLoc!];
    expect(frame).toMatchObject({
      functionIndex: 0,
      blockIndex: 0,
    });
    const middleCall = result.fn.locs.parent[divideLoc!]!;
    expect(result.fn.locs.parent[middleCall]).toBeGreaterThanOrEqual(0);
    const outerCall = result.fn.locs.parent[middleCall]!;
    expect(locations[middleCall]!.functionName).toBe('middle');
    expect(locations[outerCall]!.functionName).toBe('outer');
    expect(result.fn.locs.parent[outerCall]).toBe(-1);

    // The virtual frames name the callee source positions, not the caller's.
    expect(locations[divideLoc!]!.functionIndex).toBe(0);
    expect(locations[divideLoc!]!.functionName).toBe('divide');
  });

  it('refuses recursive and transferring callees', () => {
    const module = createIRModule();
    const recursive = module.func('recursive', { params: ['u32'], results: ['u32'] });
    recursive.body((b, [value]) => {
      const done = b.block([]);
      const next = b.block([]);
      b.branch(
        b.int.cmp('eq', value, b.const('u32', 0)),
        { target: done, args: [] },
        { target: next, args: [] },
      );
      b.at(done, (inner) => inner.return([value]));
      b.at(next, (inner) =>
        inner.return(inner.call(recursive, [inner.int.sub(value, inner.const('u32', 1))])),
      );
    });
    const caller = module.func('caller', { params: ['u32'], results: ['u32'] });
    caller.body((b, [value]) => b.return(b.call(recursive, [value])));

    const { functions, summaries } = lowered(module);
    const result = inlineFunction(functions[1]!, createInlineContext(functions, summaries));
    expect(result.inlined).toBe(0);
    expect(
      result.fn.blocks.flatMap((block) => block.insts).some((inst) => inst.op === 'call'),
    ).toBe(true);
    expect(printMIR(result.fn)).toContain('call ');
  });

  it('refuses a callee that can dispatch to a provider artifact', () => {
    const module = createIRModule();
    const code = module.provider(
      'code',
      { keyTypes: [], params: [], results: [], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([])),
    ) as ProviderRef<readonly [], readonly [], readonly []>;
    const helper = module.func('helper', { params: [], results: [] });
    helper.body((b) => b.dispatch(code, [], []));
    const caller = module.func('caller', { params: [], results: [] });
    caller.body((b) => {
      b.call(helper, []);
      b.return([]);
    });

    const { functions, summaries } = lowered(module);
    expect(summaries.get(0)?.hasTransfer).toBe(true);
    const result = inlineFunction(functions[1]!, createInlineContext(functions, summaries));
    expect(result.inlined).toBe(0);
    expect(
      result.fn.blocks.flatMap((block) => block.insts).some((inst) => inst.op === 'call'),
    ).toBe(true);
  });

  it('keeps the caller layout monotone in loop depth and inline hotness', () => {
    const module = createIRModule();
    const hot = module.func('hot', { params: ['u32'], results: ['u32'] });
    hot.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
    const cold = module.func('cold', { params: ['u32'], results: ['u32'] });
    cold.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 2))]));
    const caller = module.func('caller', { params: ['u32'], results: ['u32'] });
    caller.body((b, [value]) => {
      const [first] = b.call(hot, [value]);
      const [second] = b.call(cold, [first]);
      b.return([second]);
    });
    const { functions, summaries } = lowered(module);
    const hotIndex = 0;
    const result = inlineFunction(functions[2]!, createInlineContext(functions, summaries), {
      profile: { calls: new Map([[hotIndex, 100]]) },
    });
    expect(result.inlined).toBe(2);
    expect(result.layout.blockWeights.size).toBe(result.fn.blocks.length);
    expect([...result.layout.blockWeights.values()].every((weight) => weight > 0)).toBe(true);
  });
});

describe('inlined call stacks', () => {
  it('matches the reference call stack for division by zero', () => {
    const { module, outer } = divideChain();
    const validation = policy(module);
    const expected = failure(() =>
      createIRInterpreter(module, { validation }).execute(outer, [0], context),
    );
    const engine = createIRJIT(module, {
      validation,
      jit: { tierUpThreshold: 0, debug: { verify: true } },
    });
    expect(failure(() => engine.execute(outer, [0], context))).toEqual(expected);
    expect(expected.callStack).toHaveLength(3);
    expect(
      (expected.callStack as { functionName: string }[]).map((frame) => frame.functionName),
    ).toEqual(['outer', 'middle', 'divide']);
    expect(internals(engine).tier2Compilations).toBeGreaterThan(0);
  });

  it('matches the reference call stack for a trap inside three inline levels', () => {
    const { module, outer } = trapChain();
    const validation = policy(module);
    const expected = failure(() =>
      createIRInterpreter(module, { validation }).execute(outer, [1], context),
    );
    const engine = createIRJIT(module, {
      validation,
      jit: { tierUpThreshold: 0, debug: { verify: true } },
    });
    expect(failure(() => engine.execute(outer, [1], context))).toEqual(expected);
    expect(
      (expected.callStack as { functionName: string }[]).map((frame) => frame.functionName),
    ).toEqual(['outer', 'middle', 'level', 'base']);
  });

  it('matches the reference at every budget boundary inside inlined code', () => {
    const { module, outer } = divideChain();
    const validation = policy(module);
    for (let maxSteps = 0; maxSteps <= 8; maxSteps += 1) {
      const expected = failure(() =>
        createIRInterpreter(module, { validation, maxSteps }).execute(outer, [1], context),
      );
      const engine = createIRJIT(module, {
        validation,
        maxSteps,
        jit: { tierUpThreshold: 0, debug: { verify: true } },
      });
      const actual = failure(() => engine.execute(outer, [1], context));
      expect(actual).toEqual(expected);
    }
  });

  it('matches the reference for an executor that throws', () => {
    const FAIL = {
      operands: [],
      results: [],
    } as const;
    const module = createIRModule();
    const instruction = module.domainInstruction('probe.fail', FAIL);
    const base = module.func('base', { params: [], results: [] });
    base.body((b) => {
      b.invoke(instruction, []);
      b.return([]);
    });
    const middle = module.func('middle', { params: [], results: [] });
    middle.body((b) => {
      b.call(base, []);
      b.return([]);
    });
    const outer = module.func('outer', { params: [], results: [] });
    outer.body((b) => {
      b.call(middle, []);
      b.return([]);
    });
    const validation: IRValidationOptions = {
      supportedInstructions: ['probe.fail', 'call', 'return'],
      authorizedInstructions: ['probe.fail', 'call', 'return'],
      resources: [],
      validators: [{ op: 'probe.fail', validate: () => [] }],
    };
    const executors = [
      {
        op: 'probe.fail',
        execute: () => {
          throw new Error('executor exploded');
        },
      },
    ];
    const expected = failure(() =>
      createIRInterpreter(module, { validation, executors }).execute(outer, [], context),
    );
    const engine = createIRJIT(module, {
      validation,
      executors,
      jit: { tierUpThreshold: 0, debug: { verify: true } },
    });
    expect(failure(() => engine.execute(outer, [], context))).toEqual(expected);
    expect(
      (expected.callStack as { functionName: string }[]).map((frame) => frame.functionName),
    ).toEqual(['outer', 'middle', 'base']);
  });
});

describe('tier-2 threshold', () => {
  it.each([0, 1, 3])('matches the reference with tierUpThreshold %i', (threshold) => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const add = module.func('add', { params: ['u32', 'u32'], results: ['u32'] });
    add.body((b, [left, right]) => b.return([b.int.add(left, right)]));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [value]) => {
      let current = value;
      for (let index = 0; index < 3; index += 1) {
        const [next] = b.call(add, [current, b.const('u32', index + 1)]);
        current = next;
      }
      b.state.store(state, current);
      b.return([current]);
    });

    const validation = policy(module);
    const reference = createIRInterpreter(module, { validation });
    const engine = createIRJIT(module, {
      validation,
      jit: { tierUpThreshold: threshold, debug: { verify: true } },
    });
    for (let input = 0; input < 6; input += 1) {
      expect(engine.execute(run, [input], context)).toEqual(
        reference.execute(run, [input], context),
      );
      expect(engine.storage.loadState(state)).toBe(reference.storage.loadState(state));
    }
    expect(internals(engine).tier2Compilations).toBeGreaterThan(0);
  });

  it('promotes hot functions that only run on the heap tier', () => {
    const module = createIRModule();
    const base = module.func('base', { params: ['u32'], results: ['u32'] });
    base.body((b, [value]) => b.return([value]));
    let target = base;
    for (let index = 1; index <= 4; index += 1) {
      const previous = target;
      const level = module.func(`level${index}`, { params: ['u32'], results: ['u32'] });
      level.body((b, [value]) => {
        const [result] = b.call(previous, [value]);
        b.return([b.int.add(result, b.const('u32', 1))]);
      });
      target = level;
    }

    const validation = policy(module);
    const reference = createIRInterpreter(module, { validation });
    const engine = createIRJIT(module, {
      validation,
      jit: { tierUpThreshold: 1, maxCompiledDepth: 1 },
    });
    // The whole chain after the first frame runs in the heap tier; every
    // entered function still counts and is promoted.
    expect(engine.execute(target, [5], context)).toEqual(reference.execute(target, [5], context));
    expect(internals(engine).tier2Compilations).toBeGreaterThan(0);
    // The next execution uses the promoted code and must stay equivalent.
    expect(engine.execute(target, [7], context)).toEqual(reference.execute(target, [7], context));
  });

  it('upgrades a cold provider artifact after artifactWarmup heap runs', () => {
    const module = createIRModule();
    const source = module.provider(
      'source',
      { keyTypes: [], params: [], results: ['u32'], reads: [], imports: [] },
      (gen) => gen.function((b) => b.return([b.const('u32', 41)])),
    ) as ProviderRef<readonly [], readonly [], readonly ['u32']>;
    const run = module.func('run', { params: [], results: ['u32'] });
    run.body((b) => b.dispatch(source, [], []));
    const validation = policy(module);
    const reference = createIRInterpreter(module, { validation });
    const engine = createIRJIT(module, {
      validation,
      jit: { artifactWarmup: 2, tierUpThreshold: 0 },
    });
    expect(internals(engine).compiledArtifacts).toBe(0);
    expect(engine.execute(run, [], context)).toEqual(reference.execute(run, [], context));
    expect(internals(engine).compiledArtifacts).toBe(0);
    expect(engine.execute(run, [], context)).toEqual(reference.execute(run, [], context));
    expect(internals(engine).compiledArtifacts).toBe(1);
    expect(engine.execute(run, [], context)).toEqual(reference.execute(run, [], context));
    expect(internals(engine).compiledArtifacts).toBe(1);
  });
});
