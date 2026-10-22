import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import type { BytesRef, EntryRef, InboxRef, StateRef } from '@mica-js/ir';
import { createForTest, testDescription } from '../lifecycle/test-helpers';
import {
  BackpressureError,
  DeviceError,
  type DeviceAPI,
  type DeviceFactory,
  type DeviceInstance,
  type DeviceTopicMessage,
  type MessageCallback,
  type TopicMetadata,
  type TopicPayload,
} from '../index';

function description(
  ports: Readonly<
    Record<string, { readonly direction: 'input' | 'output'; readonly type: string }>
  >,
) {
  return testDescription({ ports });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error('Expected the promise to reject.');
}

function expectDeviceError(run: () => unknown, code: string): DeviceError {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(DeviceError);
  const error = caught as DeviceError;
  expect(error.code).toBe(code);
  return error;
}

describe('topic subscriptions and host delivery', () => {
  it('delivers to multiple listeners in registration order and publishes through onTopic', () => {
    const received: { payload: TopicPayload; simTime: number }[] = [];
    const published: DeviceTopicMessage[] = [];
    let api: DeviceAPI | undefined;
    const factory: DeviceFactory = (context) => {
      api = context;
      const listener: MessageCallback<TopicPayload, TopicMetadata> = (payload, meta) => {
        received.push({ payload, simTime: meta.simTime });
      };
      context.subscribe('value', listener);
      context.subscribe('value', (payload, meta) => {
        received.push({ payload, simTime: meta.simTime });
      });
      return {};
    };
    const { instance, scheduler } = createForTest(
      factory,
      {
        onTopic: (message) => {
          published.push(message);
        },
      },
      createScheduler(),
      description({
        value: { direction: 'input', type: 'number' },
        result: { direction: 'output', type: 'string' },
      }),
    );
    expect(instance.state).toBe('ready');
    instance.deliver('value', 5, { simTime: 7 });
    expect(received).toEqual([
      { payload: 5, simTime: 7 },
      { payload: 5, simTime: 7 },
    ]);
    api!.publish('result', 'ok');
    expect(published).toEqual([{ port: 'result', payload: 'ok' }]);
    expect(scheduler.now).toBe(0);
  });

  it('isolates byte payloads per listener and keeps the caller buffer independent', () => {
    const received: Uint8Array[] = [];
    const factory: DeviceFactory = (context) => {
      context.subscribe('packet', (payload) => {
        received.push(payload as Uint8Array);
      });
      context.subscribe('packet', (payload) => {
        received.push(payload as Uint8Array);
      });
      return {};
    };
    const { instance } = createForTest(
      factory,
      {},
      createScheduler(),
      description({ packet: { direction: 'input', type: 'bytes' } }),
    );
    const source = new Uint8Array([1, 2, 3]);
    instance.deliver('packet', source, { simTime: 0 });
    source[0] = 9;
    expect([...received[0]!]).toEqual([1, 2, 3]);
    expect([...received[1]!]).toEqual([1, 2, 3]);
    expect(received[0]).not.toBe(received[1]);
  });

  it('rejects unknown ports, wrong directions, duplicate callbacks and invalid payloads', () => {
    expectDeviceError(
      () =>
        createForTest(
          (context) => {
            context.subscribe('missing', () => undefined);
            return {};
          },
          {},
          createScheduler(),
          description({ value: { direction: 'input', type: 'number' } }),
        ),
      'device/topic-unknown',
    );

    expectDeviceError(
      () =>
        createForTest(
          (context) => {
            context.subscribe('result', () => undefined);
            return {};
          },
          {},
          createScheduler(),
          description({ result: { direction: 'output', type: 'number' } }),
        ),
      'device/topic-direction',
    );

    const duplicate = () => undefined;
    expectDeviceError(
      () =>
        createForTest(
          (context) => {
            context.subscribe('value', duplicate);
            context.subscribe('value', duplicate);
            return {};
          },
          {},
          createScheduler(),
          description({ value: { direction: 'input', type: 'number' } }),
        ),
      'device/topic-subscription',
    );

    let api: DeviceAPI | undefined;
    const { instance } = createForTest(
      (context) => {
        api = context;
        return {};
      },
      {},
      createScheduler(),
      description({
        value: { direction: 'input', type: 'number' },
        result: { direction: 'output', type: 'number' },
      }),
    );
    expectDeviceError(
      () => instance.deliver('value', Number.NaN, { simTime: 0 }),
      'device/topic-payload',
    );
    expectDeviceError(
      () => instance.deliver('value', Number.POSITIVE_INFINITY, { simTime: 0 }),
      'device/topic-payload',
    );
    expectDeviceError(() => api!.publish('result', Number.NaN), 'device/topic-payload');
    expectDeviceError(
      () => api!.publish('result', { x: 1, y: 2, z: 3 } as unknown as TopicPayload),
      'device/topic-payload',
    );
    expectDeviceError(() => api!.subscribe('value', () => undefined), 'device/factory-closed');
  });

  it('validates vec2d keys and simTime metadata', () => {
    const received: TopicPayload[] = [];
    const { instance } = createForTest(
      (context) => {
        context.subscribe('vector', (payload) => {
          received.push(payload);
        });
        return {};
      },
      {},
      createScheduler(),
      description({ vector: { direction: 'input', type: 'vec2d' } }),
    );
    instance.deliver('vector', { x: 1, y: 2 }, { simTime: 3 });
    expect(received).toEqual([{ x: 1, y: 2 }]);
    expectDeviceError(
      () =>
        instance.deliver('vector', { x: 1, y: 2, z: 3 } as unknown as TopicPayload, { simTime: 3 }),
      'device/topic-payload',
    );
    expectDeviceError(
      () => instance.deliver('vector', { x: 1, y: 2 }, { simTime: -1 }),
      'device/topic-payload',
    );
  });

  it('rejects an async onTopic host sink', () => {
    expectDeviceError(
      () =>
        createForTest(
          () => ({}),
          {
            onTopic: (async () => undefined) as unknown as (message: DeviceTopicMessage) => void,
          },
          createScheduler(),
        ),
      'device/message-callback',
    );
  });
});

