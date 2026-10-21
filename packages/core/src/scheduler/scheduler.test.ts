import { describe, expect, it } from 'vitest';
import type { FloatBits, RuntimeScalar } from '@mica-js/ir';
import { createScheduler } from './scheduler';
import { SchedulerError } from './scheduler-error';
import type { SchedulerErrorCode } from './scheduler-error';
import type {
  SchedulerExecutionContext,
  SchedulerOptions,
  SchedulerTarget,
} from './scheduler-types';
import { MAX_TIME_PS } from './time';

const event = (name: string): SchedulerTarget => ({ name, kind: 'event', params: [] });
const control = (name: string): SchedulerTarget => ({ name, kind: 'control', params: [] });

// Core tests carry no Node/DOM ambient types; this only yields to a new task so GC can clear WeakRefs.
declare function setTimeout(callback: () => void, delay?: number): unknown;

function fixture(options?: SchedulerOptions) {
  const scheduler = createScheduler(options);
  const targets = {
    A: event('A'),
    B: event('B'),
    C: event('C'),
    P: control('P'),
    Q: control('Q'),
    R: control('R'),
  };
  const trace: string[] = [];
  const actions = new Map<string, (context: SchedulerExecutionContext) => void>();
  const instance = scheduler.addInstance({
    instanceId: 'instance',
    targets: Object.values(targets),
    executor: {
      execute(target, _args, context) {
        context.consumeSteps();
        trace.push(`${target.name}@${context.timePs}:${context.phase}`);
        actions.get(target.name)?.(context);
      },
    },
  });
  return { scheduler, instance, targets, trace, actions };
}

function failure(run: () => unknown, code: SchedulerErrorCode): SchedulerError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(SchedulerError);
  const error = caught as SchedulerError;
  expect(error.code).toBe(code);
  return error;
}

describe('stable event and control rounds', () => {
  it('runs A/C/B and never recursively enters zero-delay B', () => {
    const { scheduler, instance, targets, trace, actions } = fixture();
    actions.set('A', () => {
      instance.at(targets.B, scheduler.now, []);
      expect(trace).toEqual(['A@0:event']);
    });
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 0, []);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 3, reason: 'empty' });
    expect(trace).toEqual(['A@0:event', 'C@0:event', 'B@0:event']);
  });

  it('runs A/P/C and finishes subsequent stable control rounds first', () => {
    const { scheduler, instance, targets, trace, actions } = fixture();
    actions.set('A', () => {
      scheduler.enqueueControl(instance, targets.P, []);
      scheduler.enqueueControl(instance, targets.R, []);
      expect(trace).toEqual(['A@7:event']);
    });
    actions.set('P', () => {
      scheduler.enqueueControl(instance, targets.Q, []);
      instance.at(targets.B, scheduler.now, []);
    });
    instance.at(targets.A, 7, []);
    instance.at(targets.C, 7, []);
    scheduler.start();
    expect(trace).toEqual([
      'A@7:event',
      'P@7:control',
      'R@7:control',
      'Q@7:control',
      'C@7:event',
      'B@7:event',
    ]);
  });

  it('does not insert boundary inputs into an already executed causal round', () => {
    const { scheduler, instance, targets, trace, actions } = fixture();
    actions.set('A', () => instance.at(targets.B, 0, []));
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 0, []);
    scheduler.step();
    instance.at(targets.A, 0, []);
    scheduler.start({ maxEntries: 3 });
    expect(trace).toEqual(['A@0:event', 'C@0:event', 'B@0:event', 'A@0:event']);
  });

  it('uses deadline before acceptance order, never ID order, including maximum time', () => {
    const { scheduler, instance, targets, trace } = fixture();
    const first = instance.at(targets.A, 90, []);
    const second = instance.at(targets.B, 40, []);
    instance.cancel(first);
    expect(instance.at(targets.C, 40, [])).toBe(first);
    expect(second).toBe(2);
    instance.at(targets.A, MAX_TIME_PS, []);
    scheduler.start();
    expect(trace).toEqual(['B@40:event', 'C@40:event', `A@${MAX_TIME_PS}:event`]);
  });
});

