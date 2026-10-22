import { describe, expect, it } from 'vitest';
import { parseDeviceDescription } from './description';
import { DeviceError, type DeviceErrorCode } from './errors';
import { loadDeviceModule } from './loader';
import { createTempDevice } from './test-helpers';
import type { DeviceDefinition, DeviceDescription, DeviceFactory, IDeviceProvider } from './types';

const DESCRIPTION = parseDeviceDescription(
  { properties: { label: { type: 'string', default: 'Display' } } },
  { name: 'acme:demo' },
);

function providerOf(definition: DeviceDescription, code: string): IDeviceProvider {
  return { resolve: () => ({ definition, code }) };
}

function callFactory(factory: DeviceFactory): unknown {
  return (factory as unknown as () => unknown)();
}

async function expectCode(promise: Promise<unknown>, code: DeviceErrorCode): Promise<DeviceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceError);
    const deviceError = error as DeviceError;
    expect(deviceError.code).toBe(code);
    return deviceError;
  }
  throw new Error('Expected DeviceError.');
}

describe('loadDeviceModule', () => {
  it('loads a real temporary JSON/JS pair through a provider', async () => {
    const temp = await createTempDevice(
      {
        'demo.json': JSON.stringify({
          properties: { label: { type: 'string', default: 'Display' } },
          ports: { frame: { direction: 'output', type: 'bytes<rgb565>' } },
          designatorPrefix: 'U',
        }),
        'demo.js': 'export default function createDevice(api) { return { api }; }',
      },
      { 'acme:demo': 'demo' },
    );
    try {
      const loaded = await loadDeviceModule('acme:demo', temp.provider);
      expect(loaded.deviceId).toBe('acme:demo');
      expect(loaded.description.name).toBe('acme:demo');
      expect(loaded.description.displayName).toBe('acme:demo');
      expect(loaded.description.properties.get('label')?.default).toBe('Display');
      expect(loaded.description.ports.get('frame')?.type).toBe('bytes<rgb565>');
      expect(loaded.description.pins).toBeInstanceOf(Map);
      expect(loaded.description.pins.size).toBe(0);
      expect(loaded.description.pinGroups).toBeInstanceOf(Map);
      expect(loaded.description.pinGroups.size).toBe(0);
      expect(loaded.description.designatorPrefix).toBe('U');
      expect(typeof loaded.factory).toBe('function');
    } finally {
      await temp.cleanup();
    }
  });

  it('returns a synchronous default export without invoking it', async () => {
    const key = '__mica_device_factory_test__';
    (globalThis as Record<string, unknown>)[key] = undefined;
    const code = `globalThis.${key} = 'imported'; export default function createDevice() { globalThis.${key} = 'called'; return {}; }`;
    try {
      const loaded = await loadDeviceModule('acme:demo', providerOf(DESCRIPTION, code));
      expect((globalThis as Record<string, unknown>)[key]).toBe('imported');
      (loaded.factory as (api: unknown) => unknown)({});
      expect((globalThis as Record<string, unknown>)[key]).toBe('called');
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it('rejects an unknown device', async () => {
    await expectCode(
      loadDeviceModule('acme:missing', { resolve: () => undefined }),
      'device/device-unknown',
    );
  });

  it('rejects an empty device id', async () => {
    await expectCode(
      loadDeviceModule(' ', providerOf(DESCRIPTION, 'export default function createDevice() {}')),
      'device/device-unknown',
    );
  });

  it('propagates a DeviceError thrown by the provider', async () => {
    const providerError = new DeviceError('device/device-unknown', 'provider says missing');
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => {
          throw providerError;
        },
      }),
      'device/device-unknown',
    );
  });

  it('wraps arbitrary provider failures with the cause', async () => {
    const cause = new Error('storage offline');
    const error = await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => {
          throw cause;
        },
      }),
      'device/provider-failed',
    );
    expect(error.cause).toBe(cause);
    expect(error.deviceId).toBe('acme:demo');
  });

  it('rejects a provider that does not implement resolve', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', {} as IDeviceProvider),
      'device/provider-failed',
    );
  });

  it('rejects malformed provider results', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => ({ definition: {}, code: '' }) as unknown as DeviceDefinition,
      }),
      'device/provider-failed',
    );
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => ({ definition: DESCRIPTION, code: 42 }) as unknown as DeviceDefinition,
      }),
      'device/provider-failed',
    );
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => null as unknown as DeviceDefinition,
      }),
      'device/provider-failed',
    );
  });

  it('rejects a module without a default export', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, 'export const value = 1;')),
      'device/implementation-export',
    );
  });

  it('rejects a non-function default export', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, 'export default 42;')),
      'device/implementation-export',
    );
  });

  it('rejects async functions and async generators', async () => {
    await expectCode(
      loadDeviceModule(
        'acme:demo',
        providerOf(DESCRIPTION, 'export default async function createDevice() {}'),
      ),
      'device/implementation-async',
    );
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, 'export default async () => ({});')),
      'device/implementation-async',
    );
    await expectCode(
      loadDeviceModule(
        'acme:demo',
        providerOf(DESCRIPTION, 'export default async function* createDevice() {}'),
      ),
      'device/implementation-async',
    );
  });

  it('rejects generator and class default exports', async () => {
    await expectCode(
      loadDeviceModule(
        'acme:demo',
        providerOf(DESCRIPTION, 'export default function* createDevice() {}'),
      ),
      'device/implementation-export',
    );
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, 'export default class Device {}')),
      'device/implementation-export',
    );
    await expectCode(
      loadDeviceModule(
        'acme:demo',
        providerOf(DESCRIPTION, 'export default class/* comment */ Device {}'),
      ),
      'device/implementation-export',
    );
  });

  it('rejects module syntax and evaluation failures', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, 'export default function (')),
      'device/implementation-import',
    );
    await expectCode(
      loadDeviceModule(
        'acme:demo',
        providerOf(
          DESCRIPTION,
          "throw new Error('boom'); export default function createDevice() {}",
        ),
      ),
      'device/implementation-import',
    );
  });

  it('wraps module URL construction failures as implementation-import', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', providerOf(DESCRIPTION, '\uD800')),
      'device/implementation-import',
    );
  });

  it('uses data URLs in Node even when DOM globals exist', async () => {
    const globals = globalThis as Record<string, unknown>;
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, 'window');
    const hadSelf = Object.prototype.hasOwnProperty.call(globals, 'self');
    const previousWindow = globals['window'];
    const previousSelf = globals['self'];
    globals['window'] = {};
    globals['self'] = {};
    try {
      const loaded = await loadDeviceModule(
        'dom-shim',
        providerOf(DESCRIPTION, 'export default function createDevice() {}'),
      );
      expect(typeof loaded.factory).toBe('function');
    } finally {
      if (hadWindow) {
        globals['window'] = previousWindow;
      } else {
        Reflect.deleteProperty(globals, 'window');
      }
      if (hadSelf) {
        globals['self'] = previousSelf;
      } else {
        Reflect.deleteProperty(globals, 'self');
      }
    }
  });

  it('loads one module per provider and device id', async () => {
    let resolveCount = 0;
    const provider: IDeviceProvider = {
      resolve: () => {
        resolveCount += 1;
        return { definition: DESCRIPTION, code: 'export default function createDevice() {}' };
      },
    };
    const [first, second] = await Promise.all([
      loadDeviceModule('shared-module', provider),
      loadDeviceModule('shared-module', provider),
    ]);
    expect(second).toBe(first);
    expect(resolveCount).toBe(1);
    expect(await loadDeviceModule('shared-module', provider)).toBe(first);
    expect(resolveCount).toBe(1);
  });

  it('loads distinct modules for distinct device ids with the same code', async () => {
    const code =
      'let count = 0; export default function createDevice() { count += 1; return count; }';
    const provider = providerOf(DESCRIPTION, code);
    const first = await loadDeviceModule('module-a', provider);
    const second = await loadDeviceModule('module-b', provider);
    expect(first.factory).not.toBe(second.factory);
    expect(callFactory(first.factory)).toBe(1);
    expect(callFactory(second.factory)).toBe(1);
  });

  it('loads distinct modules for distinct providers with the same device id and code', async () => {
    const code =
      'let count = 0; export default function createDevice() { count += 1; return count; }';
    const first = await loadDeviceModule('module-c', providerOf(DESCRIPTION, code));
    const second = await loadDeviceModule('module-c', providerOf(DESCRIPTION, code));
    expect(first.factory).not.toBe(second.factory);
    expect(callFactory(first.factory)).toBe(1);
    expect(callFactory(second.factory)).toBe(1);
  });

  it('does not cache failed loads', async () => {
    let attempts = 0;
    const provider: IDeviceProvider = {
      resolve: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient');
        }
        return { definition: DESCRIPTION, code: 'export default function createDevice() {}' };
      },
    };
    await expectCode(loadDeviceModule('retry-module', provider), 'device/provider-failed');
    const loaded = await loadDeviceModule('retry-module', provider);
    expect(typeof loaded.factory).toBe('function');
    expect(attempts).toBe(2);
  });

  it('retries module evaluation failures with a fresh module', async () => {
    let attempts = 0;
    const provider: IDeviceProvider = {
      resolve: () => {
        attempts += 1;
        return {
          definition: DESCRIPTION,
          code:
            attempts === 1
              ? 'export default function ('
              : 'export default function createDevice() {}',
        };
      },
    };
    await expectCode(
      loadDeviceModule('retry-module-eval', provider),
      'device/implementation-import',
    );
    const loaded = await loadDeviceModule('retry-module-eval', provider);
    expect(typeof loaded.factory).toBe('function');
    expect(attempts).toBe(2);
  });

  it('rejects non-plain provider results and descriptions', async () => {
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => new Map() as unknown as DeviceDefinition,
      }),
      'device/provider-failed',
    );
    await expectCode(
      loadDeviceModule('acme:demo', {
        resolve: () => ({ definition: new Map(), code: '' }) as unknown as DeviceDefinition,
      }),
      'device/provider-failed',
    );
  });

  it('rejects descriptions without parsed pin maps', async () => {
    const code = 'export default function createDevice() {}';
    const withoutPins = {
      name: DESCRIPTION.name,
      displayName: DESCRIPTION.displayName,
      description: DESCRIPTION.description,
      properties: DESCRIPTION.properties,
      ports: DESCRIPTION.ports,
      pinGroups: DESCRIPTION.pinGroups,
      connections: DESCRIPTION.connections,
      designatorPrefix: DESCRIPTION.designatorPrefix,
    } as unknown as DeviceDescription;
    const withoutPinGroups = {
      name: DESCRIPTION.name,
      displayName: DESCRIPTION.displayName,
      description: DESCRIPTION.description,
      properties: DESCRIPTION.properties,
      ports: DESCRIPTION.ports,
      pins: DESCRIPTION.pins,
      connections: DESCRIPTION.connections,
      designatorPrefix: DESCRIPTION.designatorPrefix,
    } as unknown as DeviceDescription;
    const cases: readonly DeviceDescription[] = [
      withoutPins,
      withoutPinGroups,
      {
        ...DESCRIPTION,
        pins: {} as unknown as DeviceDescription['pins'],
      },
      {
        ...DESCRIPTION,
        pins: [] as unknown as DeviceDescription['pins'],
      },
      {
        ...DESCRIPTION,
        pinGroups: {} as unknown as DeviceDescription['pinGroups'],
      },
      {
        ...DESCRIPTION,
        connections: {} as unknown as DeviceDescription['connections'],
      },
    ];
    for (const definition of cases) {
      await expectCode(
        loadDeviceModule('acme:demo', providerOf(definition, code)),
        'device/provider-failed',
      );
    }
  });

  it('wraps provider I/O errors as provider-failed with the cause', async () => {
    const cause = Object.assign(new Error('ENOENT: missing device.json'), { code: 'ENOENT' });
    const error = await expectCode(
      loadDeviceModule('missing-device', {
        resolve: () => {
          throw cause;
        },
      }),
      'device/provider-failed',
    );
    expect(error.cause).toBe(cause);
  });

  it('defers a Promise-returning synchronous factory to the invocation stage', async () => {
    const loaded = await loadDeviceModule(
      'acme:demo',
      providerOf(
        DESCRIPTION,
        'export default function createDevice() { return Promise.resolve({}); }',
      ),
    );
    expect(typeof loaded.factory).toBe('function');
  });
});
