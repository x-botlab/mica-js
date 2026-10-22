import { describe, expect, it } from 'vitest';
import {
  createScheduler,
  SchedulerError,
  type Scheduler,
  type SchedulerInstance,
  type SchedulerInstanceDefinition,
  type SchedulerRunOptions,
  type SchedulerRunResult,
  type SchedulerTarget,
} from '@mica-js/core';
import type { ArrayRef, BytesRef, InboxRef, StateRef } from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { DeviceAPI, DeviceFactory } from '../types';
import { createDeviceInstance } from './instance';
import { createForTest, expectDeviceError, loadedModule, testDescription } from './test-helpers';

interface Refs {
  value?: StateRef<'u32'>;
  count?: StateRef<'u32'>;
  initCount?: StateRef<'u32'>;
  resetCount?: StateRef<'u32'>;
  eventValue?: StateRef<'u32'>;
  eventId?: StateRef<'u32'>;
  source?: StateRef<'u32'>;
  received?: StateRef<'u32'>;
  array?: ArrayRef<'u8'>;
  bytes?: BytesRef<false>;
  readonlyBytes?: BytesRef<true>;
  inbox?: InboxRef;
}

function schedulerFailure(run: () => unknown): SchedulerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchedulerError);
    return error as SchedulerError;
  }
  throw new Error('Expected SchedulerError.');
}

describe('initialize lifecycle', () => {
  it('invokes the factory once and only queues initialize until the scheduler runs', () => {
    let calls = 0;
    const refs: Refs = {};
    const factory: DeviceFactory = (api) => {
      calls += 1;
      const value = api.ir.state('value', 'u32', 0);
      refs.value = value;
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', 1));
        b.return([]);
      });
      return { initialize };
    };
    const { instance, scheduler } = createForTest(factory);

    expect(calls).toBe(1);
    expect(instance.state).toBe('initializing');
    expect(instance.storage.loadState(refs.value!)).toBe(0);

    expect(scheduler.step()).toMatchObject({ timePs: 0, executed: 1 });
    expect(instance.state).toBe('ready');
    expect(instance.storage.loadState(refs.value!)).toBe(1);
    expect(calls).toBe(1);
  });

  it('runs initialize control before an ordinary event scheduled at the same time', () => {
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      const value = api.ir.state('value', 'u32', 0);
      refs.value = value;
      const later = api.ir.entry('later', []);
      later.body((b) => {
        b.state.store(value, b.const('u32', 2));
        b.return([]);
      });
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', 1));
        b.event.at(later, b.event.now(), []);
        b.return([]);
      });
      return { initialize };
    });

    expect(instance.state).toBe('initializing');
    scheduler.step();
    expect(instance.state).toBe('ready');
    expect(instance.storage.loadState(refs.value!)).toBe(1);
    scheduler.step();
    expect(instance.storage.loadState(refs.value!)).toBe(2);
  });

  it('never becomes ready when initialize faults', () => {
    let disposed = 0;
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      const value = api.ir.state('value', 'u32', 0);
      refs.value = value;
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', 1));
        b.trap('initialize failed');
      });
      return { initialize, onDispose: () => void (disposed += 1) };
    });

    const error = schedulerFailure(() => scheduler.start());
    expect(error.code).toBe('execution-failed');
    expect(error.cause).toMatchObject({ code: 'trap' });
    expect(instance.state).toBe('faulted');
    expect(instance.storage.loadState(refs.value!)).toBe(1);
    expect(disposed).toBe(0);
  });

  it('becomes ready immediately when initialize is omitted', () => {
    const { instance, scheduler } = createForTest(() => ({}));
    expect(instance.state).toBe('ready');
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
  });

  it('uses event.now, event.at, cancel and captured arguments through the real scheduler', () => {
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      const source = api.ir.state('source', 'u32', 0);
      const received = api.ir.state('received', 'u32', 0);
      const eventId = api.ir.state('eventId', 'u32', 0);
      refs.source = source;
      refs.received = received;
      refs.eventId = eventId;
      const target = api.ir.entry('target', ['u32']);
      target.body((b, [value]) => {
        b.state.store(received, value);
        b.return([]);
      });
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(source, b.const('u32', 7));
        const first = b.event.at(target, b.event.now(), [b.state.load(source)]);
        const second = b.event.at(target, b.event.now(), [b.const('u32', 9)]);
        b.event.cancel(second);
        b.state.store(eventId, first);
        b.state.store(source, b.const('u32', 8));
        b.return([]);
      });
      return { initialize };
    });

    scheduler.start();
    expect(instance.storage.loadState(refs.received!)).toBe(7);
    expect(instance.storage.loadState(refs.source!)).toBe(8);
    expect(instance.storage.loadState(refs.eventId!)).toBe(1);
  });
});