describe('ordinary post and postBytes admission', () => {
  it('resolves post after acceptance and executes the entry only when the scheduler runs', async () => {
    let api: DeviceAPI | undefined;
    let entry: EntryRef<readonly ['u32']> | undefined;
    let state: StateRef<'u32'> | undefined;
    const { instance, scheduler } = createForTest((context) => {
      api = context;
      state = context.ir.state('state', 'u32', 0);
      entry = context.ir.entry('set', ['u32']);
      entry.body((b, [value]) => {
        b.state.store(state!, value);
        b.return([]);
      });
      return {};
    });
    await api!.post(entry!, [7]);
    expect(instance.storage.loadState(state!)).toBe(0);
    expect(scheduler.now).toBe(0);
    scheduler.start();
    expect(instance.storage.loadState(state!)).toBe(7);
    expect(scheduler.now).toBe(0);

    instance.destroy();
    const error = await rejection(api!.post(entry!, [1]));
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe('device/instance-destroyed');
  });

  it('rejects post during the factory before activation', async () => {
    let pending: Promise<void> | undefined;
    createForTest((context) => {
      const entry = context.ir.entry('set', ['u32']);
      entry.body((b) => b.return([]));
      pending = context.post(entry, [1]);
      return {};
    });
    const error = await rejection(pending!);
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe('device/not-active');
  });

  it('enforces postCapacity and releases an in-flight slot after execution', async () => {
    let api: DeviceAPI | undefined;
    let entry: EntryRef<readonly ['u32']> | undefined;
    const { scheduler } = createForTest(
      (context) => {
        api = context;
        entry = context.ir.entry('set', ['u32']);
        entry.body((b) => b.return([]));
        return {};
      },
      { messaging: { postCapacity: 1 } },
    );
    await api!.post(entry!, [1]);
    const error = await rejection(api!.post(entry!, [2]));
    expect(error).toBeInstanceOf(BackpressureError);
    scheduler.start();
    await api!.post(entry!, [3]);
  });

  it('rejects post targets that are not ordinary entries or have invalid arguments', async () => {
    let api: DeviceAPI | undefined;
    let entry: EntryRef<readonly ['u32']> | undefined;
    let fn: unknown;
    createForTest((context) => {
      api = context;
      entry = context.ir.entry('set', ['u32']);
      entry.body((b) => b.return([]));
      const ordinary = context.ir.func('fn', { params: ['u32'], results: [] });
      ordinary.body((b) => b.return([]));
      fn = ordinary;
      return {};
    });
    const error = await rejection(api!.post(fn as unknown as EntryRef<readonly ['u32']>, [1]));
    expect((error as DeviceError).code).toBe('device/message-target');
    const args = await rejection(api!.post(entry!, [0x1_0000_0000]));
    expect((args as DeviceError).code).toBe('device/message-target');
  });

  it('reserves, copies and releases inbox ranges for postBytes', async () => {
    let api: DeviceAPI | undefined;
    let receive: EntryRef<readonly ['u32', 'u32']> | undefined;
    let inbox: InboxRef | undefined;
    let saved: BytesRef<false> | undefined;
    let length: StateRef<'u32'> | undefined;
    const { instance, scheduler } = createForTest((context) => {
      api = context;
      inbox = context.ir.inbox('inbox', 4);
      saved = context.ir.bytes('saved', new Uint8Array(4), { readonly: false });
      length = context.ir.state('length', 'u32', 0);
      receive = context.ir.entry('receive', ['u32', 'u32']);
      receive.body((b, [offset, count]) => {
        b.bytes.copy(saved!, b.const('u32', 0), inbox!, offset, count);
        b.state.store(length!, count);
        b.return([]);
      });
      return {};
    });

    await api!.postBytes(receive!, inbox!, new Uint8Array([10, 20, 30]));
    const overflow = await rejection(api!.postBytes(receive!, inbox!, new Uint8Array([1, 2])));
    expect(overflow).toBeInstanceOf(BackpressureError);
    scheduler.start();
    expect(instance.storage.loadState(length!)).toBe(3);
    expect([...instance.storage.readVersionedBytes(saved!, 0, 4).bytes]).toEqual([10, 20, 30, 0]);

    await api!.postBytes(receive!, inbox!, new Uint8Array([1, 2, 3, 4]));
    scheduler.start();
    expect(instance.storage.loadState(length!)).toBe(4);
    expect([...instance.storage.readVersionedBytes(saved!, 0, 4).bytes]).toEqual([1, 2, 3, 4]);
  });

  it('accepts zero-length postBytes with offset 0 and no byte reservation', async () => {
    let api: DeviceAPI | undefined;
    let receive: EntryRef<readonly ['u32', 'u32']> | undefined;
    let inbox: InboxRef | undefined;
    let offsetState: StateRef<'u32'> | undefined;
    let lengthState: StateRef<'u32'> | undefined;
    const { instance, scheduler } = createForTest((context) => {
      api = context;
      inbox = context.ir.inbox('inbox', 2);
      offsetState = context.ir.state('offset', 'u32', 99);
      lengthState = context.ir.state('length', 'u32', 99);
      receive = context.ir.entry('receive', ['u32', 'u32']);
      receive.body((b, [offset, count]) => {
        b.state.store(offsetState!, offset);
        b.state.store(lengthState!, count);
        b.return([]);
      });
      return {};
    });
    await api!.postBytes(receive!, inbox!, new Uint8Array(0));
    scheduler.start();
    expect(instance.storage.loadState(offsetState!)).toBe(0);
    expect(instance.storage.loadState(lengthState!)).toBe(0);
  });

  it('rejects a non-inbox handle and a non-[u32,u32] entry for postBytes', async () => {
    let api: DeviceAPI | undefined;
    let inbox: InboxRef | undefined;
    let receive: EntryRef<readonly ['u32', 'u32']> | undefined;
    let bytesResource: BytesRef<false> | undefined;
    let wrongEntry: EntryRef<readonly ['u32']> | undefined;
    createForTest((context) => {
      api = context;
      inbox = context.ir.inbox('inbox', 2);
      bytesResource = context.ir.bytes('bytes', new Uint8Array(2), { readonly: false });
      wrongEntry = context.ir.entry('wrong', ['u32']);
      wrongEntry.body((b) => b.return([]));
      receive = context.ir.entry('receive', ['u32', 'u32']);
      receive.body((b) => {
        b.return([]);
      });
      return {};
    });
    const signatureError = await rejection(
      api!.postBytes(
        wrongEntry as unknown as EntryRef<readonly ['u32', 'u32']>,
        inbox!,
        new Uint8Array(1),
      ),
    );
    expect((signatureError as DeviceError).code).toBe('device/message-target');
    const resourceError = await rejection(
      api!.postBytes(receive!, bytesResource as unknown as InboxRef, new Uint8Array(1)),
    );
    expect((resourceError as DeviceError).code).toBe('device/inbox-reference');
  });
});

