import { describe, expect, it, vi } from 'vitest';
import { CORE_INSTRUCTION_NAMES } from './builder';
import {
  createIRModule,
  IRConstructionError,
  IRExecutionError,
  validateIR,
  type IREventHost,
  type IRInterpreterOptions,
  type IRModule,
  type IRStepObserver,
  type IRValidationOptions,
} from './index';
import { ENGINES } from './testing/engines';

describe.each(ENGINES)('$name engine', ({ create }) => {
  const context = { instanceId: 'events', virtualTime: 0 };
  const maximum = 7_200_000_000_000_000;
  function policy(module: IRModule): IRValidationOptions {
    return {
      supportedInstructions: CORE_INSTRUCTION_NAMES,
      authorizedInstructions: CORE_INSTRUCTION_NAMES,
      resources: module.memories.map(({ ref }) => ({ ref, access: 'read-write' })),
    };
  }
  function host(): IREventHost {
    return { now: vi.fn(() => 0), at: vi.fn(() => 7), cancel: vi.fn() };
  }
  function fixture() {
    const module = createIRModule();
    const target = module.entry('target', ['u32', 'f64', 'bool']);
    target.body((b) => b.return([]));
    const run = module.func('run', { params: ['f64', 'u32', 'f64', 'bool'], results: ['u32'] });
    run.body((b, [deadline, count, bits, flag]) =>
      b.return([b.event.at(target, deadline, [count, bits, flag])]),
    );
    return { module, target, run };
  }
  function runtime(module: IRModule, options: Partial<IRInterpreterOptions> = {}) {
    return create(module, { validation: policy(module), ...options });
  }
  function failure(action: () => unknown, code = 'evaluation-failed'): IRExecutionError {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(IRExecutionError);
      expect((error as IRExecutionError).code).toBe(code);
      return error as IRExecutionError;
    }
    throw new Error('Expected IRExecutionError');
  }

  describe('core event operations', () => {
    it('requires a host at creation with the event location, even for uncalled functions', () => {
      const { module } = fixture();
      const error = failure(() => runtime(module), 'unsupported-instruction');
      expect(error.location).toMatchObject({ functionName: 'run', instructionIndex: 0 });
      expect(error.message).toContain('event.at');
      const nowModule = createIRModule();
      nowModule.entry('now', []).body((b) => {
        b.event.now();
        b.return([]);
      });
      expect(failure(() => runtime(nowModule), 'unsupported-instruction').location).toMatchObject({
        functionName: 'now',
        instructionIndex: 0,
      });
    });

    it('captures every scalar by value, decodes the f64 deadline, and returns a nonzero u32 ID', () => {
      const { module, target, run } = fixture();
      const eventHost = host();
      const interpreter = runtime(module, { eventHost });
      const bits = { type: 'f64', bits: '0x7ff8000000001234' } as const;
      const result = interpreter.execute(
        run,
        [{ type: 'f64', bits: '0x4024000000000000' }, 42, bits, true],
        context,
      );
      expect(result).toEqual({ values: [7], steps: 2 });
      expect(eventHost.at).toHaveBeenCalledWith(target, 10, [42, bits, true]);
      const captured = vi.mocked(eventHost.at).mock.calls[0]![2];
      expect(captured).not.toBe(bits);
      expect(captured[1]).not.toBe(bits);
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured[1])).toBe(true);
    });

    it.each([0, -0, maximum])('accepts event time %s and normalizes negative zero', (now) => {
      const module = createIRModule();
      const target = module.entry('target', []);
      target.body((b) => b.return([]));
      const run = module.func('run', { params: [], results: ['f64', 'u32'] });
      run.body((b) => {
        const time = b.event.now();
        b.return([time, b.event.at(target, time, [])]);
      });
      const eventHost = host();
      eventHost.now = vi.fn(() => now);
      const result = runtime(module, { eventHost }).execute(run, [], context);
      expect(result.values[0]).toEqual({
        type: 'f64',
        bits: now === maximum ? '0x4339945ca2620000' : '0x0000000000000000',
      });
      expect(eventHost.at).toHaveBeenCalledWith(target, now === 0 ? 0 : now, []);
    });

    it.each([
      [NaN, TypeError],
      [Infinity, TypeError],
      [-Infinity, TypeError],
      [1.5, TypeError],
      [-1.5, TypeError],
      [-1, RangeError],
      [maximum + 1, RangeError],
    ])('rejects invalid deadline %s before host.at', (deadline, expected) => {
      const { module, run } = fixture();
      const eventHost = host();
      const interpreter = runtime(module, { eventHost });
      const error = failure(() => interpreter.execute(run, [deadline, 1, 2, false], context));
      expect(error.cause).toBeInstanceOf(expected);
      expect(error.location).toMatchObject({ functionName: 'run', instructionIndex: 0 });
      expect(eventHost.at).not.toHaveBeenCalled();
      failure(() => interpreter.execute(run, [0, 1, 2, false], context), 'instance-faulted');
    });

    it('rejects past deadlines and validates host.now for both time operations', () => {
      const { module, run } = fixture();
      const eventHost = host();
      eventHost.now = vi.fn(() => 11);
      expect(
        failure(() => runtime(module, { eventHost }).execute(run, [10, 1, 2, false], context))
          .cause,
      ).toBeInstanceOf(RangeError);
      expect(eventHost.at).not.toHaveBeenCalled();
      for (const invalid of [NaN, Infinity, 0.5, -1, maximum + 1, '0']) {
        eventHost.now = vi.fn(() => invalid as number);
        const expected =
          typeof invalid !== 'number' || !Number.isFinite(invalid) || !Number.isInteger(invalid)
            ? TypeError
            : RangeError;
        expect(
          failure(() => runtime(module, { eventHost }).execute(run, [10, 1, 2, false], context))
            .cause,
        ).toBeInstanceOf(expected);
        const nowModule = createIRModule();
        const read = nowModule.func('read', { params: [], results: ['f64'] });
        read.body((b) => b.return([b.event.now()]));
        expect(
          failure(() => runtime(nowModule, { eventHost }).execute(read, [], context)).cause,
        ).toBeInstanceOf(expected);
      }
    });

    it.each([0, -1, 0x100000000, 1.5, NaN, Infinity, '7'])('rejects host ID %s', (id) => {
      const { module, run } = fixture();
      const eventHost = host();
      eventHost.at = vi.fn(() => id as number);
      expect(
        failure(() => runtime(module, { eventHost }).execute(run, [0, 1, 2, false], context)).cause,
      ).toBeInstanceOf(Error);
      expect(eventHost.at).toHaveBeenCalledTimes(1);
    });

    it('allows scheduling the same entry without treating it as synchronous recursion', () => {
      const module = createIRModule();
      const run = module.entry('run', []);
      run.body((b) => {
        b.event.at(run, b.event.now(), []);
        b.return([]);
      });
      const eventHost = host();
      expect(runtime(module, { eventHost }).execute(run, [], context).steps).toBe(3);
      expect(eventHost.at).toHaveBeenCalledWith(run, 0, []);
    });

    it('passes cancel(0) and maximum u32 unchanged to the host', () => {
      const module = createIRModule();
      const cancel = module.entry('cancel', ['u32']);
      cancel.body((b, [id]) => {
        b.event.cancel(id);
        b.return([]);
      });
      const eventHost = host();
      const interpreter = runtime(module, { eventHost });
      interpreter.execute(cancel, [0], context);
      interpreter.execute(cancel, [0xffffffff], context);
      expect(vi.mocked(eventHost.cancel).mock.calls).toEqual([[0], [0xffffffff]]);
      failure(() => interpreter.execute(cancel, [-1], context), 'invalid-argument');
      expect(eventHost.cancel).toHaveBeenCalledTimes(2);
    });

    it('preserves explicit supported/authorized policy and forbids domain redefinition', () => {
      const { module } = fixture();
      const validation = policy(module);
      expect(
        validateIR(module, { ...validation, supportedInstructions: ['return'] }).diagnostics,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unsupported-instruction' })]),
      );
      expect(
        validateIR(module, { ...validation, authorizedInstructions: ['return'] }).diagnostics,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unauthorized-instruction' })]),
      );
      for (const op of ['event.now', 'event.at', 'event.cancel']) {
        expect(() => module.domainInstruction(op, { operands: [], results: [] })).toThrow(
          IRConstructionError,
        );
        expect(
          validateIR(module, { ...validation, validators: [{ op, validate: () => [] }] }).ok,
        ).toBe(false);
      }
    });

    it.each(['function', 'lifecycle', 'foreign'] as const)(
      'rejects %s event targets at construction',
      (kind) => {
        const module = createIRModule();
        const target =
          kind === 'foreign'
            ? createIRModule().entry('foreign', [])
            : kind === 'function'
              ? module.func('helper', { params: [], results: [] })
              : module.lifecycle('initialize', []);
        const run = module.entry('run', []);
        expect(() =>
          run.body((b) => {
            b.event.at(target as never, b.const('f64', 0), []);
            b.return([]);
          }),
        ).toThrow(IRConstructionError);
      },
    );

    it.each([
      'target',
      'foreign',
      'deadline',
      'args',
      'argtype',
      'result',
      'now',
      'cancel',
    ] as const)('validates malformed %s event nodes without relying on builder checks', (kind) => {
      const { module, run } = fixture();
      const model = { ...module, functions: module.functions };
      const fn = model.functions.find(({ ref }) => ref === run)!;
      const nodes = fn.body!.entry.instructions as unknown as {
        op: string;
        operands: unknown[];
        results: unknown[];
      }[];
      const node = nodes[0]!;
      if (kind === 'target') node.operands[0] = { kind: 'static', ref: run };
      if (kind === 'foreign')
        node.operands[0] = {
          kind: 'static',
          ref: createIRModule().entry('foreign', ['u32', 'f64', 'bool']),
        };
      if (kind === 'argtype') node.operands[2] = node.operands[3];
      if (kind === 'deadline') node.operands[1] = node.operands[2];
      if (kind === 'args') node.operands.pop();
      if (kind === 'result') node.results = [];
      if (kind === 'now') node.op = 'event.now';
      if (kind === 'cancel') node.op = 'event.cancel';
      expect(validateIR(model, policy(module)).ok).toBe(false);
    });
  });

  describe('trusted synchronous interpreter hooks', () => {
    it('snapshots methods and options without invoking hooks during creation', () => {
      const { module, run } = fixture();
      const eventHost = host();
      const beforeStep = vi.fn();
      const stepObserver: IRStepObserver = { beforeStep };
      const options = { validation: policy(module), eventHost, stepObserver, maxSteps: 2 };
      const interpreter = create(module, options);
      expect(eventHost.now).not.toHaveBeenCalled();
      expect(eventHost.at).not.toHaveBeenCalled();
      expect(beforeStep).not.toHaveBeenCalled();
      const at = eventHost.at;
      eventHost.at = () => {
        throw new Error('replacement');
      };
      eventHost.now = () => {
        throw new Error('replacement');
      };
      stepObserver.beforeStep = () => {
        throw new Error('replacement');
      };
      options.maxSteps = 0;
      options.eventHost = host();
      expect(interpreter.execute(run, [0, 1, 2, false], context).values).toEqual([7]);
      expect(at).toHaveBeenCalledOnce();
      expect(beforeStep).toHaveBeenCalledTimes(2);
      expect(beforeStep).toHaveBeenCalledWith(context);
      expect(Object.isFrozen(beforeStep.mock.calls[0]![0])).toBe(true);
    });

    it.each([
      async () => 0,
      function* () {
        yield 0;
      },
      async function* () {
        yield 0;
      },
      null,
    ])('rejects nonsynchronous hook declarations at creation', (invalid) => {
      const module = createIRModule();
      for (const method of ['now', 'at', 'cancel'] as const) {
        const eventHost = { ...host(), [method]: invalid } as unknown as IREventHost;
        expect(
          failure(() => runtime(module, { eventHost }), 'invalid-options').cause,
        ).toBeDefined();
      }
      failure(
        () => runtime(module, { stepObserver: { beforeStep: invalid } as IRStepObserver }),
        'invalid-options',
      );
    });

    it.each(['now', 'at', 'cancel', 'beforeStep'] as const)(
      'rejects thenables returned by %s',
      (method) => {
        const module = createIRModule();
        const target = module.entry('target', []);
        target.body((b) => b.return([]));
        const run = module.entry('run', []);
        run.body((b) => {
          b.event.now();
          b.event.cancel(b.event.at(target, b.const('f64', 0), []));
          b.return([]);
        });
        const eventHost = host();
        const stepObserver = { beforeStep: () => undefined };
        const invalid = () => Promise.reject(new Error('async rejection'));
        if (method === 'beforeStep') Object.assign(stepObserver, { beforeStep: invalid });
        else Object.assign(eventHost, { [method]: invalid });
        const error = failure(() =>
          runtime(module, { eventHost, stepObserver }).execute(run, [], context),
        );
        expect(error.cause).toBeInstanceOf(TypeError);
        expect(error.location).toMatchObject({ functionName: 'run' });
      },
    );

    it.each([
      () => ({ then: () => undefined }),
      () =>
        (function* () {
          yield 1;
        })(),
      () =>
        (async function* () {
          yield 1;
        })(),
    ])('rejects synchronous hooks returning asynchronous work', (beforeStep) => {
      const module = createIRModule();
      const run = module.entry('run', []);
      run.body((b) => b.return([]));
      const interpreter = runtime(module, { stepObserver: { beforeStep } });
      const error = failure(() => interpreter.execute(run, [], context));
      expect(error.cause).toBeInstanceOf(TypeError);
      expect(error.location).toMatchObject({ functionName: 'run', terminator: true });
    });

    it('observes calls and terminators exactly once before effects, preserves prior state and diagnostics', () => {
      const module = createIRModule();
      const state = module.state('count', 'u32', 0);
      const inner = module.func('inner', { params: [], results: [] });
      inner.body((b) => {
        b.state.store(state, b.const('u32', 1));
        b.return([]);
      });
      const outer = module.entry('outer', []);
      outer.body((b) => {
        b.call(inner, []);
        b.return([]);
      });
      const cause = new Error('observer budget');
      let observed = 0;
      const interpreter = runtime(module, {
        stepObserver: {
          beforeStep() {
            observed += 1;
            if (observed === 4) throw cause;
          },
        },
      });
      const error = failure(() => interpreter.execute(outer, [], context));
      expect(error.cause).toBe(cause);
      expect(error.steps).toBe(3);
      expect(error.callStack).toEqual([
        expect.objectContaining({ functionName: 'outer', instructionIndex: 0 }),
        expect.objectContaining({ functionName: 'inner', terminator: true }),
      ]);
      expect(interpreter.storage.loadState(state)).toBe(1);
      failure(() => interpreter.execute(outer, [], context), 'instance-faulted');
      expect(observed).toBe(4);
      const beforeStep = vi.fn();
      const limited = runtime(module, { maxSteps: 0, stepObserver: { beforeStep } });
      failure(() => limited.execute(outer, [], context), 'budget-exhausted');
      expect(beforeStep).not.toHaveBeenCalled();
    });

    it('stops before a store effect when the observer throws and retains hook receivers', () => {
      const module = createIRModule();
      const state = module.state('count', 'u32', 0);
      const run = module.entry('run', ['u32']);
      run.body((b, [value]) => {
        b.state.store(state, value);
        b.return([]);
      });
      const stepObserver = {
        beforeStep() {
          expect(this).toBe(stepObserver);
          throw new Error('stop');
        },
      };
      const interpreter = runtime(module, { stepObserver });
      expect(failure(() => interpreter.execute(run, [5], context)).steps).toBe(0);
      expect(interpreter.storage.loadState(state)).toBe(0);
    });

    it('preserves a host exception as cause at its nested IR call site', () => {
      const module = createIRModule();
      const inner = module.func('inner', { params: [], results: [] });
      inner.body((b) => {
        b.event.now();
        b.return([]);
      });
      const outer = module.entry('outer', []);
      outer.body((b) => {
        b.call(inner, []);
        b.return([]);
      });
      const cause = new Error('host unavailable');
      const eventHost = {
        ...host(),
        now() {
          expect(this).toBe(eventHost);
          throw cause;
        },
      };
      const error = failure(() => runtime(module, { eventHost }).execute(outer, [], context));
      expect(error.cause).toBe(cause);
      expect(error.callStack.map(({ functionName }) => functionName)).toEqual(['outer', 'inner']);
      expect(error.location).toMatchObject({ functionName: 'inner', instructionIndex: 0 });
    });
  });
});