describe('capture, validation, and identity', () => {
  it('captures scalars and FloatBits by value and freezes declaration metadata', () => {
    const scheduler = createScheduler();
    const target = {
      name: 'capture',
      kind: 'event' as const,
      params: ['u32', 'bool', 'f64'] as const,
    };
    const seen: RuntimeScalar[][] = [];
    const instance = scheduler.addInstance({
      instanceId: 'capture',
      targets: [target],
      executor: {
        execute(receivedTarget, args, context) {
          context.consumeSteps();
          expect(receivedTarget.name).toBe('capture');
          seen.push([...args]);
        },
      },
    });
    const bits: { type: 'f64'; bits: `0x${string}` } = { type: 'f64', bits: '0x7ff8000000000001' };
    const args: RuntimeScalar[] = [7, true, bits];
    instance.at(target, 0, args);
    args[0] = 9;
    bits.bits = '0x0000000000000000';
    target.name = 'changed';
    scheduler.start();
    expect(seen).toEqual([[7, true, { type: 'f64', bits: '0x7ff8000000000001' }]]);
    expect(seen[0]![2]).not.toBe(bits);
    expect(Object.isFrozen(seen[0]![2])).toBe(true);
  });

  it('rejects invalid/past deadlines without allocating IDs or poisoning the scheduler', () => {
    const { scheduler, instance, targets } = fixture();
    for (const value of [NaN, Infinity, 0.5, '1']) {
      expect(() => instance.at(targets.A, value as number, [])).toThrow(TypeError);
    }
    for (const value of [-1, MAX_TIME_PS + 1])
      expect(() => instance.at(targets.A, value, [])).toThrow(RangeError);
    expect(instance.at(targets.A, 2, [])).toBe(1);
    scheduler.start({ until: 2 });
    expect(() => instance.at(targets.A, 1, [])).toThrow(RangeError);
    expect(() => scheduler.start({ until: 1 })).toThrow(RangeError);
    expect(scheduler.state).toBe('paused');
    expect(instance.at(targets.B, 2, [])).toBe(1);
  });

  it('validates all arguments and target category before queue or ID effects', () => {
    const { scheduler, instance, targets } = fixture();
    failure(() => instance.at(targets.P, 0, []), 'invalid-target');
    failure(() => scheduler.enqueueControl(instance, targets.A, []), 'invalid-target');
    failure(() => instance.at({ ...targets.A }, 0, []), 'invalid-target');
    failure(() => instance.at(targets.A, 0, [1]), 'invalid-argument');
    expect(instance.at(targets.A, 0, [])).toBe(1);
    const float = { name: 'float', kind: 'event' as const, params: ['f32'] as const };
    const second = scheduler.addInstance({
      instanceId: 'other',
      targets: [float],
      executor: { execute() {} },
    });
    failure(
      () => second.at(float, 0, [{ type: 'f64', bits: '0x0000000000000000' } as FloatBits]),
      'invalid-argument',
    );
    failure(() => second.at(targets.A, 0, []), 'invalid-target');
    expect(second.at(float, 0, [1])).toBe(1);
  });

  it('rejects sparse signatures and snapshots the executor method', () => {
    const scheduler = createScheduler();
    failure(
      () =>
        scheduler.addInstance({
          instanceId: 'bad',
          targets: [{ name: 'hole', kind: 'event', params: new Array(1) }],
          executor: { execute() {} },
        }),
      'invalid-target',
    );
    let calls = 0;
    const executor = {
      execute() {
        calls += 1;
      },
    };
    const A = event('A');
    const instance = scheduler.addInstance({ instanceId: 'good', targets: [A], executor });
    executor.execute = () => {
      throw new Error('replacement must not run');
    };
    instance.at(A, 0, []);
    scheduler.start();
    expect(calls).toBe(1);
  });
});

