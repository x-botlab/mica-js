import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { createIRModule } from '../../index';
import { IRExecutionError, createIRInterpreter } from '../../interpreter';
import type { IRExecutionContext, IRInterpreterOptions } from '../../interpreter';
import type { FunctionRef, IRModule, RuntimeScalar, ScalarType } from '../../types';
import type { IRValidationOptions } from '../../validation-types';
import { analyzeCFG } from '../cfg';
import { Op, printMIR } from '../mir';
import type { MFunction } from '../mir';
import { compileModule } from '../testing/compile-module';
import type { CompiledModule } from '../testing/compile-module';
import { lower, verified } from './helpers';
import { optimizeFunction } from './loop-unroll';
import { runOptimizationPipeline } from './pipeline';
import type { OptimizationSwitches } from './pipeline';

const CONTEXT: IRExecutionContext = Object.freeze({ instanceId: 'unroll', virtualTime: 0 });

const ONLY_UNROLL: OptimizationSwitches = {
  sccp: false,
  gvn: false,
  range: false,
  licm: false,
  unroll: true,
  dce: false,
};

const ALL_BUT_UNROLL: OptimizationSwitches = { ...ONLY_UNROLL, unroll: false };

/** Block ids reachable from the entry, i.e. the blocks code generation emits. */
function reachable(fn: MFunction): Set<number> {
  return new Set(analyzeCFG(fn).cfg.order);
}

function reachableCount(fn: MFunction, op: Op): number {
  const live = reachable(fn);
  let count = 0;
  for (const block of fn.blocks) {
    if (!live.has(block.id)) continue;
    count += block.insts.filter((inst) => inst.op === op).length;
  }
  return count;
}

interface LoopFixture {
  readonly module: IRModule;
  readonly fn: FunctionRef<readonly ScalarType[], readonly ScalarType[]>;
  readonly mir: MFunction;
}

/**
 * A canonical counted loop: `for (i = start; i < start + trips; i += 1)`,
 * accumulating `acc += i * 3`. `extra` adds filler pairs, so the size policy
 * can be exercised.
 */
function pureLoop(
  trips: number,
  options: { readonly start?: number; readonly extra?: number } = {},
): LoopFixture {
  const start = options.start ?? 0;
  const extra = options.extra ?? 0;
  const module = createIRModule();
  const fn = module.func('counted', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const from = b.const('u32', start);
    const bound = b.const('u32', start + trips);
    const three = b.const('u32', 3);
    const one = b.const('u32', 1);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [from, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, bound),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) => {
      let value = inner.int.add(acc, inner.int.mul(index, three));
      for (let filler = 0; filler < extra; filler += 1) {
        value = inner.int.add(value, inner.const('u32', filler + 1));
      }
      inner.jump(head, [inner.int.add(index, one), value]);
    });
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

