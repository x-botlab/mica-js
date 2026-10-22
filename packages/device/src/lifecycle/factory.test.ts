import { describe, expect, it } from 'vitest';
import { createScheduler } from '@mica-js/core';
import { createIRModule } from '@mica-js/ir';
import { DeviceError } from '../errors';
import type { DeviceAPI, DeviceFactory } from '../types';
import { createDeviceInstance } from './instance';
import {
  asFactory,
  createForTest,
  expectDeviceError,
  loadedModule,
  testDescription,
} from './test-helpers';

const EMPTY = testDescription();

describe('device factory context', () => {
  it('exposes the fixed props snapshot and closes IR declarations after return', () => {
    let api: DeviceAPI | undefined;
    let destructured: DeviceAPI['ir']['state'] | undefined;
    const { instance } = createForTest(
      (context) => {
        api = context;
        destructured = context.ir.state;
        return {};
      },
      { properties: { label: 'LCD' } },
      createScheduler(),
      testDescription({ properties: { label: { type: 'string', default: 'Display' } } }),
    );

    expect(instance.props).toEqual({ label: 'LCD' });
    expect(Object.isFrozen(instance.props)).toBe(true);
    expect((api as unknown as Record<string, unknown>)['onPropsChanged']).toBeUndefined();
    expect(() => {
      (api!.props as unknown as Record<string, unknown>)['label'] = 'changed';
    }).toThrow(TypeError);
    expectDeviceError(() => api!.ir.state('late', 'u32', 0), 'device/factory-closed');
    expectDeviceError(() => destructured!('late', 'u32', 0), 'device/factory-closed');
    expect(instance.state).toBe('ready');
  });

  it('closes declarations even when the factory throws', () => {
    let api: DeviceAPI | undefined;
    const factory: DeviceFactory = (context) => {
      api = context;
      throw new Error('factory boom');
    };
    const error = expectDeviceError(() => createForTest(factory), 'device/factory-failed');
    expect(error.cause).toBeInstanceOf(Error);
    expectDeviceError(() => api!.ir.state('late', 'u32', 0), 'device/factory-closed');
  });

  it('does not expose the raw module or non-declaration helpers', () => {
    let api: DeviceAPI | undefined;
    createForTest((context) => {
      api = context;
      return {};
    });
    const surface = api as unknown as Record<string, unknown>;
    const ir = api!.ir as unknown as Record<string, unknown>;
    expect(surface['module']).toBeUndefined();
    expect(surface['subscribe']).toBeTypeOf('function');
    expect(surface['publish']).toBeTypeOf('function');
    expect(surface['post']).toBeTypeOf('function');
    expect(surface['postBytes']).toBeTypeOf('function');
    expect(surface['onOutput']).toBeTypeOf('function');
    expect(surface['updateBytes']).toBeTypeOf('function');
    expect(ir['functions']).toBeUndefined();
    expect(ir['domainInstruction']).toBeUndefined();
    expect(ir['provider']).toBeUndefined();
    expect(ir['output']).toBeTypeOf('function');
    expect(ir['outputBytes']).toBeTypeOf('function');
    expect(() => {
      (ir as Record<string, unknown>)['state'] = () => undefined;
    }).toThrow(TypeError);
  });

  it('propagates DeviceError values thrown by the factory unchanged', () => {
    const error = expectDeviceError(
      () =>
        createForTest(() => {
          throw new DeviceError('device/lifecycle-unsupported', 'explicit factory rejection');
        }),
      'device/lifecycle-unsupported',
    );
    expect(error.message).toBe('explicit factory rejection');
  });
});

