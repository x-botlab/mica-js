import { describe, expect, it } from 'vitest';
import { createIRModule } from '../index';
import { createLowerContext, lowerFunction, Op } from './mir';
import type { MFunction } from './mir';
import { assertStepInvariant, verifyMIR } from './verify';

function validFunction() {
  const module = createIRModule();
  const counter = module.state('counter', 'u32', 0);
  const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
  helper.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
  const fn = module.func('valid', { params: ['u32', 'bool'], results: ['u32'] });
  fn.body((b, [value, condition]) => {
    const one = b.const('u32', 1);
    const added = b.int.add(value, one);
    const called = b.call(helper, [added])[0]!;
    const yes = b.block(['u32']);
    const no = b.block(['u32']);
    b.branch(condition, { target: yes, args: [called] }, { target: no, args: [added] });
    b.at(yes, (b, [item]) => {
      b.state.store(counter, item);
      b.return([item]);
    });
    b.at(no, (b, [item]) => b.return([item]));
  });
  return { module, fn, counter, helper };
}

function lowered(): {
  module: ReturnType<typeof validFunction>;
  mir: MFunction;
  context: ReturnType<typeof createLowerContext>;
} {
  const fixture = validFunction();
  const context = createLowerContext(fixture.module);
  const mir = lowerFunction(context, fixture.fn);
  return { module: fixture, mir, context };
}

function expectFailure(run: () => void, pattern: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/^MIR verification failed: /);
  expect((caught as Error).message).toMatch(pattern);
}

describe('verifyMIR', () => {
  it('accepts well-formed MIR with and without a lowering context', () => {
    const { mir, context } = lowered();
    expect(() => verifyMIR(mir)).not.toThrow();
    expect(() => verifyMIR(mir, context)).not.toThrow();
    expect(() => assertStepInvariant(mir)).not.toThrow();
  });

  it('rejects duplicate definitions and out-of-range values', () => {
    const duplicate = lowered();
    duplicate.mir.blocks[0]!.insts[1]!.results.push(duplicate.mir.blocks[0]!.params[0]!);
    expectFailure(() => verifyMIR(duplicate.mir), /defined more than once/);

    const missing = lowered();
    missing.mir.blocks[0]!.insts[0]!.args = [99];
    expectFailure(() => verifyMIR(missing.mir), /v99 is not defined/);
  });

  it('rejects type and edge mismatches', () => {
    const type = lowered();
    const add = type.mir.blocks[0]!.insts.find((inst) => inst.op === Op.IntAdd)!;
    add.args[0] = type.mir.blocks[0]!.params[1]!;
    expectFailure(() => verifyMIR(type.mir), /int\.add/);

    const edge = lowered();
    const branch = edge.mir.blocks[0]!.term;
    if (branch.kind !== 'branch') throw new Error('expected branch');
    (branch.yes as { args: readonly number[] }).args = [];
    expectFailure(() => verifyMIR(edge.mir), /passes 0 argument/);
  });

  it('rejects missing terminators, wrong steps and stale locations', () => {
    const missingTerm = lowered();
    Object.assign(missingTerm.mir.blocks[1]!, { term: undefined });
    expectFailure(() => verifyMIR(missingTerm.mir), /has no terminator/);

    const steps = lowered();
    (steps.mir.blocks[0]!.insts[0] as unknown as { step: 0 | 1 }).step = 0;
    expectFailure(() => verifyMIR(steps.mir), /accounts for/);
    expect(() => assertStepInvariant(steps.mir)).toThrow(/MIR verification failed/);

    const location = lowered();
    (location.mir.blocks[0]!.insts[0] as unknown as { loc: number }).loc =
      location.mir.blocks[0]!.term.loc;
    expectFailure(() => verifyMIR(location.mir), /loc does not point at its source instruction/);
  });

  it('rejects a value used outside the definition dominant region', () => {
    const module = createIRModule();
    const fn = module.func('invalid', { params: ['bool', 'u32'], results: ['u32'] });
    fn.body((b, [condition, value]) => {
      const yes = b.block([]);
      const no = b.block([]);
      const join = b.block(['u32']);
      let defined: import('../types').Value<'u32'> | undefined;
      b.branch(condition, { target: yes, args: [] }, { target: no, args: [] });
      b.at(yes, (b) => {
        defined = b.int.add(value, b.const('u32', 1));
        b.jump(join, [defined]);
      });
      b.at(no, (b) => b.jump(join, [defined!]));
      b.at(join, (b, [result]) => b.return([result]));
    });
    const mir = lowerFunction(createLowerContext(module), fn);
    expectFailure(() => verifyMIR(mir), /is defined in b1 but used in b2/);
  });

  it('rejects callee indices outside the model when a context is supplied', () => {
    const { mir, context } = lowered();
    const call = mir.blocks[0]!.insts.find((inst) => inst.op === Op.Call)!;
    (call as unknown as { refs: readonly number[] }).refs = [99];
    expect(() => verifyMIR(mir)).not.toThrow();
    expectFailure(() => verifyMIR(mir, context), /call target 99 is not in the model/);
  });

  it('reports every violation in one message', () => {
    const { mir } = lowered();
    mir.blocks[0]!.insts[0]!.args = [123];
    (mir.blocks[0]!.insts[1] as unknown as { step: 0 | 1 }).step = 0;
    expect(() => verifyMIR(mir)).toThrow(/v123 is not defined.*accounts for|accounts for.*v123/);
  });
});
