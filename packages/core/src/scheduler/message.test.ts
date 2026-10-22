import { describe, expect, it } from 'vitest';
import { createScheduler } from './runtime';
import { SchedulerError } from './errors';
import type { SchedulerErrorCode } from './errors';
import type { SchedulerExecutionContext, SchedulerTarget } from './types';

const event = (name: string, params: SchedulerTarget['params'] = []): SchedulerTarget => ({
  name,
  kind: 'event',
  params,
});
const control = (name: string): SchedulerTarget => ({ name, kind: 'control', params: [] });

interface Entry {
  readonly name: string;
  readonly time: number;
  readonly phase: 'event' | 'control';
  readonly eventId: number;
  readonly messageId: number;
  readonly args: readonly (boolean | number)[];
}

function fixture() {
  const scheduler = createScheduler();
  const targets = {
    A: event('A'),
    B: event('B'),
    M: event('M', ['u32']),
    P: control('P'),
  };
  const trace: Entry[] = [];
  const actions = new Map<string, (context: SchedulerExecutionContext) => void>();
  const instance = scheduler.addInstance({
    instanceId: 'instance',
    targets: Object.values(targets),
    executor: {
      execute(target, args, context) {
        context.consumeSteps();
        trace.push({
          name: target.name,
          time: context.timePs,
          phase: context.phase,
          eventId: context.eventId,
          messageId: context.messageId,
          args: args as readonly (boolean | number)[],
        });
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

describe('ordinary message admission', () => {
  it('accepts a message at the current time without an event id or time advance', () => {
    const { scheduler, instance, targets, trace } = fixture();
    instance.at(targets.A, 0, []);
    const messageId = scheduler.enqueueMessage(instance, targets.M, [7]);
    expect(messageId).toBe(1);
    expect(scheduler.now).toBe(0);
    expect(trace).toEqual([]);
    const eventId = instance.at(targets.B, 0, []);
    expect(eventId).toBe(2);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 3, reason: 'empty' });
    expect(trace).toEqual([
      { name: 'A', time: 0, phase: 'event', eventId: 1, messageId: 0, args: [] },
      { name: 'M', time: 0, phase: 'event', eventId: 0, messageId: 1, args: [7] },
      { name: 'B', time: 0, phase: 'event', eventId: 2, messageId: 0, args: [] },
    ]);
  });

  it('runs messages enqueued inside an entry after the current ordinary round', () => {
    const { scheduler, instance, targets, trace, actions } = fixture();
    let messageId = 0;
    actions.set('A', () => {
      messageId = scheduler.enqueueMessage(instance, targets.M, [3]);
      instance.at(targets.B, 0, []);
    });
    instance.at(targets.A, 0, []);
    scheduler.start();
    expect(messageId).toBe(1);
    expect(trace.map((entry) => `${entry.name}:${entry.messageId}`)).toEqual(['A:0', 'M:1', 'B:0']);
    expect(trace[1]!.args).toEqual([3]);
  });

  it('keeps message ids positive and unique per instance', () => {
    const { scheduler, instance, targets } = fixture();
    const first = scheduler.enqueueMessage(instance, targets.M, [1]);
    const second = scheduler.enqueueMessage(instance, targets.M, [2]);
    expect(first).toBe(1);
    expect(second).toBe(2);
    scheduler.start();
  });

  it('rejects control targets, malformed arguments and invalid handles', () => {
    const { scheduler, instance, targets } = fixture();
    failure(() => scheduler.enqueueMessage(instance, targets.P, []), 'invalid-target');
    failure(() => scheduler.enqueueMessage(instance, targets.M, []), 'invalid-argument');
    failure(
      () => scheduler.enqueueMessage(instance, targets.M, [0x1_0000_0000]),
      'invalid-argument',
    );
    const foreign = createScheduler();
    failure(() => foreign.enqueueMessage(instance, targets.M, [1]), 'invalid-instance');
  });

  it('does not expose message work to event cancellation or event id reuse', () => {
    const { scheduler, instance, targets } = fixture();
    const messageId = scheduler.enqueueMessage(instance, targets.M, [1]);
    failure(() => instance.cancel(messageId), 'invalid-event-id');
    expect(instance.at(targets.A, 0, [])).toBe(1);
    scheduler.start();
  });

  it('rejects admission after destroy and does not resurrect the instance', () => {
    const { scheduler, instance, targets } = fixture();
    scheduler.destroyInstance(instance);
    failure(() => scheduler.enqueueMessage(instance, targets.M, [1]), 'invalid-instance');
  });

  it('rejects admission after a scheduler fault', () => {
    const { scheduler, instance, targets, actions } = fixture();
    actions.set('A', () => {
      throw new Error('model failure');
    });
    instance.at(targets.A, 0, []);
    failure(() => scheduler.start(), 'execution-failed');
    failure(() => scheduler.enqueueMessage(instance, targets.M, [1]), 'scheduler-faulted');
  });
});
