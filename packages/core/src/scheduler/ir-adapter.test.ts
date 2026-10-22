import { describe, expect, it } from 'vitest';
import {
  createIRModule,
  IRExecutionError,
  type EntryRef,
  type IRModule,
  type IRValidationOptions,
  type RuntimeScalar,
} from '@mica-js/ir';
import { createIRSchedulerInstance, createScheduler, SchedulerError } from '../index';
import type { SchedulerErrorCode } from '../index';

function policy(module: IRModule): IRValidationOptions {
  const instructions = new Set(['return', 'jump', 'branch', 'trap']);
  for (const fn of module.functions) {
    for (const block of fn.body?.blocks ?? []) {
      for (const node of block.instructions) instructions.add(node.op);
    }
  }
  return {
    supportedInstructions: [...instructions],
    authorizedInstructions: [...instructions],
    resources: module.memories.map((memory) => ({
      ref: memory.ref,
      access: memory.writable ? 'read-write' : 'read',
    })),
  };
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

function traceFixture() {
  const module = createIRModule();
  const size = module.state('size', 'u32', 0);
  const trace = module.array(
    'trace',
    'u32',
    Array.from({ length: 16 }, () => 0),
  );
  const append = module.func('append', { params: ['u32'], results: [] });
  append.body((b, [value]) => {
    const index = b.state.load(size);
    b.array.store(trace, index, value);
    b.state.store(size, b.int.add(index, b.const('u32', 1)));
    b.return([]);
  });
  const A = module.entry('A', []);
  const B = module.entry('B', ['u32']);
  const C = module.entry('C', []);
  A.body((b) => {
    b.call(append, [b.const('u32', 1)]);
    b.event.at(B, b.event.now(), [b.const('u32', 3)]);
    b.return([]);
  });
  B.body((b, [value]) => {
    b.call(append, [value]);
    b.return([]);
  });
  C.body((b) => {
    b.call(append, [b.const('u32', 2)]);
    b.return([]);
  });
  return { module, size, trace, A, B, C };
}

describe('real IR event execution through the public core entry', () => {
  it('runs real state and array effects in A/C/B order across start/step/time segments', () => {
    for (const mode of ['whole', 'step', 'time']) {
      const { module, size, trace, A, C } = traceFixture();
      const scheduler = createScheduler();
      const instance = createIRSchedulerInstance(scheduler, {
        instanceId: mode,
        module,
        validation: policy(module),
      });
      instance.at(A, 5, []);
      instance.at(C, 5, []);
      if (mode === 'step') {
        scheduler.step();
        scheduler.step();
        scheduler.step();
      } else if (mode === 'time') {
        scheduler.start({ until: 3 });
        scheduler.start({ until: 5 });
      } else scheduler.start();
      expect(instance.storage.loadState(size)).toBe(3);
      expect([0, 1, 2].map((index) => instance.storage.loadArray(trace, index))).toEqual([1, 2, 3]);
      expect(scheduler.now).toBe(5);
    }
  });

  it('captures state scalar arguments before later stores and preserves raw floating bits', () => {
    const module = createIRModule();
    const source = module.state('source', 'u32', 0);
    const received = module.state('received', 'u32', 0);
    const floating = module.state('floating', 'f64', 0);
    const pair = module.entry('pair', ['u32', 'f64']);
    pair.body((b, [value, bits]) => {
      b.state.store(received, value);
      b.state.store(floating, bits);
      b.return([]);
    });
    const A = module.entry('A', []);
    A.body((b) => {
      b.state.store(source, b.const('u32', 7));
      b.event.at(pair, b.event.now(), [b.state.load(source), b.bits('f64', '0x7ff8000000000042')]);
      b.state.store(source, b.const('u32', 9));
      b.return([]);
    });
    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'capture',
      module,
      validation: policy(module),
    });
    instance.at(A, 0, []);
    scheduler.start();
    expect(instance.storage.loadState(source)).toBe(9);
    expect(instance.storage.loadState(received)).toBe(7);
    expect(instance.storage.loadState(floating)).toEqual({
      type: 'f64',
      bits: '0x7ff8000000000042',
    });
  });

  it('executes IR cancellation, ID FIFO and old queue record isolation using one allocator', () => {
    const module = createIRModule();
    const oldId = module.state('oldId', 'u32', 0);
    const currentId = module.state('currentId', 'u32', 0);
    const received = module.state('received', 'u32', 0);
    const B = module.entry('B', ['u32']);
    B.body((b, [value]) => {
      b.state.store(received, value);
      b.return([]);
    });
    const A = module.entry('A', []);
    A.body((b) => {
      b.event.cancel(b.const('u32', 0));
      const old = b.event.at(B, b.const('f64', 1), [b.const('u32', 3)]);
      b.event.cancel(old);
      const current = b.event.at(B, b.const('f64', 9), [b.const('u32', 7)]);
      b.state.store(oldId, old);
      b.state.store(currentId, current);
      b.return([]);
    });
    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'ids',
      module,
      validation: policy(module),
    });
    expect(instance.at(A, 0, [])).toBe(1);
    scheduler.start({ until: 1 });
    expect(instance.storage.loadState(oldId)).toBe(2);
    expect(instance.storage.loadState(currentId)).toBe(2);
    expect(instance.storage.loadState(received)).toBe(0);
    scheduler.start();
    expect(instance.storage.loadState(received)).toBe(7);
    expect(scheduler.now).toBe(9);
  });

  it('executes lifecycle IR through the same interpreter without allowing at to elevate priority', () => {
    const module = createIRModule();
    const ready = module.state('ready', 'bool', false);
    const init = module.lifecycle('initialize', []);
    const later = module.entry('later', []);
    later.body((b) => {
      b.state.store(ready, b.const('bool', true));
      b.return([]);
    });
    init.body((b) => {
      b.event.at(later, b.event.now(), []);
      b.return([]);
    });
    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'life',
      module,
      validation: policy(module),
    });
    failure(() => instance.at(init as unknown as EntryRef, 0, []), 'invalid-target');
    instance.enqueueControl(init, []);
    scheduler.step();
    expect(instance.storage.loadState(ready)).toBe(false);
    scheduler.step();
    expect(instance.storage.loadState(ready)).toBe(true);
    scheduler.destroyInstance(instance.instance);
    failure(() => instance.at(later, 0, []), 'invalid-instance');
  });

  it.each([0.5, -1, Infinity, 7_200_000_000_000_001, 3])(
    'faults invalid/past IR deadline %s after retaining committed state and queues',
    (deadline) => {
      const module = createIRModule();
      const committed = module.state('committed', 'u32', 0);
      const pending = module.entry('pending', []);
      pending.body((b) => {
        b.state.store(committed, b.const('u32', 99));
        b.return([]);
      });
      const bad = module.entry('bad', []);
      bad.body((b) => {
        b.state.store(committed, b.const('u32', 1));
        b.event.at(pending, b.const('f64', 9), []);
        b.event.at(pending, b.const('f64', deadline), []);
        b.state.store(committed, b.const('u32', 2));
        b.return([]);
      });
      const scheduler = createScheduler();
      const instance = createIRSchedulerInstance(scheduler, {
        instanceId: 'bad',
        module,
        validation: policy(module),
      });
      instance.at(bad, 5, []);
      const error = failure(() => scheduler.start(), 'execution-failed');
      expect(instance.storage.loadState(committed)).toBe(1);
      expect(error.cause).toBeInstanceOf(IRExecutionError);
      const ir = error.cause as IRExecutionError;
      expect(ir.location).toMatchObject({ functionName: 'bad' });
      expect(ir.context).toEqual({ instanceId: 'bad', virtualTime: 5 });
      expect(ir.cause).toBeInstanceOf(
        deadline === 0.5 || deadline === Infinity ? TypeError : RangeError,
      );
      expect(scheduler.now).toBe(5);
      failure(() => scheduler.step(), 'scheduler-faulted');
    },
  );

  it('destroys a faulted instance without resuming or clearing the fault', () => {
    const module = createIRModule();
    const committed = module.state('committed', 'u32', 0);
    const later = module.entry('later', []);
    later.body((b) => {
      b.state.store(committed, b.const('u32', 2));
      b.return([]);
    });
    const bad = module.entry('bad', []);
    bad.body((b) => {
      b.state.store(committed, b.const('u32', 1));
      b.trap('boom');
    });
    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'fault-destroy',
      module,
      validation: policy(module),
    });
    instance.at(later, 10, []);
    instance.at(bad, 0, []);
    const error = failure(() => scheduler.start(), 'execution-failed');
    expect(scheduler.state).toBe('faulted');
    expect(scheduler.now).toBe(0);
    expect(instance.storage.loadState(committed)).toBe(1);

    expect(() => scheduler.destroyInstance(instance.instance)).not.toThrow();
    expect(scheduler.state).toBe('faulted');
    expect(scheduler.error?.code).toBe(error.code);
    failure(() => scheduler.destroyInstance(instance.instance), 'scheduler-faulted');
    failure(() => scheduler.step(), 'scheduler-faulted');
    expect(instance.storage.loadState(committed)).toBe(1);
  });

  it('preserves original IR trap and calling position after prior effects', () => {
    const module = createIRModule();
    const committed = module.state('committed', 'u32', 0);
    const fail = module.func('fail', { params: [], results: [] });
    fail.body((b) => {
      b.state.store(committed, b.const('u32', 1));
      b.trap('invalidState');
    });
    const A = module.entry('A', []);
    A.body((b) => {
      b.call(fail, []);
      b.state.store(committed, b.const('u32', 2));
      b.return([]);
    });
    const scheduler = createScheduler();
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'fault',
      module,
      validation: policy(module),
    });
    instance.at(A, 0, []);
    const error = failure(() => scheduler.start(), 'execution-failed');
    const cause = error.cause as IRExecutionError;
    expect(cause.code).toBe('trap');
    expect(cause.callStack.map((frame) => frame.functionName)).toEqual(['A', 'fail']);
    expect(instance.storage.loadState(committed)).toBe(1);
  });

  it('enforces real IR step budget across ordinary calls with location retained', () => {
    const module = createIRModule();
    const state = module.state('state', 'u32', 0);
    const nested = module.func('nested', { params: [], results: [] });
    nested.body((b) => {
      b.state.store(state, b.const('u32', 7));
      b.return([]);
    });
    const A = module.entry('A', []);
    A.body((b) => {
      b.call(nested, []);
      b.return([]);
    });
    const scheduler = createScheduler({ maxStepsPerEntry: 3 });
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'steps',
      module,
      validation: policy(module),
    });
    instance.at(A, 0, []);
    const error = failure(() => scheduler.start(), 'entry-budget-exhausted');
    expect(error.steps).toBe(3);
    expect(error.cause).toBeInstanceOf(IRExecutionError);
    expect((error.cause as IRExecutionError).location).toMatchObject({
      functionName: 'nested',
      terminator: true,
    });
    expect(instance.storage.loadState(state)).toBe(7);
  });

  it('honors a configured reference budget above the standalone interpreter default', () => {
    const module = createIRModule();
    const finished = module.state('finished', 'bool', false);
    const run = module.entry('run', ['u32']);
    run.body((b, [count]) => {
      const one = b.const('u32', 1);
      const zero = b.const('u32', 0);
      const loop = b.block(['u32']);
      const body = b.block(['u32']);
      const done = b.block([]);
      b.jump(loop, [count]);
      b.at(loop, (b, [remaining]) =>
        b.branch(
          b.int.cmp('gt', remaining, zero),
          { target: body, args: [remaining] },
          { target: done, args: [] },
        ),
      );
      b.at(body, (b, [remaining]) => b.jump(loop, [b.int.sub(remaining, one)]));
      b.at(done, (b) => {
        b.state.store(finished, b.const('bool', true));
        b.return([]);
      });
    });
    const scheduler = createScheduler({ maxStepsPerEntry: 1_000_020 });
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'large-budget',
      module,
      validation: policy(module),
    });
    instance.at(run, 0, [250_001]);
    expect(scheduler.start().executed).toBe(1);
    expect(instance.storage.loadState(finished)).toBe(true);
  });

  it('enforces IR zero-delay feedback budget across slices without changing time', () => {
    const module = createIRModule();
    const total = module.state('total', 'u32', 0);
    const again = module.entry('again', []);
    again.body((b) => {
      b.state.store(total, b.int.add(b.state.load(total), b.const('u32', 1)));
      b.event.at(again, b.event.now(), []);
      b.return([]);
    });
    const scheduler = createScheduler({ maxEntriesPerTime: 200 });
    const instance = createIRSchedulerInstance(scheduler, {
      instanceId: 'feedback',
      module,
      validation: policy(module),
    });
    instance.at(again, 0, []);
    scheduler.start({ maxEntries: 100 });
    scheduler.start({ maxEntries: 100 });
    failure(() => scheduler.step(), 'time-budget-exhausted');
    expect(instance.storage.loadState(total)).toBe(200);
    expect(scheduler.now).toBe(0);
  });

  it('retains explicit supported/authorized policies and rejects unimplemented capabilities', () => {
    const { module } = traceFixture();
    const validation = policy(module);
    expect(() =>
      createIRSchedulerInstance(createScheduler(), {
        instanceId: 'denied',
        module,
        validation: {
          ...validation,
          authorizedInstructions: validation.authorizedInstructions.filter(
            (op) => op !== 'event.at',
          ),
        },
      }),
    ).toThrow(IRExecutionError);
  });

  it('validates host arguments completely and shares no per-instance storage or IDs', () => {
    const module = createIRModule();
    const value = module.state('value', 'u32', 0);
    const entry = module.entry('entry', ['u32']);
    entry.body((b, [arg]) => {
      b.state.store(value, arg);
      b.return([]);
    });
    const scheduler = createScheduler();
    const first = createIRSchedulerInstance(scheduler, {
      instanceId: 'first',
      module,
      validation: policy(module),
    });
    const second = createIRSchedulerInstance(scheduler, {
      instanceId: 'second',
      module,
      validation: policy(module),
    });
    failure(() => first.at(entry, 0, [true] as RuntimeScalar[]), 'invalid-argument');
    expect(first.at(entry, 0, [7])).toBe(1);
    expect(second.at(entry, 0, [9])).toBe(1);
    scheduler.start();
    expect(first.storage.loadState(value)).toBe(7);
    expect(second.storage.loadState(value)).toBe(9);
  });
});
