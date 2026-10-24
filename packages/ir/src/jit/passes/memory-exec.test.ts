import { describe, expect, it } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from '../../builder';
import { createIRInterpreter, createIRModule, IRExecutionError } from '../../index';
import type {
  IRExecutionContext,
  IRInterpreter,
  IRInterpreterOptions,
  IRModule,
  IRValidationOptions,
  RuntimeScalar,
} from '../../index';
import { verifyMIR } from '../verify';
import { compileModule } from '../testing/compile-module';
import type { CompiledModule } from '../testing/compile-module';
import { runMemoryPasses } from './index';

const context: IRExecutionContext = Object.freeze({ instanceId: 'j12', virtualTime: 11 });

function policy(module: IRModule, extra: readonly string[] = []): IRValidationOptions {
  const instructions = [...CORE_INSTRUCTION_NAMES, ...extra];
  return {
    supportedInstructions: instructions,
    authorizedInstructions: instructions,
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? ('read-write' as const) : ('read' as const),
    })),
    ...(extra.length === 0 ? {} : { validators: extra.map((op) => ({ op, validate: () => [] })) }),
  };
}

function optimized(
  module: IRModule,
  options: IRInterpreterOptions = { validation: policy(module) },
): CompiledModule {
  return compileModule(module, options, {
    transform: (fn, lower) => {
      runMemoryPasses(fn, { memories: lower.model.memories });
      verifyMIR(fn, lower);
      return fn;
    },
  });
}

type Outcome =
  | { readonly ok: true; readonly values: readonly RuntimeScalar[]; readonly steps: number }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly steps: number;
      readonly location: unknown;
    };

function capture(action: () => { values: readonly RuntimeScalar[]; steps: number }): Outcome {
  try {
    const result = action();
    return { ok: true, values: result.values, steps: result.steps };
  } catch (error) {
    if (!(error instanceof IRExecutionError)) throw error;
    return {
      ok: false,
      code: error.code,
      message: error.message,
      steps: error.steps,
      location: error.location,
    };
  }
}

function scalarOf(engine: IRInterpreter | CompiledModule, name: string): unknown {
  const storage = 'setup' in engine ? engine.setup.storage : engine.storage;
  return storage.dump().scalars.get(name);
}