describe('IR outputs and output notifications', () => {
  it('notifies after the entry returns with captured time and payload', async () => {
    const calls: { kind: string; payload: unknown; timePs: number; busy: boolean }[] = [];
    const handle: { current?: DeviceInstance } = {};
    let api: DeviceAPI | undefined;
    let busy: StateRef<'bool'> | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    const created = createForTest(
      (context) => {
        api = context;
        busy = context.ir.state('busy', 'bool', false);
        const region = context.ir.bytes('region', new Uint8Array([1, 2, 3, 4]), {
          readonly: true,
        });
        const scalar = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        const bytes = context.ir.outputBytes('bytes', { maxBytes: 4, capacity: 1 });
        emit = context.ir.entry('emit', ['u32']);
        emit.body((b, [value]) => {
          b.state.store(busy!, b.const('bool', true));
          b.output(scalar, [value]);
          b.outputBytes(bytes, region, b.const('u32', 0), b.const('u32', 2));
          b.state.store(busy!, b.const('bool', false));
          b.return([]);
        });
        context.onOutput(scalar, (payload, meta) => {
          calls.push({
            kind: 'scalar',
            payload,
            timePs: meta.timePs,
            busy: handle.current!.storage.loadState(busy!),
          });
        });
        context.onOutput(bytes, (payload, meta) => {
          calls.push({
            kind: 'bytes',
            payload: [...payload],
            timePs: meta.timePs,
            busy: handle.current!.storage.loadState(busy!),
          });
        });
        return {};
      },
      {},
      createScheduler(),
    );
    const instance = created.instance;
    handle.current = instance;
    await api!.post(emit!, [5]);
    created.scheduler.start();
    expect(calls).toEqual([
      { kind: 'scalar', payload: [5], timePs: 0, busy: false },
      { kind: 'bytes', payload: [1, 2], timePs: 0, busy: false },
    ]);
  });

  it('rejects a second output consumer and supports unsubscribe', async () => {
    expectDeviceError(
      () =>
        createForTest((context) => {
          const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
          context.onOutput(output, () => undefined);
          context.onOutput(output, () => undefined);
          return {};
        }),
      'device/output-consumer',
    );

    const calls: number[] = [];
    let api: DeviceAPI | undefined;
    let unsubscribe: (() => void) | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    const { scheduler } = createForTest((context) => {
      api = context;
      const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
      emit = context.ir.entry('emit', ['u32']);
      emit.body((b, [value]) => {
        b.output(output, [value]);
        b.return([]);
      });
      unsubscribe = context.onOutput(output, (payload) => {
        calls.push(payload[0]);
      });
      return {};
    });
    await api!.post(emit!, [1]);
    scheduler.start();
    expect(calls).toEqual([1]);
    unsubscribe!();
    await api!.post(emit!, [2]);
    scheduler.start();
    expect(calls).toEqual([1]);
  });

  it('returns false when an output queue is full without notifying the rejected send', async () => {
    let api: DeviceAPI | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    let result: StateRef<'bool'> | undefined;
    const calls: number[] = [];
    const { scheduler } = createForTest((context) => {
      api = context;
      const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
      result = context.ir.state('result', 'bool', true);
      emit = context.ir.entry('emit', ['u32']);
      emit.body((b, [value]) => {
        b.output(output, [value]);
        const second = b.output(output, [b.const('u32', 9)]);
        b.state.store(result!, second);
        b.return([]);
      });
      context.onOutput(output, (payload) => {
        calls.push(payload[0]);
      });
      return {};
    });
    await api!.post(emit!, [1]);
    scheduler.start();
    expect(calls).toEqual([1]);
    // `createForTest` does not expose refs; the second send is covered by the callback count
    // and the explicit false result is asserted through a second fixture below.
    void result;
  });

  it('stores the false result of a rejected output send', async () => {
    let api: DeviceAPI | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    let result: StateRef<'bool'> | undefined;
    const { instance, scheduler } = createForTest((context) => {
      api = context;
      const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
      result = context.ir.state('result', 'bool', true);
      emit = context.ir.entry('emit', ['u32']);
      emit.body((b, [value]) => {
        b.output(output, [value]);
        const second = b.output(output, [b.const('u32', 9)]);
        b.state.store(result!, second);
        b.return([]);
      });
      context.onOutput(output, () => undefined);
      return {};
    });
    await api!.post(emit!, [1]);
    scheduler.start();
    expect(instance.storage.loadState(result!)).toBe(false);
  });

  it('stages initialize outputs and input deliveries until activation', async () => {
    const order: string[] = [];
    let api: DeviceAPI | undefined;
    let entry: EntryRef<readonly ['u32']> | undefined;
    let firmware: BytesRef<false> | undefined;
    const created = createForTest(
      (context) => {
        api = context;
        firmware = context.ir.bytes('firmware', new Uint8Array(2), { readonly: false });
        const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        const initialize = context.ir.lifecycle('initialize', []);
        initialize.body((b) => {
          b.output(output, [b.const('u32', 1)]);
          b.return([]);
        });
        context.onOutput(output, (payload, meta) => {
          order.push(`output:${payload[0]}:${meta.timePs}`);
        });
        context.subscribe('command', (payload, meta) => {
          order.push(`input:${payload}:${meta.simTime}`);
        });
        entry = context.ir.entry('set', ['u32']);
        entry.body((b) => b.return([]));
        return { initialize };
      },
      {},
      createScheduler(),
      description({
        command: { direction: 'input', type: 'number' },
        result: { direction: 'output', type: 'number' },
      }),
    );
    expect(created.instance.state).toBe('initializing');
    created.instance.deliver('command', 2, { simTime: 5 });
    const postError = await rejection(api!.post(entry!, [1]));
    expect((postError as DeviceError).code).toBe('device/not-active');
    const updateError = await rejection(api!.updateBytes(firmware!, 0, new Uint8Array([1])));
    expect((updateError as DeviceError).code).toBe('device/not-active');
    expectDeviceError(() => api!.publish('result', 1), 'device/not-active');
    created.scheduler.start();
    expect(created.instance.state).toBe('ready');
    expect(order).toEqual(['output:1:0', 'input:2:5']);
  });

  it('does not notify when initialize fails', () => {
    const order: string[] = [];
    const { instance, scheduler } = createForTest(
      (context) => {
        const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        const initialize = context.ir.lifecycle('initialize', []);
        initialize.body((b) => {
          b.output(output, [b.const('u32', 1)]);
          b.trap('initialize-failed');
        });
        context.onOutput(output, () => {
          order.push('output');
        });
        context.subscribe('command', () => {
          order.push('input');
        });
        return { initialize };
      },
      {},
      createScheduler(),
      description({ command: { direction: 'input', type: 'number' } }),
    );
    instance.deliver('command', 1, { simTime: 0 });
    expect(() => scheduler.start()).toThrow();
    expect(order).toEqual([]);
    expect(instance.state).toBe('faulted');
  });

  it('drops staged notifications on destroy before initialize', () => {
    const calls: number[] = [];
    const created = createForTest(
      (context) => {
        const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        const initialize = context.ir.lifecycle('initialize', []);
        initialize.body((b) => {
          b.output(output, [b.const('u32', 1)]);
          b.return([]);
        });
        context.onOutput(output, () => {
          calls.push(1);
        });
        return { initialize };
      },
      {},
      createScheduler(),
    );
    const instance = created.instance;
    instance.destroy();
    expect(created.scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
    expect(calls).toEqual([]);
    expect(instance.state).toBe('destroyed');
  });
});

describe('versioned byte updates', () => {
  it('commits content and versions atomically and rejects readonly or out-of-range requests', async () => {
    let api: DeviceAPI | undefined;
    let firmware: BytesRef<false> | undefined;
    let fixed: BytesRef<true> | undefined;
    const { instance } = createForTest((context) => {
      api = context;
      firmware = context.ir.bytes('firmware', new Uint8Array(4), {
        readonly: false,
        unitBytes: 2,
      });
      fixed = context.ir.bytes('fixed', new Uint8Array(2), { readonly: true });
      return {};
    });
    const before = instance.storage.readVersionedBytes(firmware!, 0, 4);
    await api!.updateBytes(firmware!, 1, new Uint8Array([9, 8]));
    const after = instance.storage.readVersionedBytes(firmware!, 0, 4);
    expect([...after.bytes]).toEqual([0, 9, 8, 0]);
    expect(after.dependencies[0]).not.toBe(before.dependencies[0]);
    expect(after.dependencies[1]).not.toBe(before.dependencies[1]);
    expect(after.dependencies[2]).toBe(before.dependencies[2]);

    const readonly = await rejection(api!.updateBytes(fixed!, 0, new Uint8Array([1])));
    expect((readonly as DeviceError).code).toBe('device/update-target');
    const range = await rejection(api!.updateBytes(firmware!, 3, new Uint8Array([1, 2])));
    expect((range as DeviceError).code).toBe('device/update-target');
    await api!.updateBytes(firmware!, 4, new Uint8Array(0));
    expect([...instance.storage.readVersionedBytes(firmware!, 0, 4).bytes]).toEqual([0, 9, 8, 0]);

    instance.destroy();
    const destroyed = await rejection(api!.updateBytes(firmware!, 0, new Uint8Array([1])));
    expect((destroyed as DeviceError).code).toBe('device/instance-destroyed');
  });

  it('queues updates from output callbacks and reports updateCapacity', async () => {
    let api: DeviceAPI | undefined;
    let firmware: BytesRef<false> | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    let first: Promise<void> | undefined;
    let secondError: unknown;
    const { instance, scheduler } = createForTest(
      (context) => {
        api = context;
        firmware = context.ir.bytes('firmware', new Uint8Array(2), {
          readonly: false,
        });
        const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        emit = context.ir.entry('emit', ['u32']);
        emit.body((b, [value]) => {
          b.output(output, [value]);
          b.return([]);
        });
        context.onOutput(output, () => {
          first = api!.updateBytes(firmware!, 0, new Uint8Array([7]));
          api!.updateBytes(firmware!, 1, new Uint8Array([8])).catch((cause: unknown) => {
            secondError = cause;
          });
        });
        return {};
      },
      { messaging: { updateCapacity: 1 } },
      createScheduler(),
    );
    await api!.post(emit!, [1]);
    scheduler.start();
    await first!;
    await Promise.resolve();
    expect(secondError).toBeInstanceOf(BackpressureError);
    expect([...instance.storage.readVersionedBytes(firmware!, 0, 2).bytes]).toEqual([7, 0]);
  });
});

describe('bounded queues and diagnostics', () => {
  it('enforces deliveryCapacity while initializing', () => {
    const created = createForTest(
      (context) => {
        const initialize = context.ir.lifecycle('initialize', []);
        initialize.body((b) => b.return([]));
        context.subscribe('command', () => undefined);
        return { initialize };
      },
      { messaging: { deliveryCapacity: 1 } },
      createScheduler(),
      description({ command: { direction: 'input', type: 'number' } }),
    );
    const instance = created.instance;
    instance.deliver('command', 1, { simTime: 0 });
    let caught: unknown;
    try {
      instance.deliver('command', 2, { simTime: 1 });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(BackpressureError);
  });

  it('enforces publishCapacity from a callback', async () => {
    const published: DeviceTopicMessage[] = [];
    let api: DeviceAPI | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    let publishError: unknown;
    const { scheduler } = createForTest(
      (context) => {
        api = context;
        const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
        emit = context.ir.entry('emit', ['u32']);
        emit.body((b, [value]) => {
          b.output(output, [value]);
          b.return([]);
        });
        context.onOutput(output, () => {
          api!.publish('result', 1);
          try {
            api!.publish('result', 2);
          } catch (cause) {
            publishError = cause;
          }
        });
        return {};
      },
      {
        messaging: { publishCapacity: 1 },
        onTopic: (message) => {
          published.push(message);
        },
      },
      createScheduler(),
      description({ result: { direction: 'output', type: 'number' } }),
    );
    await api!.post(emit!, [1]);
    scheduler.start();
    expect(publishError).toBeInstanceOf(BackpressureError);
    expect(published).toEqual([{ port: 'result', payload: 1 }]);
  });

  it('enforces the total output byte budget and reports false', async () => {
    let api: DeviceAPI | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    let result: StateRef<'bool'> | undefined;
    const calls: number[] = [];
    const { instance, scheduler } = createForTest(
      (context) => {
        api = context;
        const region = context.ir.bytes('region', new Uint8Array([1, 2, 3, 4]), {
          readonly: true,
        });
        const output = context.ir.outputBytes('bytes', { maxBytes: 4, capacity: 2 });
        result = context.ir.state('result', 'bool', true);
        emit = context.ir.entry('emit', ['u32']);
        emit.body((b) => {
          b.outputBytes(output, region, b.const('u32', 0), b.const('u32', 2));
          const second = b.outputBytes(output, region, b.const('u32', 2), b.const('u32', 2));
          b.state.store(result!, second);
          b.return([]);
        });
        context.onOutput(output, () => {
          calls.push(1);
        });
        return {};
      },
      { messaging: { outputByteBudget: 2 } },
      createScheduler(),
    );
    await api!.post(emit!, [1]);
    scheduler.start();
    expect(calls).toHaveLength(1);
    expect(instance.storage.loadState(result!)).toBe(false);
  });
});

describe('additional messaging contract edges', () => {
  it('stops topic delivery after unsubscribe without revoking acceptance', () => {
    const received: TopicPayload[] = [];
    let unsubscribe: (() => void) | undefined;
    const { instance } = createForTest(
      (context) => {
        unsubscribe = context.subscribe('value', (payload) => {
          received.push(payload);
        });
        return {};
      },
      {},
      createScheduler(),
      description({ value: { direction: 'input', type: 'number' } }),
    );
    instance.deliver('value', 1, { simTime: 0 });
    unsubscribe!();
    unsubscribe!();
    instance.deliver('value', 2, { simTime: 1 });
    expect(received).toEqual([1]);
  });

  it('delivers outputs captured before a later entry trap', async () => {
    const calls: number[] = [];
    let api: DeviceAPI | undefined;
    let emit: EntryRef<readonly ['u32']> | undefined;
    const { instance, scheduler } = createForTest((context) => {
      api = context;
      const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
      emit = context.ir.entry('emit', ['u32']);
      emit.body((b, [value]) => {
        b.output(output, [value]);
        b.trap('after-output');
      });
      context.onOutput(output, (payload) => {
        calls.push(payload[0]);
      });
      return {};
    });
    await api!.post(emit!, [4]);
    expect(() => scheduler.start()).toThrow();
    expect(calls).toEqual([4]);
    expect(instance.state).toBe('faulted');
  });

  it('keeps inbox slots isolated between instances', async () => {
    interface Captured {
      api: DeviceAPI;
      receive: EntryRef<readonly ['u32', 'u32']>;
      inbox: InboxRef;
      saved: BytesRef<false>;
      length: StateRef<'u32'>;
    }
    const captured: Captured[] = [];
    const scheduler = createScheduler();
    const factory: DeviceFactory = (context) => {
      const inbox = context.ir.inbox('inbox', 4);
      const saved = context.ir.bytes('saved', new Uint8Array(4), { readonly: false });
      const length = context.ir.state('length', 'u32', 0);
      const receive = context.ir.entry('receive', ['u32', 'u32']);
      receive.body((b, [offset, count]) => {
        b.bytes.copy(saved, b.const('u32', 0), inbox, offset, count);
        b.state.store(length, count);
        b.return([]);
      });
      captured.push({ api: context, receive, inbox, saved, length });
      return {};
    };
    const first = createForTest(factory, { instanceId: 'first' }, scheduler, description({}));
    const second = createForTest(factory, { instanceId: 'second' }, scheduler, description({}));
    await captured[0]!.api.postBytes(
      captured[0]!.receive,
      captured[0]!.inbox,
      new Uint8Array([1, 2, 3]),
    );
    await captured[1]!.api.postBytes(captured[1]!.receive, captured[1]!.inbox, new Uint8Array([9]));
    scheduler.start();
    expect([...first.instance.storage.readVersionedBytes(captured[0]!.saved, 0, 4).bytes]).toEqual([
      1, 2, 3, 0,
    ]);
    expect([...second.instance.storage.readVersionedBytes(captured[1]!.saved, 0, 4).bytes]).toEqual(
      [9, 0, 0, 0],
    );
  });

  it('rejects publish and deliver after destroy and tolerates an absent onTopic sink', () => {
    let api: DeviceAPI | undefined;
    const { instance } = createForTest(
      (context) => {
        api = context;
        return {};
      },
      {},
      createScheduler(),
      description({
        value: { direction: 'input', type: 'number' },
        result: { direction: 'output', type: 'number' },
      }),
    );
    api!.publish('result', 1);
    instance.destroy();
    expectDeviceError(() => api!.publish('result', 2), 'device/instance-destroyed');
    expectDeviceError(
      () => instance.deliver('value', 1, { simTime: 0 }),
      'device/instance-destroyed',
    );
  });

  it('removes staged listeners when linking fails', () => {
    let api: DeviceAPI | undefined;
    const error = expectDeviceError(
      () =>
        createForTest(
          (context) => {
            api = context;
            context.subscribe('value', () => undefined);
            const output = context.ir.output('scalar', { params: ['u32'], capacity: 1 });
            context.onOutput(output, () => undefined);
            const fn = context.ir.func('fn', { params: [], results: [] });
            const entry = context.ir.entry('emit', []);
            entry.body((b) => {
              b.call(fn, []);
              b.return([]);
            });
            return {};
          },
          {},
          createScheduler(),
          description({ value: { direction: 'input', type: 'number' } }),
        ),
      'device/link-failed',
    );
    expect(error).toBeInstanceOf(DeviceError);
    expectDeviceError(() => api!.publish('result', 1), 'device/not-active');
    expectDeviceError(() => api!.subscribe('value', () => undefined), 'device/not-active');
  });

  it('marks a paused async listener rejection as a messaging fault', async () => {
    const { instance } = createForTest(
      (context) => {
        context.subscribe('value', async () => {
          throw new Error('listener boom');
        });
        return {};
      },
      {},
      createScheduler(),
      description({ value: { direction: 'input', type: 'number' } }),
    );
    instance.deliver('value', 1, { simTime: 0 });
    await Promise.resolve();
    expect(instance.state).toBe('faulted');
    expectDeviceError(() => instance.deliver('value', 2, { simTime: 1 }), 'device/instance-busy');
  });
});