/** A descending counted loop: `for (i = trips; i > 0; i -= 1)`. */
function descendingLoop(trips: number): LoopFixture {
  const module = createIRModule();
  const fn = module.func('down', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const from = b.const('u32', trips);
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [from, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('gt', index, zero),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) =>
      inner.jump(head, [inner.int.sub(index, one), inner.int.add(acc, index)]),
    );
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

/** A loop whose body calls another function: host effect, never unrolled. */
function callLoop(): LoopFixture {
  const module = createIRModule();
  const helper = module.func('helper', { params: ['u32'], results: ['u32'] });
  helper.body((b, [value]) => b.return([b.int.add(value, b.const('u32', 1))]));
  const fn = module.func('caller', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const zero = b.const('u32', 0);
    const bound = b.const('u32', 4);
    const one = b.const('u32', 1);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [zero, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, bound),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) => {
      const [value] = inner.call(helper, [acc]);
      inner.jump(head, [inner.int.add(index, one), value]);
    });
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

/** A loop whose body divides: a value error at a source location, never unrolled. */
function throwingLoop(): LoopFixture {
  const module = createIRModule();
  const fn = module.func('divides', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const zero = b.const('u32', 0);
    const bound = b.const('u32', 4);
    const two = b.const('u32', 2);
    const one = b.const('u32', 1);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [zero, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, bound),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) =>
      inner.jump(head, [inner.int.add(index, one), inner.int.div(acc, two)]),
    );
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

/** A loop body with a diamond, so the natural loop has more than two blocks. */
function diamondLoop(): LoopFixture {
  const module = createIRModule();
  const fn = module.func('diamond', { params: ['u32'], results: ['u32'] });
  fn.body((b, [seed]) => {
    const zero = b.const('u32', 0);
    const bound = b.const('u32', 4);
    const one = b.const('u32', 1);
    const two = b.const('u32', 2);
    const nine = b.const('u32', 9);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const left = b.block(['u32', 'u32']);
    const right = b.block(['u32', 'u32']);
    const merge = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [zero, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, bound),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, two),
        { target: left, args: [index, acc] },
        { target: right, args: [index, acc] },
      ),
    );
    b.at(left, (inner, [index, acc]) => inner.jump(merge, [index, inner.int.add(acc, nine)]));
    b.at(right, (inner, [index, acc]) => inner.jump(merge, [index, inner.int.sub(acc, nine)]));
    b.at(merge, (inner, [index, acc]) => inner.jump(head, [inner.int.add(index, one), acc]));
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

/** A loop whose bound is a runtime parameter: no compile-time trip count. */
function dynamicLoop(): LoopFixture {
  const module = createIRModule();
  const fn = module.func('dynamic', { params: ['u32', 'u32'], results: ['u32'] });
  fn.body((b, [limit, seed]) => {
    const zero = b.const('u32', 0);
    const one = b.const('u32', 1);
    const head = b.block(['u32', 'u32']);
    const body = b.block(['u32', 'u32']);
    const done = b.block(['u32']);
    b.jump(head, [zero, seed]);
    b.at(head, (inner, [index, acc]) =>
      inner.branch(
        inner.int.cmp('lt', index, limit),
        { target: body, args: [index, acc] },
        { target: done, args: [acc] },
      ),
    );
    b.at(body, (inner, [index, acc]) =>
      inner.jump(head, [inner.int.add(index, one), inner.int.add(acc, index)]),
    );
    b.at(done, (inner, [acc]) => inner.return([acc]));
  });
  return { module, fn, mir: lower(module, fn) };
}

function validationFor(module: IRModule): IRValidationOptions {
  return {
    supportedInstructions: [...CORE_INSTRUCTION_NAMES],
    authorizedInstructions: [...CORE_INSTRUCTION_NAMES],
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    })),
  };
}

function transform(switches: OptimizationSwitches | undefined) {
  return (mir: MFunction): MFunction =>
    switches === undefined
      ? runOptimizationPipeline(mir, { passes: { unroll: true } })
      : runOptimizationPipeline(mir, { passes: switches });
}

/** Compile a module with one optimizer configuration. */
function engine(
  module: IRModule,
  switches: OptimizationSwitches | undefined,
  options: Partial<IRInterpreterOptions> = {},
): CompiledModule {
  return compileModule(
    module,
    { validation: validationFor(module), ...options },
    { transform: transform(switches) },
  );
}

function outcomeOf(
  run: () => { readonly values: readonly RuntimeScalar[]; readonly steps: number },
): unknown {
  try {
    const result = run();
    return { values: result.values, steps: result.steps };
  } catch (error) {
    if (error instanceof IRExecutionError) return { code: error.code, steps: error.steps };
    throw error;
  }
}