describe('synchronous factory contract', () => {
  it('rejects async factories before invoking them', () => {
    let invoked = false;
    const factory = (async () => {
      invoked = true;
      return {};
    }) as unknown as DeviceFactory;
    const scheduler = createScheduler();
    expectDeviceError(
      () => createDeviceInstance(loadedModule(factory, EMPTY), scheduler, { instanceId: 'async' }),
      'device/factory-async',
    );
    expect(invoked).toBe(false);
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
  });

  it('rejects a Promise returned from an ordinary function and consumes its rejection', async () => {
    const factory = (() => Promise.reject(new Error('late rejection'))) as unknown as DeviceFactory;
    expectDeviceError(() => createForTest(factory), 'device/factory-async');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('rejects async generators, generators and classes', () => {
    const asyncGenerator = async function* () {
      yield {};
    } as unknown as DeviceFactory;
    const generator = function* () {
      yield {};
    } as unknown as DeviceFactory;
    class Factory {
      call(): void {
        throw new Error('not called');
      }
    }
    expectDeviceError(() => createForTest(asyncGenerator), 'device/factory-async');
    expectDeviceError(() => createForTest(generator), 'device/factory-failed');
    expectDeviceError(
      () => createForTest(Factory as unknown as DeviceFactory),
      'device/factory-failed',
    );
  });

  it('rejects non-object factory results without installing an instance', () => {
    const scheduler = createScheduler();
    const invalid = [undefined, null, 1, 'bindings', [], () => undefined];
    for (const result of invalid) {
      const factory = asFactory(() => result);
      expectDeviceError(
        () =>
          createDeviceInstance(loadedModule(factory, EMPTY), scheduler, {
            instanceId: `invalid-${typeof result}`,
          }),
        'device/lifecycle-binding',
      );
    }
    expect(scheduler.start()).toEqual({ timePs: 0, executed: 0, reason: 'empty' });
  });
});

describe('lifecycle binding validation', () => {
  it('accepts the three approved fields', () => {
    const { instance } = createForTest(
      asFactory((api) => {
        const initialize = api.ir.lifecycle('initialize', []);
        initialize.body((b) => b.return([]));
        const reset = api.ir.lifecycle('reset', []);
        reset.body((b) => b.return([]));
        return { initialize, reset, onDispose: () => undefined };
      }),
    );
    expect(instance.state).toBe('initializing');
  });

  it('rejects unknown binding fields', () => {
    expectDeviceError(
      () =>
        createForTest(
          asFactory((api) => {
            const initialize = api.ir.lifecycle('initialize', []);
            initialize.body((b) => b.return([]));
            return { initialize, onPropsChanged: () => undefined };
          }),
        ),
      'device/lifecycle-binding',
    );
  });

  it('rejects an ordinary entry in a lifecycle slot', () => {
    expectDeviceError(
      () =>
        createForTest(
          asFactory((api) => {
            const entry = api.ir.entry('entry', []);
            entry.body((b) => b.return([]));
            return { initialize: entry };
          }),
        ),
      'device/lifecycle-binding',
    );
  });

  it('rejects lifecycle parameters and duplicate references', () => {
    expectDeviceError(
      () =>
        createForTest(
          asFactory((api) => {
            const initialize = api.ir.lifecycle('initialize', ['u32']);
            initialize.body((b) => b.return([]));
            return { initialize };
          }),
        ),
      'device/lifecycle-binding',
    );
    expectDeviceError(
      () =>
        createForTest(
          asFactory((api) => {
            const lifecycle = api.ir.lifecycle('lifecycle', []);
            lifecycle.body((b) => b.return([]));
            return { initialize: lifecycle, reset: lifecycle };
          }),
        ),
      'device/lifecycle-binding',
    );
  });

  it('rejects ordinary calls and scheduled events targeting lifecycle entries', () => {
    expectDeviceError(
      () =>
        createForTest((api) => {
          const initialize = api.ir.lifecycle('initialize', []);
          initialize.body((b) => {
            b.call(initialize as never, []);
            b.return([]);
          });
          return { initialize };
        }),
      'device/factory-failed',
    );
    expectDeviceError(
      () =>
        createForTest((api) => {
          const initialize = api.ir.lifecycle('initialize', []);
          initialize.body((b) => {
            b.event.at(initialize as never, b.event.now(), []);
            b.return([]);
          });
          return { initialize };
        }),
      'device/factory-failed',
    );
  });

  it('rejects lifecycle references from another module', () => {
    const other = createIRModule();
    const foreign = other.lifecycle('initialize', []);
    foreign.body((b) => b.return([]));
    expectDeviceError(
      () => createForTest(() => ({ initialize: foreign })),
      'device/lifecycle-binding',
    );
  });

  it('rejects async, generator and non-callable onDispose values', () => {
    for (const onDispose of [
      async () => undefined,
      function* () {
        yield undefined;
      },
      null,
      7,
    ]) {
      expectDeviceError(
        () => createForTest(asFactory(() => ({ onDispose }))),
        'device/lifecycle-binding',
      );
    }
  });

  it('rejects null and array binding containers but accepts an empty binding object', () => {
    for (const value of [null, []] as const) {
      expectDeviceError(() => createForTest(asFactory(() => value)), 'device/lifecycle-binding');
    }
    const { instance } = createForTest(asFactory(() => Object.create(null)));
    expect(instance.state).toBe('ready');
  });
});