describe('per-instance u32 ID lifecycle', () => {
  it('cancels zero and released IDs idempotently, rejects invalid/never allocated IDs', () => {
    const { scheduler, instance, targets, trace } = fixture();
    instance.cancel(0);
    for (const id of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, '0', 1]) {
      failure(() => instance.cancel(id as number), 'invalid-event-id');
    }
    const id = instance.at(targets.A, 10, []);
    instance.cancel(id);
    instance.cancel(id);
    scheduler.start();
    expect(trace).toEqual([]);
    expect(scheduler.now).toBe(0);
  });

  it('reuses freed IDs in release FIFO and cancels the current meaning of an old number', () => {
    const { scheduler, instance, targets, trace } = fixture();
    const first = instance.at(targets.A, 0, []);
    const second = instance.at(targets.B, 0, []);
    instance.cancel(second);
    instance.cancel(first);
    expect(instance.at(targets.C, 0, [])).toBe(second);
    expect(instance.at(targets.A, 0, [])).toBe(first);
    instance.cancel(second);
    instance.cancel(second);
    scheduler.start();
    expect(trace).toEqual(['A@0:event']);
  });

  it('never executes a recycled ID through its cancelled old queue item', () => {
    const { scheduler, instance, targets, trace } = fixture();
    const old = instance.at(targets.A, 3, []);
    instance.cancel(old);
    expect(instance.at(targets.B, 9, [])).toBe(old);
    expect(scheduler.start({ until: 3 })).toEqual({ timePs: 3, executed: 0, reason: 'until' });
    expect(trace).toEqual([]);
    scheduler.start();
    expect(trace).toEqual(['B@9:event']);
  });

  it('cancels an already-due peer during A and reuses its ID without executing its old queue record', () => {
    const { scheduler, instance, targets, trace, actions } = fixture();
    let peer = 0;
    actions.set('A', () => {
      instance.cancel(peer);
      expect(instance.at(targets.B, scheduler.now, [])).toBe(peer);
    });
    instance.at(targets.A, 5, []);
    peer = instance.at(targets.C, 5, []);
    instance.at(targets.A, 8, []);
    scheduler.start({ until: 5 });
    expect(trace).toEqual(['A@5:event', 'B@5:event']);
    expect(scheduler.now).toBe(5);
  });

  it('keeps running IDs occupied through return, including self cancel', () => {
    const { scheduler, instance, targets, actions } = fixture();
    let next = 0;
    actions.set('A', (context) => {
      expect(context.eventId).toBe(1);
      instance.cancel(context.eventId);
      next = instance.at(targets.B, scheduler.now, []);
      expect(next).toBe(2);
    });
    instance.at(targets.A, 0, []);
    scheduler.step();
    expect(instance.at(targets.C, 0, [])).toBe(1);
    scheduler.start();
    expect(next).toBe(2);
  });

  it('separates instance identities and allows stable equal-ID events across instances', () => {
    const scheduler = createScheduler();
    const A = event('A');
    const trace: string[] = [];
    const make = (instanceId: string) =>
      scheduler.addInstance({
        instanceId,
        targets: [A],
        executor: {
          execute(_target, _args, context) {
            context.consumeSteps();
            trace.push(context.instanceId);
          },
        },
      });
    const first = make('first');
    const second = make('second');
    expect(first.at(A, 0, [])).toBe(1);
    expect(second.at(A, 0, [])).toBe(1);
    first.cancel(1);
    scheduler.start();
    expect(trace).toEqual(['second']);
    scheduler.destroyInstance(first);
    failure(() => make('first'), 'invalid-instance');
    failure(() => first.at(A, 0, []), 'invalid-instance');
  });
});