describe('J12 memory optimization execution parity', () => {
  it('matches the reference for a promoted state read-modify-write loop', () => {
    const fixture = createIRModule();
    const state = fixture.state('counter', 'u32', 0);
    const run = fixture.func('run', { params: ['u32', 'u32'], results: ['u32'] });
    run.body((b, [n, step]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        const current = b.state.load(state);
        const next = b.int.add(current, step);
        b.state.store(state, next);
        b.jump(head, [b.int.add(index, one), b.int.add(total, next)]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    for (const [n, step] of [
      [0, 1],
      [1, 3],
      [7, 2],
      [250, 5],
    ] as const) {
      const jit = optimized(fixture);
      const reference = createIRInterpreter(fixture, { validation: policy(fixture) });
      const expected = capture(() => reference.execute(run, [n, step], context));
      const actual = capture(() => jit.execute(run, [n, step], context));
      expect({ n, step, actual }).toEqual({ n, step, actual: expected });
      expect(scalarOf(jit, 'counter')).toEqual(scalarOf(reference, 'counter'));
    }
  });

  it('promotes all 16 registers of a DBT-style register file without slow paths', () => {
    const module = createIRModule();
    const registers = module.array('registers', 'u32', new Array<number>(16).fill(0));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        let sum = total;
        for (let register = 0; register < 16; register += 1) {
          const slot = b.const('u32', register);
          const current = b.array.load(registers, slot);
          const next = b.int.add(current, index);
          b.array.store(registers, slot, next);
          sum = b.int.add(sum, next);
        }
        b.jump(head, [b.int.add(index, one), sum]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    for (const n of [0, 1, 9, 64]) {
      const jit = optimized(module);
      const reference = createIRInterpreter(module, { validation: policy(module) });
      const expected = capture(() => reference.execute(run, [n], context));
      const actual = capture(() => jit.execute(run, [n], context));
      expect({ n, actual }).toEqual({ n, actual: expected });
    }
    const jit = optimized(module);
    const source = jit.source(0);
    expect(source).toMatch(/\bps15\b/);
    // No array slow paths at all: even the suspended-write branch never needs a
    // bounds test (the only `S0.length` use would come from one).
    expect(source).not.toContain('H.storage.loadArray');
    expect(source).not.toContain('S0.length');
  });

  it('writes promoted values back when an instruction throws mid-loop', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const three = b.const('u32', 3);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        const current = b.state.load(counter);
        const next = b.int.add(current, one);
        b.state.store(counter, next);
        // Throws when index === 3, after the store above already ran.
        const quotient = b.int.div(next, b.int.sub(three, index));
        b.jump(head, [b.int.add(index, one), b.int.add(total, quotient)]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    const jit = optimized(module);
    const reference = createIRInterpreter(module, { validation: policy(module) });
    const expected = capture(() => reference.execute(run, [5], context));
    const actual = capture(() => jit.execute(run, [5], context));
    expect(actual).toEqual(expected);
    expect(actual.ok).toBe(false);
    expect(scalarOf(jit, 'counter')).toEqual(scalarOf(reference, 'counter'));
  });

  it('spills before an executor so host code sees the latest state', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const probe = module.domainInstruction('probe.observe', { operands: [], results: [] });
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        b.state.store(counter, b.int.add(index, one));
        b.invoke(probe, []);
        const observed = b.state.load(counter);
        b.jump(head, [b.int.add(index, one), b.int.add(total, observed)]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    const observed: number[] = [];
    const options: IRInterpreterOptions = {
      validation: policy(module, ['probe.observe']),
      executors: [
        {
          op: 'probe.observe',
          execute: () => {
            observed.push(Number(host.storage!.loadState(counter)));
            return [];
          },
        },
      ],
    };
    const host: { storage: CompiledModule['setup']['storage'] | undefined } = {
      storage: undefined,
    };
    const jit = optimized(module, options);
    host.storage = jit.setup.storage;
    const actual = capture(() => jit.execute(run, [4], context));
    expect(actual.ok).toBe(true);
    expect(observed).toEqual([1, 2, 3, 4]);

    const referenceObserved: number[] = [];
    const referenceHost: { storage: IRInterpreter['storage'] | undefined } = {
      storage: undefined,
    };
    const reference = createIRInterpreter(module, {
      validation: policy(module, ['probe.observe']),
      executors: [
        {
          op: 'probe.observe',
          execute: () => {
            referenceObserved.push(Number(referenceHost.storage!.loadState(counter)));
            return [];
          },
        },
      ],
    });
    referenceHost.storage = reference.storage;
    const expected = capture(() => reference.execute(run, [4], context));
    expect(actual).toEqual(expected);
    expect(referenceObserved).toEqual(observed);
  });

  it('reloads promoted state after a callee writes it', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const bump = module.func('bump', { params: [], results: ['u32'] });
    bump.body((b) => {
      const current = b.state.load(counter);
      const next = b.int.add(current, b.const('u32', 10));
      b.state.store(counter, next);
      b.return([next]);
    });
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        b.state.store(counter, b.int.add(index, one));
        const seen = b.call(bump, [])[0]!;
        b.jump(head, [b.int.add(index, one), b.int.add(total, seen)]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    const jit = optimized(module);
    const reference = createIRInterpreter(module, { validation: policy(module) });
    const expected = capture(() => reference.execute(run, [3], context));
    const actual = capture(() => jit.execute(run, [3], context));
    expect(actual).toEqual(expected);
    expect(scalarOf(jit, 'counter')).toEqual(scalarOf(reference, 'counter'));
  });

  it('does not forward a U float store through promotion', () => {
    const module = createIRModule();
    const bits = module.state('bits', 'f64', 0);
    const run = module.func('run', { params: ['u32'], results: ['f64'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'f64']);
      const inner = b.block(['u32', 'f64']);
      const after = b.block(['f64']);
      b.jump(head, [zero, b.const('f64', 0)]);
      b.at(head, (_inner, [index, acc]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, acc] },
          { target: after, args: [acc] },
        ),
      );
      b.at(inner, (_inner, [index]) => {
        b.state.store(bits, b.bits('f64', '0x7FF8000000000001'));
        const loaded = b.state.load(bits);
        b.jump(head, [b.int.add(index, one), loaded]);
      });
      b.at(after, (_inner, [last]) => b.return([last]));
    });

    for (const n of [1, 3]) {
      const jit = optimized(module);
      const reference = createIRInterpreter(module, { validation: policy(module) });
      const expected = capture(() => reference.execute(run, [n], context));
      const actual = capture(() => jit.execute(run, [n], context));
      expect(actual).toEqual(expected);
    }
  });

  it('keeps the slow loop copy so an out-of-range iteration reports at the same spot', () => {
    const module = createIRModule();
    const table = module.array('table', 'u32', new Array<number>(8).fill(0));
    const run = module.func('run', { params: ['u32'], results: ['u32'] });
    run.body((b, [n]) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const head = b.block(['u32', 'u32']);
      const inner = b.block(['u32', 'u32']);
      const after = b.block(['u32']);
      b.jump(head, [zero, zero]);
      b.at(head, (_inner, [index, total]) =>
        b.branch(
          b.int.cmp('lt', index, n),
          { target: inner, args: [index, total] },
          { target: after, args: [total] },
        ),
      );
      b.at(inner, (_inner, [index, total]) => {
        const value = b.array.load(table, index);
        b.jump(head, [b.int.add(index, one), b.int.add(total, value)]);
      });
      b.at(after, (_inner, [total]) => b.return([total]));
    });

    for (const n of [0, 4, 8, 10]) {
      const jit = optimized(module);
      const reference = createIRInterpreter(module, { validation: policy(module) });
      const expected = capture(() => reference.execute(run, [n], context));
      const actual = capture(() => jit.execute(run, [n], context));
      expect({ n, actual }).toEqual({ n, actual: expected });
    }
  });

  it('leaves the same storage behind when the step budget is exhausted', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 0);
    const run = module.func('run', { params: [], results: [] });
    run.body((b) => {
      const zero = b.const('u32', 0);
      const one = b.const('u32', 1);
      const size = b.const('u32', 50);
      const head = b.block(['u32']);
      const inner = b.block(['u32']);
      const after = b.block([]);
      b.jump(head, [zero]);
      b.at(head, (_inner, [index]) =>
        b.branch(
          b.int.cmp('lt', index, size),
          { target: inner, args: [index] },
          { target: after, args: [] },
        ),
      );
      b.at(inner, (_inner, [index]) => {
        const current = b.state.load(counter);
        b.state.store(counter, b.int.add(current, one));
        b.jump(head, [b.int.add(index, one)]);
      });
      b.at(after, () => b.return([]));
    });

    for (const maxSteps of [5, 11, 17]) {
      const jit = optimized(module, { validation: policy(module), maxSteps });
      const reference = createIRInterpreter(module, { validation: policy(module), maxSteps });
      const expected = capture(() => reference.execute(run, [], context));
      const actual = capture(() => jit.execute(run, [], context));
      expect({ maxSteps, actual }).toEqual({ maxSteps, actual: expected });
      expect(scalarOf(jit, 'counter')).toEqual(scalarOf(reference, 'counter'));
    }
  });

  it('matches the reference when a dominating load is reused across blocks', () => {
    const module = createIRModule();
    const counter = module.state('counter', 'u32', 3);
    const run = module.func('run', {
      params: ['bool', 'u32'],
      results: ['u32', 'u32', 'u32'],
    });
    run.body((b, [flag, value]) => {
      const left = b.block([]);
      const right = b.block([]);
      const join = b.block(['u32']);
      // Dominating load: reused by the arms, but not by the join, because one
      // arm stores a different value on the way there.
      const first = b.state.load(counter);
      b.branch(flag, { target: left, args: [] }, { target: right, args: [] });
      b.at(left, (inner) => {
        const current = inner.state.load(counter);
        inner.jump(join, [inner.int.add(current, inner.const('u32', 1))]);
      });
      b.at(right, (inner) => {
        inner.state.store(counter, value);
        const current = inner.state.load(counter);
        inner.jump(join, [inner.int.mul(current, inner.const('u32', 2))]);
      });
      b.at(join, (inner, [arm]) => inner.return([first, arm, inner.state.load(counter)]));
    });

    for (const [flag, value] of [
      [false, 0],
      [true, 5],
      [true, 0xffff_ffff],
    ] as const) {
      const jit = optimized(module);
      const reference = createIRInterpreter(module, { validation: policy(module) });
      const expected = capture(() => reference.execute(run, [flag, value], context));
      const actual = capture(() => jit.execute(run, [flag, value], context));
      expect({ flag, value, actual }).toEqual({ flag, value, actual: expected });
      expect(scalarOf(jit, 'counter')).toEqual(scalarOf(reference, 'counter'));
    }
  });
});