describe('reset lifecycle', () => {
  it('runs the bound reset as control work without rerunning initialize', () => {
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      const value = api.ir.state('value', 'u32', 0);
      const initCount = api.ir.state('initCount', 'u32', 0);
      const resetCount = api.ir.state('resetCount', 'u32', 0);
      refs.value = value;
      refs.initCount = initCount;
      refs.resetCount = resetCount;
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(initCount, b.int.add(b.state.load(initCount), b.const('u32', 1)));
        b.state.store(value, b.const('u32', 1));
        b.return([]);
      });
      const reset = api.ir.lifecycle('reset', []);
      reset.body((b) => {
        b.state.store(resetCount, b.int.add(b.state.load(resetCount), b.const('u32', 1)));
        b.state.store(value, b.const('u32', 2));
        b.return([]);
      });
      return { initialize, reset };
    });

    scheduler.start();
    expect(instance.storage.loadState(refs.initCount!)).toBe(1);
    expect(instance.storage.loadState(refs.value!)).toBe(1);

    instance.reset();
    expect(instance.state).toBe('ready');
    scheduler.step();
    expect(instance.storage.loadState(refs.initCount!)).toBe(1);
    expect(instance.storage.loadState(refs.resetCount!)).toBe(1);
    expect(instance.storage.loadState(refs.value!)).toBe(2);
  });

  it('does not cancel scheduled events and does not rebuild the instance', () => {
    let factoryCalls = 0;
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      factoryCalls += 1;
      const value = api.ir.state('value', 'u32', 0);
      refs.value = value;
      const timer = api.ir.entry('timer', []);
      timer.body((b) => {
        b.state.store(value, b.const('u32', 3));
        b.return([]);
      });
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', 1));
        b.event.at(timer, b.float.add(b.event.now(), b.const('f64', 100)), []);
        b.return([]);
      });
      const reset = api.ir.lifecycle('reset', []);
      reset.body((b) => {
        b.state.store(value, b.const('u32', 2));
        b.return([]);
      });
      return { initialize, reset };
    });

    scheduler.step();
    instance.reset();
    scheduler.step();
    expect(instance.storage.loadState(refs.value!)).toBe(2);
    scheduler.start();
    expect(instance.storage.loadState(refs.value!)).toBe(3);
    expect(factoryCalls).toBe(1);
  });

  it('reports unsupported reset without destroying or rebuilding', () => {
    let factoryCalls = 0;
    const { instance, scheduler } = createForTest(() => {
      factoryCalls += 1;
      return {};
    });
    expectDeviceError(() => instance.reset(), 'device/lifecycle-unsupported');
    expect(instance.state).toBe('ready');
    expect(factoryCalls).toBe(1);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
  });

  it('rejects reset while initializing and after destruction', () => {
    const { instance, scheduler } = createForTest((api) => {
      const value = api.ir.state('value', 'u32', 0);
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', 1));
        b.return([]);
      });
      const reset = api.ir.lifecycle('reset', []);
      reset.body((b) => b.return([]));
      return { initialize, reset };
    });
    expectDeviceError(() => instance.reset(), 'device/instance-busy');
    scheduler.start();
    instance.reset();
    scheduler.step();
    instance.destroy();
    expectDeviceError(() => instance.reset(), 'device/instance-destroyed');
  });

  it('rejects reset while faulted instead of recovering implicitly', () => {
    const { instance, scheduler } = createForTest((api) => {
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => b.trap('fault'));
      const reset = api.ir.lifecycle('reset', []);
      reset.body((b) => b.return([]));
      return { initialize, reset };
    });
    schedulerFailure(() => scheduler.start());
    expect(instance.state).toBe('faulted');
    expectDeviceError(() => instance.reset(), 'device/instance-busy');
  });
});