describe('deterministic segmented driving and destruction', () => {
  function run(mode: 'whole' | 'step' | 'time' | 'pause') {
    const value = fixture();
    const { scheduler, instance, targets, actions, trace } = value;
    let first = true;
    actions.set('A', () => {
      if (first) {
        first = false;
        scheduler.enqueueControl(instance, targets.P, []);
        instance.at(targets.B, scheduler.now, []);
        if (mode === 'pause') scheduler.pause();
      }
    });
    instance.at(targets.A, 5, []);
    instance.at(targets.C, 5, []);
    instance.at(targets.A, 20, []);
    if (mode === 'step') {
      for (let i = 0; i < 5; i += 1) scheduler.step();
    } else if (mode === 'time') {
      scheduler.start({ until: 5 });
      scheduler.start({ until: 7 });
      scheduler.start();
    } else {
      scheduler.start();
      if (mode === 'pause') scheduler.start();
    }
    expect(scheduler.now).toBe(20);
    return trace;
  }

  it('has identical traces for whole, step, until slices, and requested pause', () => {
    const expected = run('whole');
    expect(run('step')).toEqual(expected);
    expect(run('time')).toEqual(expected);
    expect(run('pause')).toEqual(expected);
  });

  it('pauses after return and step preserves pending controls ahead of ordinary events', () => {
    const { scheduler, instance, targets, actions, trace } = fixture();
    actions.set('A', () => {
      scheduler.enqueueControl(instance, targets.P, []);
      scheduler.pause();
      trace.push('A-return');
    });
    instance.at(targets.A, 4, []);
    instance.at(targets.C, 4, []);
    expect(scheduler.start({ until: 100 })).toEqual({ timePs: 4, executed: 1, reason: 'paused' });
    expect(trace).toEqual(['A@4:event', 'A-return']);
    scheduler.step();
    expect(trace.at(-1)).toBe('P@4:control');
    scheduler.start();
    expect(trace.at(-1)).toBe('C@4:event');
    scheduler.pause();
    scheduler.pause();
  });

  it('does not advance on entry-limit zero, and completes inclusive until before advancing', () => {
    const { scheduler, instance, targets } = fixture();
    instance.at(targets.A, 5, []);
    expect(scheduler.start({ until: 10, maxEntries: 0 })).toEqual({
      timePs: 0,
      executed: 0,
      reason: 'entry-limit',
    });
    expect(scheduler.start({ until: 10, maxEntries: 1 })).toEqual({
      timePs: 5,
      executed: 1,
      reason: 'entry-limit',
    });
    expect(scheduler.start({ until: 10 })).toEqual({ timePs: 10, executed: 0, reason: 'until' });
    expect(scheduler.start()).toEqual({ timePs: 10, executed: 0, reason: 'empty' });
  });

  it('destroys only at return, cancels ordinary and control work, and never reuses instance IDs', () => {
    const { scheduler, instance, targets, actions, trace } = fixture();
    actions.set('A', () => {
      scheduler.enqueueControl(instance, targets.P, []);
      scheduler.destroyInstance(instance);
      trace.push('A-finished');
    });
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 0, []);
    scheduler.start();
    expect(trace).toEqual(['A@0:event', 'A-finished']);
    failure(() => instance.cancel(0), 'invalid-instance');
    failure(() => scheduler.destroyInstance(instance), 'invalid-instance');
  });

  const gc = (globalThis as unknown as { gc?: () => void }).gc;

  it.skipIf(gc === undefined)(
    'releases destroyed instance records, queued work, and executor for collection',
    async () => {
      const scheduler = createScheduler();
      const references = (() => {
        const target = event('A');
        const executor = { execute() {} };
        const instance = scheduler.addInstance({
          instanceId: 'collected',
          targets: [target],
          executor,
        });
        instance.at(target, 50, []);
        scheduler.destroyInstance(instance);
        return [new WeakRef(executor), new WeakRef(target), new WeakRef(instance)] as const;
      })();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        gc!();
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
      }
      expect(references.map((reference) => reference.deref())).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      failure(
        () =>
          scheduler.addInstance({
            instanceId: 'collected',
            targets: [],
            executor: { execute() {} },
          }),
        'invalid-instance',
      );
      expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
    },
  );

  it.skipIf(gc === undefined)(
    'releases a destroyed instance whose only queued work is a control entry',
    async () => {
      const scheduler = createScheduler();
      const references = (() => {
        const target = control('P');
        const executor = { execute() {} };
        const instance = scheduler.addInstance({
          instanceId: 'control-collected',
          targets: [target],
          executor,
        });
        scheduler.enqueueControl(instance, target, []);
        scheduler.destroyInstance(instance);
        return [new WeakRef(executor), new WeakRef(target), new WeakRef(instance)] as const;
      })();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        gc!();
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
      }
      expect(references.map((reference) => reference.deref())).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
    },
  );
});

