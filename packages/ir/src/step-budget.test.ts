import { describe, expect, it, vi } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  type IRExecutionContext,
  type IRInterpreterOptions,
  type IRModule,
  type IRStepBudget,
  type IRValidationOptions,
} from './index';
import { ENGINES } from './testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const context = { instanceId: 'step-budget', virtualTime: 42 };

  function policy(module: IRModule): IRValidationOptions {
    return {
      supportedInstructions: CORE_INSTRUCTION_NAMES,
      authorizedInstructions: CORE_INSTRUCTION_NAMES,
      resources: module.memories.map(({ ref }) => ({ ref, access: 'read-write' })),
    };
  }

  /** Three reference steps: `int.add`, `state.store`, and the `return` terminator. */
  function fixture() {
    const module = createIRModule();
    const state = module.state('count', 'u32', 0);
    const run = module.entry('run', ['u32']);
    run.body((b, [value]) => {
      const next = b.int.add(value, value);
      b.state.store(state, next);
      b.return([]);
    });
    return { module, state, run };
  }

  function runtime(module: IRModule, options: Partial<IRInterpreterOptions> = {}) {
    return create(module, { validation: policy(module), ...options });
  }

  function failure(action: () => unknown, code = 'evaluation-failed'): IRExecutionError {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IRExecutionError);
    expect((caught as IRExecutionError).code).toBe(code);
    return caught as IRExecutionError;
  }

  describe('optional batch step budget', () => {
    it('consumes one step per executed step without querying the remaining budget', () => {
      const { module, run } = fixture();
      const remaining = vi.fn(() => 100);
      const consume = vi.fn();
      const budget: IRStepBudget = { remaining, consume };
      const interpreter = runtime(module, { stepBudget: budget });

      expect(consume).not.toHaveBeenCalled();
      expect(remaining).not.toHaveBeenCalled();
      expect(interpreter.execute(run, [4], context)).toEqual({ values: [], steps: 3 });
      expect(consume).toHaveBeenCalledTimes(3);
      expect(remaining).not.toHaveBeenCalled();

      const calls = consume.mock.calls;
      const captured = calls[0]![0];
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured).not.toBe(context);
      expect(captured).toEqual({ instanceId: 'step-budget', virtualTime: 42 });
      for (const call of calls) {
        expect(call[0]).toBe(captured);
        expect(call[1]).toBe(1);
      }
    });

    it('keeps the captured context stable across nested calls and terminators', () => {
      const module = createIRModule();
      const inner = module.func('inner', { params: [], results: [] });
      inner.body((b) => b.return([]));
      const outer = module.entry('outer', []);
      outer.body((b) => {
        b.call(inner, []);
        b.return([]);
      });
      const consume = vi.fn();
      const budget: IRStepBudget = { remaining: vi.fn(() => 100), consume };
      expect(runtime(module, { stepBudget: budget }).execute(outer, [], context)).toEqual({
        values: [],
        steps: 3,
      });
      expect(consume).toHaveBeenCalledTimes(3);
      const captured = consume.mock.calls[0]![0];
      expect(captured).toEqual({ instanceId: 'step-budget', virtualTime: 42 });
      for (const call of consume.mock.calls) expect(call[0]).toBe(captured);
    });

    it('snapshots the budget methods without invoking them during creation', () => {
      const { module, run } = fixture();
      const consume = vi.fn();
      const budget: IRStepBudget = { remaining: vi.fn(() => 100), consume };
      const options: {
        validation: IRValidationOptions;
        stepBudget: IRStepBudget;
        maxSteps?: number;
      } = { validation: policy(module), stepBudget: budget };
      const interpreter = create(module, options);
      budget.consume = () => {
        throw new Error('replacement');
      };
      budget.remaining = () => {
        throw new Error('replacement');
      };
      options.maxSteps = 0;
      options.stepBudget = { remaining: () => 0, consume: vi.fn() };
      expect(consume).not.toHaveBeenCalled();
      expect(interpreter.execute(run, [1], context)).toEqual({ values: [], steps: 3 });
      expect(consume).toHaveBeenCalledTimes(3);
    });

    it('checks maxSteps before consuming, so blocked steps never reach the host', () => {
      const { module, run } = fixture();
      const remaining = vi.fn(() => 100);
      const consume = vi.fn();
      const budget: IRStepBudget = { remaining, consume };
      const interpreter = runtime(module, { maxSteps: 2, stepBudget: budget });
      const error = failure(() => interpreter.execute(run, [1], context), 'budget-exhausted');
      expect(error.steps).toBe(2);
      expect(error.location).toMatchObject({ functionName: 'run', terminator: true });
      expect(consume).toHaveBeenCalledTimes(2);
      expect(remaining).not.toHaveBeenCalled();
      failure(() => interpreter.execute(run, [1], context), 'instance-faulted');
      expect(consume).toHaveBeenCalledTimes(2);
    });

    it('does not count the step whose consume call throws and faults the instance', () => {
      const { module, state, run } = fixture();
      const cause = new Error('host accounting failed');
      let calls = 0;
      const consume = vi.fn(() => {
        calls += 1;
        if (calls === 2) throw cause;
      });
      const budget: IRStepBudget = { remaining: vi.fn(() => 100), consume };
      const interpreter = runtime(module, { stepBudget: budget });
      const error = failure(() => interpreter.execute(run, [5], context));
      expect(error.steps).toBe(1);
      expect(error.cause).toBe(cause);
      expect(error.location).toMatchObject({ functionName: 'run', instructionIndex: 1 });
      expect(interpreter.storage.loadState(state)).toBe(0);
      failure(() => interpreter.execute(run, [5], context), 'instance-faulted');
      expect(consume).toHaveBeenCalledTimes(2);
    });

    it('preserves the code of an IRExecutionError raised by consume', () => {
      const { module, run } = fixture();
      const cause = new IRExecutionError('budget-exhausted', 'Host budget exhausted');
      let calls = 0;
      const consume = vi.fn(() => {
        calls += 1;
        if (calls === 3) throw cause;
      });
      const budget: IRStepBudget = { remaining: vi.fn(() => 100), consume };
      const error = failure(
        () => runtime(module, { stepBudget: budget }).execute(run, [1], context),
        'budget-exhausted',
      );
      expect(error.code).toBe('budget-exhausted');
      expect(error.message).toBe('Host budget exhausted');
      expect(error.steps).toBe(2);
      expect(error.cause).toBe(cause);
      expect(error.location).toMatchObject({ functionName: 'run', terminator: true });
    });

    it('ignores a consume return value that is not a thenable', () => {
      const { module, run } = fixture();
      const consume = vi.fn(() => 7);
      const budget: IRStepBudget = { remaining: vi.fn(() => 100), consume };
      expect(runtime(module, { stepBudget: budget }).execute(run, [2], context)).toEqual({
        values: [],
        steps: 3,
      });
      expect(consume).toHaveBeenCalledTimes(3);
    });

    it('rejects stepObserver combined with stepBudget', () => {
      const { module } = fixture();
      const error = failure(
        () =>
          runtime(module, {
            stepObserver: { beforeStep: vi.fn() },
            stepBudget: { remaining: vi.fn(() => 0), consume: vi.fn() },
          }),
        'invalid-options',
      );
      expect(error.message).toBe('stepObserver and stepBudget are mutually exclusive');
      expect(error.cause).toBeUndefined();
    });

    const invalidBudgets: ReadonlyArray<readonly [method: string, budget: unknown]> = [
      ['consume', { remaining: () => 1 }],
      ['remaining', { consume: () => undefined }],
      ['consume', { remaining: () => 1, consume: async () => undefined }],
      [
        'remaining',
        {
          remaining: function* (): Generator<number> {
            yield 1;
          },
          consume: () => undefined,
        },
      ],
      ['consume', { remaining: () => 1, consume: null }],
    ];

    it.each(invalidBudgets)(
      'rejects a nonsynchronous %s declaration with invalid-options',
      (_method, partial) => {
        const { module } = fixture();
        const error = failure(
          () => runtime(module, { stepBudget: partial as IRStepBudget }),
          'invalid-options',
        );
        expect(error.message).toBe('Expected synchronous interpreter hooks');
        expect(error.cause).toBeInstanceOf(IRConstructionError);
      },
    );

    it('rejects a consume hook returning a Promise at its IR location', () => {
      const { module, run } = fixture();
      const budget: IRStepBudget = {
        remaining: vi.fn(() => 100),
        consume: () => Promise.reject(new Error('async accounting')) as unknown as void,
      };
      const interpreter = runtime(module, { stepBudget: budget });
      const error = failure(() => interpreter.execute(run, [1], context));
      expect(error.cause).toBeInstanceOf(TypeError);
      expect(error.steps).toBe(0);
      expect(error.location).toMatchObject({ functionName: 'run', instructionIndex: 0 });
      failure(() => interpreter.execute(run, [1], context), 'instance-faulted');
    });

    it('invokes captured methods with the budget object as receiver', () => {
      const { module, run } = fixture();
      const seen: unknown[] = [];
      const budget: IRStepBudget = {
        remaining: (): number => 100,
        consume(received: IRExecutionContext, steps: number): void {
          seen.push(this, received, steps);
        },
      };
      runtime(module, { stepBudget: budget }).execute(run, [1], context);
      expect(seen).toHaveLength(9);
      const captured = seen[1];
      for (let index = 0; index < seen.length; index += 3) {
        expect(seen[index]).toBe(budget);
        expect(seen[index + 1]).toBe(captured);
        expect(seen[index + 2]).toBe(1);
      }
      expect(Object.isFrozen(captured)).toBe(true);
      expect(captured).toEqual({ instanceId: 'step-budget', virtualTime: 42 });
    });
  });
});