describe('destroy lifecycle', () => {
  it('clears queued work, releases storage and calls onDispose once', () => {
    let disposed = 0;
    const refs: Refs = {};
    const { instance, scheduler } = createForTest((api) => {
      const value = api.ir.state('value', 'u32', 0);
      refs.value = value;
      const timer = api.ir.entry('timer', []);
      timer.body((b) => {
        b.state.store(value, b.const('u32', 7));
        b.return([]);
      });
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.event.at(timer, b.float.add(b.event.now(), b.const('f64', 10)), []);
        b.return([]);
      });
      return { initialize, onDispose: () => void (disposed += 1) };
    });

    const storage = instance.storage;
    instance.destroy();
    expect(instance.state).toBe('destroyed');
    expect(disposed).toBe(1);
    expectDeviceError(() => instance.storage, 'device/instance-destroyed');
    expectDeviceError(() => storage.loadState(refs.value!), 'device/instance-destroyed');
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });

    instance.destroy();
    expect(disposed).toBe(1);
  });

  it('reports onDispose failure after cleanup and stays destroyed', () => {
    let calls = 0;
    const { instance } = createForTest(() => ({
      onDispose: () => {
        calls += 1;
        throw new Error('dispose boom');
      },
    }));
    const error = expectDeviceError(() => instance.destroy(), 'device/dispose-failed');
    expect(error.cause).toBeInstanceOf(Error);
    expect(instance.state).toBe('destroyed');
    expect(calls).toBe(1);
    expect(() => instance.destroy()).not.toThrow();
    expect(calls).toBe(1);
  });

  it('runs onDispose after kernel cleanup and blocks reentrant destroy work', () => {
    let disposedState: string | undefined;
    let storageDuringDispose: string | undefined;
    let reentrant: unknown;
    const holder: { instance?: ReturnType<typeof createForTest>['instance'] } = {};
    const created = createForTest(() => ({
      onDispose: () => {
        disposedState = holder.instance!.state;
        try {
          holder.instance!.storage.loadState({} as StateRef<'u32'>);
        } catch (error) {
          storageDuringDispose = (error as DeviceError).code;
        }
        try {
          holder.instance!.destroy();
        } catch (error) {
          reentrant = error;
        }
        reentrant ??= 'no error';
      },
    }));
    holder.instance = created.instance;
    holder.instance.destroy();
    expect(disposedState).toBe('destroying');
    expect(storageDuringDispose).toBe('device/instance-destroyed');
    expect(reentrant).toBe('no error');
    expect(holder.instance.state).toBe('destroyed');
  });

  it('reports onDispose scheduling attempts without blocking cleanup', () => {
    let api: DeviceAPI | undefined;
    const { instance } = createForTest((context) => {
      api = context;
      return {
        onDispose: () => {
          context.ir.state('late', 'u32', 0);
        },
      };
    });
    const error = expectDeviceError(() => instance.destroy(), 'device/dispose-failed');
    expect(error.cause).toBeInstanceOf(DeviceError);
    expect((error.cause as DeviceError).code).toBe('device/factory-closed');
    expect(instance.state).toBe('destroyed');
    expect(api).toBeDefined();
  });

  it('allows destroy after a model fault and keeps the scheduler faulted', () => {
    let disposed = 0;
    const { instance, scheduler } = createForTest((api) => {
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => b.trap('fault'));
      return { initialize, onDispose: () => void (disposed += 1) };
    });
    schedulerFailure(() => scheduler.start());
    expect(instance.state).toBe('faulted');
    expect(disposed).toBe(0);
    instance.destroy();
    expect(disposed).toBe(1);
    expect(instance.state).toBe('destroyed');
    expect(scheduler.state).toBe('faulted');
    schedulerFailure(() => scheduler.step());
  });

  it('rejects destroy while the scheduler is running and remains usable afterwards', () => {
    let busy: DeviceError | undefined;
    const holder: { instance?: ReturnType<typeof createForTest>['instance'] } = {};
    const inner = createScheduler();
    const scheduler = hookExecutor(inner, () => {
      try {
        holder.instance!.destroy();
      } catch (error) {
        if (error instanceof DeviceError) {
          busy = error;
        } else {
          throw error;
        }
      }
    });
    const created = createForTest(
      (api) => {
        const initialize = api.ir.lifecycle('initialize', []);
        initialize.body((b) => b.return([]));
        return { initialize };
      },
      { instanceId: 'running-destroy' },
      scheduler,
    );
    holder.instance = created.instance;
    created.scheduler.start();
    expect(busy?.code).toBe('device/instance-busy');
    expect(holder.instance.state).toBe('ready');
    holder.instance.destroy();
    expect(holder.instance.state).toBe('destroyed');
  });
});

