import { describe, expect, it } from 'vitest';
import { parseDeviceDescription } from './description';
import { DeviceError, type DeviceErrorCode } from './errors';
import { loadDeviceModule } from './loader';
import { createTempDevice } from './test-helpers';
import type { DeviceDefinition, DeviceDescription, IDeviceProvider } from './types';

const DESCRIPTION = parseDeviceDescription(
  { properties: { label: { type: 'string', default: 'Display' } } },
  { name: 'acme:demo' },
);

function providerOf(definition: DeviceDescription, code: string): IDeviceProvider {
  return { resolve: () => ({ definition, code }) };
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