describe('loop unrolling', () => {
  it('leaves the input MIR untouched', () => {
    const { mir } = pureLoop(4);
    const before = printMIR(mir);
    optimizeFunction(mir);
    expect(printMIR(mir)).toBe(before);
  });

  it.each([0, 1, 2, 3, 4])('fully unrolls a %i-trip loop', (trips) => {
    const input = pureLoop(trips);
    const output = verified(optimizeFunction(input.mir));

    // The loop is gone: no back edge survives.
    expect(analyzeCFG(output).loops).toHaveLength(0);
    // `trips` copies plus the final header visit; the dead original stays for DCE.
    expect(output.blocks.length).toBe(input.mir.blocks.length + trips + 1);
    // One header compare per visit, all but the last statically taken.
    expect(reachableCount(output, Op.IntCmp)).toBe(trips + 1);
    // One body copy per trip.
    expect(reachableCount(output, Op.IntMul)).toBe(trips);
    // Each taken header branch keeps its step as a synthetic check.
    expect(reachableCount(output, Op.Check)).toBe(trips);
  });

  it('jumps straight to the exit for a zero-trip loop', () => {
    const input = pureLoop(0);
    const output = verified(optimizeFunction(input.mir));
    const entry = output.blocks[0]!;
    const term = entry.term;
    expect(term.kind).toBe('jump');
    if (term.kind === 'jump') {
      const target = output.blocks.find((block) => block.id === term.target)!;
      // The inserted final header visit forwards the exit argument unchanged.
      expect(target.term.kind).toBe('jump');
      expect(reachableCount(output, Op.IntMul)).toBe(0);
    }
  });

  it.each([
    [8, 2],
    [16, 4],
  ])('partially unrolls %i trips into %i groups of four', (trips, groups) => {
    const input = pureLoop(trips);
    const output = verified(optimizeFunction(input.mir));

    // The loop survives: one compare and one branch per group.
    expect(analyzeCFG(output).loops).toHaveLength(1);
    expect(reachableCount(output, Op.IntCmp)).toBe(1);
    // Four body copies per group.
    expect(reachableCount(output, Op.IntMul)).toBe(4);
    // Three replaced header visits per group, two steps each (compare + branch).
    expect(reachableCount(output, Op.Check)).toBe(3 * 2);
    // The loop still runs `groups` times: the back edge adds four per iteration.
    const header = output.blocks.find((block) => block.id === 1)!;
    expect(header.term.kind).toBe('branch');
    expect(groups).toBe(trips / 4);
  });

  it('threads the induction variable through the replicated bodies', () => {
    const output = verified(optimizeFunction(pureLoop(8).mir));
    // Every replicated body receives the advanced index, so the accumulator
    // chain is four multiplications deep.
    const muls = output.blocks
      .filter((block) => reachable(output).has(block.id))
      .flatMap((block) => block.insts.filter((inst) => inst.op === Op.IntMul));
    expect(muls).toHaveLength(4);
    expect(new Set(muls.map((inst) => inst.results[0])).size).toBe(4);
  });

  it('descends a decreasing induction variable', () => {
    const input = descendingLoop(4);
    const output = verified(optimizeFunction(input.mir));
    expect(analyzeCFG(output).loops).toHaveLength(0);
    expect(reachableCount(output, Op.IntSub)).toBe(4);
  });

  it('leaves a body with host effects alone', () => {
    const input = callLoop();
    expect(verified(optimizeFunction(input.mir))).toBe(input.mir);
  });

  it('leaves a throwing body alone', () => {
    const input = throwingLoop();
    expect(verified(optimizeFunction(input.mir))).toBe(input.mir);
  });

  it('leaves a loop with more than two blocks alone', () => {
    const input = diamondLoop();
    expect(verified(optimizeFunction(input.mir))).toBe(input.mir);
  });

  it('leaves a runtime bound alone', () => {
    const input = dynamicLoop();
    expect(verified(optimizeFunction(input.mir))).toBe(input.mir);
  });

  it('leaves an iteration over 50 instructions alone', () => {
    const input = pureLoop(4, { extra: 25 });
    const body = input.mir.blocks[2]!;
    expect(body.insts.length).toBeGreaterThan(50);
    expect(verified(optimizeFunction(input.mir))).toBe(input.mir);
  });

  it('downgrades to partial unrolling when a full unroll exceeds the growth budget', () => {
    const input = pureLoop(4, { extra: 2 });
    const body = input.mir.blocks[2]!;
    // Full: five header copies plus four body copies; partial (factor 2):
    // two body copies plus one header placeholder set.
    const budget = body.insts.length * 2 + 2;
    expect(budget).toBeGreaterThan(body.insts.length * 2 + 1);
    const output = verified(optimizeFunction(input.mir, { growthBudget: budget }));
    expect(analyzeCFG(output).loops).toHaveLength(1);
    expect(reachableCount(output, Op.IntMul)).toBe(2);
  });

  it('refuses both plans when the growth budget is too small', () => {
    const input = pureLoop(4, { extra: 2 });
    expect(verified(optimizeFunction(input.mir, { growthBudget: 2 }))).toBe(input.mir);
  });

  it('spends one allowance across the whole function', () => {
    // Two identical four-trip loops: the first consumes the allowance, so the
    // second is left alone even though it would fit on its own.
    const module = createIRModule();
    const fn = module.func('twice', { params: ['u32'], results: ['u32'] });
    fn.body((b, [seed]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const bound = b.const('u32', 4);
      const three = b.const('u32', 3);
      const heads = [b.block(['u32', 'u32']), b.block(['u32', 'u32'])];
      const bodies = [b.block(['u32', 'u32']), b.block(['u32', 'u32'])];
      const dones = [b.block(['u32']), b.block(['u32'])];
      b.jump(heads[0]!, [zero, seed]);
      heads.forEach((_head, index) => {
        const head = heads[index]!;
        const body = bodies[index]!;
        const done = dones[index]!;
        const next = heads[index + 1];
        b.at(head, (inner, [cursor, acc]) =>
          inner.branch(
            inner.int.cmp('lt', cursor, bound),
            { target: body, args: [cursor, acc] },
            { target: done, args: [acc] },
          ),
        );
        b.at(body, (inner, [cursor, acc]) =>
          inner.jump(head, [
            inner.int.add(cursor, one),
            inner.int.add(acc, inner.int.mul(cursor, three)),
          ]),
        );
        b.at(done, (inner, [acc]) =>
          next === undefined ? inner.return([acc]) : inner.jump(next, [zero, acc]),
        );
      });
    });
    const mir = lower(module, fn);
    // One full unroll of a four-trip loop with a three-instruction body costs 17.
    const output = verified(optimizeFunction(mir, { growthBudget: 17 }));
    // Four copies of the first loop's body plus the second loop's single body.
    expect(reachableCount(output, Op.IntMul)).toBe(5);
    expect(analyzeCFG(output).loops).toHaveLength(1);
  });

  it('is removed from the pipeline when switched off', () => {
    const input = pureLoop(4);
    expect(runOptimizationPipeline(input.mir, { passes: ALL_BUT_UNROLL })).toBe(input.mir);
  });

  it('lets DCE drop the superseded loop blocks', () => {
    const input = pureLoop(4);
    const output = verified(
      runOptimizationPipeline(input.mir, { passes: { unroll: true, dce: true } }),
    );
    expect(analyzeCFG(output).cfg.unreachable).toHaveLength(0);
    expect(output.blocks.length).toBeLessThan(input.mir.blocks.length + 5);
  });

  it.each([
    ['four trips', pureLoop(4)],
    ['one trip', pureLoop(1)],
    ['zero trips', pureLoop(0)],
    ['partial eight', pureLoop(8)],
    ['partial sixteen', pureLoop(16)],
    ['descending', descendingLoop(3)],
  ])('keeps %s semantically identical and step-exact', (_name, fixture) => {
    const validation = validationFor(fixture.module);
    const reference = createIRInterpreter(fixture.module, { validation });
    const baseline = engine(fixture.module, ALL_BUT_UNROLL);
    const unrolled = engine(fixture.module, ONLY_UNROLL);
    const optimized = engine(fixture.module, undefined);
    for (const seed of [0, 1, 7, 1_000]) {
      const args = [seed] as const;
      const expected = reference.execute(fixture.fn, args, CONTEXT);
      expect(baseline.execute(fixture.fn, args, CONTEXT)).toEqual(expected);
      expect(unrolled.execute(fixture.fn, args, CONTEXT)).toEqual(expected);
      expect(optimized.execute(fixture.fn, args, CONTEXT)).toEqual(expected);
    }
  });

  it('observes exactly the same steps', () => {
    const fixture = pureLoop(4);
    const baselineSteps: number[] = [];
    const unrolledSteps: number[] = [];
    const observer = (log: number[]) => ({ beforeStep: () => log.push(log.length) });
    const baseline = engine(fixture.module, ALL_BUT_UNROLL, {
      stepObserver: observer(baselineSteps),
    });
    const unrolled = engine(fixture.module, ONLY_UNROLL, {
      stepObserver: observer(unrolledSteps),
    });
    const args = [5] as const;
    expect(unrolled.execute(fixture.fn, args, CONTEXT)).toEqual(
      baseline.execute(fixture.fn, args, CONTEXT),
    );
    expect(unrolledSteps).toEqual(baselineSteps);
  });

  it('stops at the same step when the budget runs out', () => {
    const fixture = pureLoop(4);
    const baseline = engine(fixture.module, ALL_BUT_UNROLL, { maxSteps: 7 });
    const unrolled = engine(fixture.module, ONLY_UNROLL, { maxSteps: 7 });
    const args = [5] as const;
    const expected = outcomeOf(() => baseline.execute(fixture.fn, args, CONTEXT));
    expect(expected).toEqual({ code: 'budget-exhausted', steps: 7 });
    expect(outcomeOf(() => unrolled.execute(fixture.fn, args, CONTEXT))).toEqual(expected);
  });
});