describe('props and storage', () => {
  it('uses the fixed props snapshot as build constants and rejects runtime mutation', () => {
    const overrides = { speed: 99 };
    const refs: Refs = {};
    const description = testDescription({
      properties: {
        speed: { type: 'number', default: 72 },
        label: { type: 'string', default: 'demo' },
      },
    });
    const { instance, scheduler } = createForTest(
      (api) => {
        const value = api.ir.state('value', 'u32', 0);
        refs.value = value;
        const initialize = api.ir.lifecycle('initialize', []);
        initialize.body((b) => {
          b.state.store(value, b.const('u32', api.props['speed'] as number));
          b.return([]);
        });
        return { initialize };
      },
      { properties: overrides },
      createScheduler(),
      description,
    );

    overrides.speed = 1;
    expect(instance.props).toEqual({ speed: 99, label: 'demo' });
    expect(Object.isFrozen(instance.props)).toBe(true);
    scheduler.start();
    expect(instance.storage.loadState(refs.value!)).toBe(99);
    instance.destroy();
    expectDeviceError(() => instance.storage, 'device/instance-destroyed');
  });

  it('guards every storage accessor after destruction', () => {
    const refs: Refs = {};
    const { instance } = createForTest((api) => {
      refs.value = api.ir.state('value', 'u32', 0);
      refs.array = api.ir.array('array', 'u8', [1, 2, 3]);
      refs.bytes = api.ir.bytes('bytes', new Uint8Array([1, 2, 3, 4]), { readonly: false });
      refs.readonlyBytes = api.ir.bytes('readonly', new Uint8Array([5, 6]), { readonly: true });
      refs.inbox = api.ir.inbox('inbox', 4);
      return {};
    });
    const storage = instance.storage;
    expect(storage.loadState(refs.value!)).toBe(0);
    storage.storeState(refs.value!, 3);
    expect(storage.loadState(refs.value!)).toBe(3);
    expect(storage.loadArray(refs.array!, 1)).toBe(2);
    storage.storeArray(refs.array!, 1, 9);
    expect(storage.loadArray(refs.array!, 1)).toBe(9);
    expect(storage.loadBytes('u8', 'little', refs.bytes!, 1)).toBe(2);
    storage.storeBytes('u8', 'little', refs.bytes!, 1, 8);
    storage.copy(refs.bytes!, 0, refs.readonlyBytes!, 0, 2);
    storage.fillBytes(refs.bytes!, 2, 2, 4);
    storage.updateBytes(refs.bytes!, 0, refs.readonlyBytes!, 0, 2);
    expect(storage.readVersionedBytes(refs.bytes!, 0, 2).bytes).toEqual(new Uint8Array([5, 6]));
    expect(storage.validateDependencies([])).toBe(true);

    instance.destroy();
    const operations = [
      () => storage.loadState(refs.value!),
      () => storage.storeState(refs.value!, 1),
      () => storage.loadArray(refs.array!, 0),
      () => storage.storeArray(refs.array!, 0, 1),
      () => storage.loadBytes('u8', 'little', refs.bytes!, 0),
      () => storage.storeBytes('u8', 'little', refs.bytes!, 0, 1),
      () => storage.copy(refs.bytes!, 0, refs.readonlyBytes!, 0, 1),
      () => storage.updateBytes(refs.bytes!, 0, refs.readonlyBytes!, 0, 1),
      () => storage.fillBytes(refs.bytes!, 0, 1, 1),
      () => storage.readVersionedBytes(refs.bytes!, 0, 1),
      () => storage.validateDependencies([]),
    ];
    for (const operation of operations) {
      expectDeviceError(operation, 'device/instance-destroyed');
    }
  });
});

