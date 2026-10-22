import { DeviceError } from './errors';
import type {
  DeviceDefinition,
  DeviceDescription,
  DeviceFactory,
  IDeviceProvider,
  LoadedDeviceModule,
} from './types';

/**
 * Loads one device module through a host provider.
 *
 * The provider owns device-id resolution, file location, reading and missing-file diagnostics.
 * This function validates the returned contract, imports the implementation source as an ES
 * module, and validates its default export. It never invokes the factory: the instance context
 * and lifecycle belong to #53.
 *
 * @throws {DeviceError} when the provider or implementation violates the device contract.
 */
export async function loadDeviceModule(
  deviceId: string,
  provider: IDeviceProvider,
): Promise<LoadedDeviceModule> {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new DeviceError('device/device-unknown', 'Device id must be a non-empty string.', {
      deviceId,
    });
  }
  if (provider === null || typeof provider !== 'object' || typeof provider.resolve !== 'function') {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider for ${JSON.stringify(deviceId)} must implement resolve().`,
      { deviceId },
    );
  }

  let resolved: DeviceDefinition | undefined;
  try {
    resolved = await provider.resolve(deviceId);
  } catch (cause) {
    if (cause instanceof DeviceError) {
      throw cause;
    }
    throw new DeviceError(
      'device/provider-failed',
      `Device provider failed to resolve ${JSON.stringify(deviceId)}.`,
      { deviceId, cause },
    );
  }

  if (resolved === undefined) {
    throw new DeviceError('device/device-unknown', `Unknown device ${JSON.stringify(deviceId)}.`, {
      deviceId,
    });
  }
  if (!isRecord(resolved)) {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider returned an invalid definition for ${JSON.stringify(deviceId)}.`,
      { deviceId },
    );
  }

  const description: unknown = resolved.definition;
  if (!isDeviceDescription(description)) {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider returned an invalid DeviceDescription for ${JSON.stringify(deviceId)}.`,
      { deviceId },
    );
  }
  const code: unknown = resolved.code;
  if (typeof code !== 'string') {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider returned no implementation code for ${JSON.stringify(deviceId)}.`,
      { deviceId },
    );
  }

  const implementation = await importModuleSource(code, deviceId);
  return { deviceId, description, factory: readFactory(implementation, deviceId) };
}

async function importModuleSource(code: string, deviceId: string): Promise<unknown> {
  const url = createModuleUrl(code);
  try {
    return await import(/* @vite-ignore */ url);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new DeviceError(
      'device/implementation-import',
      `Device ${JSON.stringify(deviceId)} implementation could not be loaded: ${detail}`,
      { deviceId, cause },
    );
  } finally {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
}

function createModuleUrl(code: string): string {
  const isBrowserLike = typeof window !== 'undefined' || typeof self !== 'undefined';
  if (
    isBrowserLike &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

function readFactory(implementation: unknown, deviceId: string): DeviceFactory {
  if (!isRecord(implementation) || !('default' in implementation)) {
    throw new DeviceError(
      'device/implementation-export',
      `Device ${JSON.stringify(deviceId)} implementation must have a default export.`,
      { deviceId },
    );
  }
  const candidate = implementation['default'];
  if (typeof candidate !== 'function') {
    throw new DeviceError(
      'device/implementation-export',
      `Device ${JSON.stringify(deviceId)} default export must be a synchronous function.`,
      { deviceId },
    );
  }
  const tag = Object.prototype.toString.call(candidate);
  if (tag === '[object AsyncFunction]' || tag === '[object AsyncGeneratorFunction]') {
    throw new DeviceError(
      'device/implementation-async',
      `Device ${JSON.stringify(deviceId)} factory must be synchronous, but the default export is async.`,
      { deviceId },
    );
  }
  if (tag !== '[object Function]' || isClass(candidate)) {
    throw new DeviceError(
      'device/implementation-export',
      `Device ${JSON.stringify(deviceId)} default export must be a synchronous function.`,
      { deviceId },
    );
  }
  return candidate as DeviceFactory;
}

function isClass(candidate: unknown): boolean {
  const source = Function.prototype.toString.call(candidate).trimStart();
  return /^class(?:\s|\{)/.test(source);
}

function isDeviceDescription(value: unknown): value is DeviceDescription {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['displayName'] === 'string' &&
    (value['description'] === undefined || typeof value['description'] === 'string') &&
    value['properties'] instanceof Map &&
    value['ports'] instanceof Map &&
    (value['designatorPrefix'] === undefined || typeof value['designatorPrefix'] === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