describe('deterministic budgets and global faults', () => {
  it('limits long zero-time feedback across slices without inventing 1 ps', () => {
    const { scheduler, instance, targets, actions, trace } = fixture({ maxEntriesPerTime: 10_000 });
    actions.set('A', () => instance.at(targets.A, scheduler.now, []));
    instance.at(targets.A, 8, []);
    for (let i = 0; i < 10; i += 1) scheduler.start({ maxEntries: 1000 });
    expect(trace).toHaveLength(10_000);
    const error = failure(() => scheduler.step(), 'time-budget-exhausted');
    expect(error).toMatchObject({
      instanceId: 'instance',
      targetName: 'A',
      phase: 'event',
      timePs: 8,
      entriesAtTime: 10_000,
      steps: 0,
    });
    expect(scheduler.now).toBe(8);
    expect(scheduler.state).toBe('faulted');
    failure(() => scheduler.start(), 'scheduler-faulted');
    failure(() => instance.cancel(0), 'scheduler-faulted');
  });

  it('counts ordinary and control entries together and resets only at a new time', () => {
    const { scheduler, instance, targets, actions, trace } = fixture({ maxEntriesPerTime: 2 });
    actions.set('A', () => scheduler.enqueueControl(instance, targets.P, []));
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 1, []);
    scheduler.start();
    expect(trace).toEqual(['A@0:event', 'P@0:control', 'C@1:event']);
    instance.at(targets.A, 1, []);
    failure(() => scheduler.start(), 'time-budget-exhausted');
    expect(trace.at(-1)).toBe('A@1:event');
  });

  it('bounds infinite control feedback in later control rounds', () => {
    const { scheduler, instance, targets, actions, trace } = fixture({ maxEntriesPerTime: 30 });
    actions.set('P', () => scheduler.enqueueControl(instance, targets.P, []));
    scheduler.enqueueControl(instance, targets.P, []);
    instance.at(targets.C, 0, []);
    failure(() => scheduler.start(), 'time-budget-exhausted');
    expect(trace).toHaveLength(30);
    expect(trace.every((value) => value === 'P@0:control')).toBe(true);
  });

  it('does not report previous entry steps on boundary failures', () => {
    const { scheduler, instance, targets, actions } = fixture();
    actions.set('A', (context) => {
      context.consumeSteps();
      context.consumeSteps();
    });
    instance.at(targets.A, 0, []);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 1, reason: 'empty' });
    const cases = [
      [() => instance.at(targets.A, 0, [true]), 'invalid-argument'],
      [() => instance.at(targets.P, 0, []), 'invalid-target'],
      [() => scheduler.enqueueControl(instance, targets.A, []), 'invalid-target'],
    ] as const;
    for (const [run, code] of cases) {
      const error = failure(run, code);
      expect(error.steps).toBe(0);
      expect(error.instanceId).toBeUndefined();
      expect(error.targetName).toBeUndefined();
      expect(error.phase).toBeUndefined();
    }
  });

  it('retains earlier committed effects and scheduled work when a later reference step fails', () => {
    const { scheduler, instance, targets, actions, trace } = fixture({ maxStepsPerEntry: 2 });
    let committed = 0;
    actions.set('A', (context) => {
      committed = 1;
      instance.at(targets.B, 3, []);
      context.consumeSteps();
      committed = 2;
      context.consumeSteps();
      committed = 3;
    });
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 0, []);
    const error = failure(() => scheduler.start(), 'entry-budget-exhausted');
    expect(committed).toBe(2);
    expect(trace).toEqual(['A@0:event']);
    expect(error).toMatchObject({
      steps: 2,
      timePs: 0,
      targetName: 'A',
      instanceId: 'instance',
      eventId: 1,
    });
    expect(scheduler.error).toBe(error);
    failure(() => scheduler.step(), 'scheduler-faulted');
  });

  it('latches swallowed scheduling errors and rejects reentrant execution', () => {
    const { scheduler, instance, targets, actions, trace } = fixture();
    actions.set('A', () => {
      try {
        scheduler.step();
      } catch {
        /* A trusted backend cannot clear the global fault. */
      }
    });
    instance.at(targets.A, 0, []);
    instance.at(targets.C, 0, []);
    failure(() => scheduler.start(), 'reentrant-execution');
    expect(scheduler.state).toBe('faulted');
    expect(trace).toEqual(['A@0:event']);
  });

  it('preserves backend cause and refuses implicit fault recovery', () => {
    const { scheduler, instance, targets, actions } = fixture();
    const cause = new Error('model failure');
    actions.set('A', () => {
      throw cause;
    });
    instance.at(targets.A, 7, []);
    const error = failure(() => scheduler.start(), 'execution-failed');
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({
      instanceId: 'instance',
      targetName: 'A',
      eventId: 1,
      phase: 'event',
      timePs: 7,
      steps: 1,
    });
    scheduler.pause();
    expect(scheduler.state).toBe('faulted');
  });

  it.each(['maxStepsPerEntry', 'maxEntriesPerTime'] as const)(
    'rejects invalid %s and accepts zero as no-execution',
    (name) => {
      for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        failure(() => createScheduler({ [name]: value }), 'invalid-options');
      }
      const { scheduler, instance, targets, trace } = fixture({ [name]: 0 });
      instance.at(targets.A, 0, []);
      failure(
        () => scheduler.start(),
        name === 'maxStepsPerEntry' ? 'entry-budget-exhausted' : 'time-budget-exhausted',
      );
      expect(trace).toEqual([]);
    },
  );

  it('rejects async executors before effects and Promise-returning functions after their committed prefix', async () => {
    const scheduler = createScheduler();
    let effects = 0;
    failure(
      () =>
        scheduler.addInstance({
          instanceId: 'async',
          targets: [],
          executor: {
            async execute() {
              effects += 1;
            },
          },
        }),
      'executor-contract',
    );
    expect(effects).toBe(0);
    const A = event('A');
    const instance = scheduler.addInstance({
      instanceId: 'promise',
      targets: [A],
      executor: {
        execute() {
          effects += 1;
          return Promise.reject(new Error('later'));
        },
      },
    });
    instance.at(A, 0, []);
    failure(() => scheduler.start(), 'executor-contract');
    expect(effects).toBe(1);
    await Promise.resolve();
  });
});