describe('creation failures', () => {
  it('does not install or initialize when linking fails', () => {
    let disposed = 0;
    const refs: Refs = {};
    const scheduler = createScheduler();
    const factory: DeviceFactory = (api) => {
      const source = api.ir.bytes('source', new Uint8Array([1, 2]), { readonly: true });
      const destination = api.ir.bytes('destination', new Uint8Array([0, 0]), {
        readonly: true,
      });
      refs.readonlyBytes = source;
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.resource.updateBytes(
          destination,
          b.const('u32', 0),
          source,
          b.const('u32', 0),
          b.const('u32', 2),
        );
        b.return([]);
      });
      return { initialize, onDispose: () => void (disposed += 1) };
    };
    const error = expectDeviceError(
      () => createForTest(factory, {}, scheduler),
      'device/link-failed',
    );
    expect(error.cause).toBeDefined();
    expect(disposed).toBe(0);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
    expect(refs.readonlyBytes).toBeDefined();
  });

  it('fails linking when a declared lifecycle has no body and installs nothing', () => {
    const scheduler = createScheduler();
    expectDeviceError(
      () =>
        createForTest(
          (api) => {
            const initialize = api.ir.lifecycle('initialize', []);
            return { initialize };
          },
          {},
          scheduler,
        ),
      'device/link-failed',
    );
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
  });

  it('calls the factory once per instance and keeps their storage independent', () => {
    let calls = 0;
    const refs: StateRef<'u32'>[] = [];
    const factory: DeviceFactory = (api) => {
      calls += 1;
      const value = api.ir.state('value', 'u32', 0);
      refs.push(value);
      const initialize = api.ir.lifecycle('initialize', []);
      initialize.body((b) => {
        b.state.store(value, b.const('u32', calls));
        b.return([]);
      });
      return { initialize };
    };
    const loaded = loadedModule(factory, testDescription());
    const scheduler = createScheduler();
    const first = createDeviceInstance(loaded, scheduler, { instanceId: 'instance-a' });
    const second = createDeviceInstance(loaded, scheduler, { instanceId: 'instance-b' });
    scheduler.start();
    expect(calls).toBe(2);
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
    expect(first.storage.loadState(refs[0]!)).toBe(1);
    expect(second.storage.loadState(refs[1]!)).toBe(2);
    expect(first.props).not.toBe(second.props);
  });

  it('rejects invalid options, schedulers and duplicate instance ids', () => {
    const factory: DeviceFactory = () => ({});
    expectDeviceError(() => createForTest(factory, { instanceId: '' }), 'device/instance-invalid');
    expectDeviceError(
      () => createForTest(factory, {}, {} as unknown as Scheduler),
      'device/instance-invalid',
    );
    const scheduler = createScheduler();
    const first = createForTest(factory, { instanceId: 'duplicate' }, scheduler);
    expectDeviceError(
      () => createForTest(factory, { instanceId: 'duplicate' }, scheduler),
      'device/instance-invalid',
    );
    expect(first.instance.state).toBe('ready');
  });
});

/** Wraps a real scheduler to run a test hook at the start of every entry. */
function hookExecutor(inner: Scheduler, hook: () => void): Scheduler {
  return {
    get now() {
      return inner.now;
    },
    get state() {
      return inner.state;
    },
    get error() {
      return inner.error;
    },
    addInstance(definition: SchedulerInstanceDefinition): SchedulerInstance {
      return inner.addInstance({
        instanceId: definition.instanceId,
        targets: definition.targets,
        executor: {
          execute(
            target: SchedulerTarget,
            args: Parameters<SchedulerInstanceDefinition['executor']['execute']>[1],
            context: Parameters<SchedulerInstanceDefinition['executor']['execute']>[2],
          ): void {
            hook();
            Reflect.apply(definition.executor.execute, definition.executor, [
              target,
              args,
              context,
            ]);
          },
        },
      });
    },
    enqueueControl(instance, target, args): void {
      inner.enqueueControl(instance, target, args);
    },
    destroyInstance(instance): void {
      inner.destroyInstance(instance);
    },
    start(options?: SchedulerRunOptions): SchedulerRunResult {
      return options === undefined ? inner.start() : inner.start(options);
    },
    pause(): void {
      inner.pause();
    },
    step(): SchedulerRunResult {
      return inner.step();
    },
  };
}
