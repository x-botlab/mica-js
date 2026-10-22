import { DeviceError } from './errors';
import { isObjectLike, isPlainRecord } from './internal/records';
import type {
  DeviceDefinition,
  DeviceDescription,
  DeviceFactory,
  IDeviceProvider,
  LoadedDeviceModule,
} from './types';

const providerCaches = new WeakMap<IDeviceProvider, Map<string, Promise<LoadedDeviceModule>>>();
const providerIds = new WeakMap<IDeviceProvider, number>();
let nextProviderId = 1;
let nextLoadId = 1;

/**
 * Loads one device module through a host provider.
 *
 * The provider owns device-id resolution, file location, reading and missing-file diagnostics.
 * This function validates the returned contract, imports the implementation source as an ES
 * module, and validates its default export. It never invokes the factory: the instance context
 * and lifecycle belong to #53.
 *
 * Module identity: within one provider instance a device id is loaded at most once. Repeated and
 * concurrent calls share the same `LoadedDeviceModule` and factory; failed loads are not cached.
 * A new provider instance is required to reload changed implementation code.
 *
 * @throws {DeviceError} when the provider or implementation violates the device contract.
 */
export async function loadDeviceModule(
  deviceId: string,
  provider: IDeviceProvider,
): Promise<LoadedDeviceModule> {
  validateRequest(deviceId, provider);
  const cache = cacheFor(provider);
  const cached = cache.get(deviceId);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadDeviceModuleUncached(
    deviceId,
    provider,
    providerIdOf(provider),
    nextLoadId,
  ).catch((error: unknown) => {
    cache.delete(deviceId);
    throw error;
  });
  nextLoadId += 1;
  cache.set(deviceId, pending);
  return pending;
}

function validateRequest(deviceId: string, provider: IDeviceProvider): void {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new DeviceError('device/device-unknown', 'Device id must be a non-empty string.', {
      deviceId,
    });
  }
  let resolve: unknown;
  try {
    resolve = provider === null || typeof provider !== 'object' ? undefined : provider.resolve;
  } catch (cause) {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider for ${JSON.stringify(deviceId)} could not be inspected.`,
      { deviceId, cause },
    );
  }
  if (typeof resolve !== 'function') {
    throw new DeviceError(
      'device/provider-failed',
      `Device provider for ${JSON.stringify(deviceId)} must implement resolve().`,
      { deviceId },
    );
  }
}

function cacheFor(provider: IDeviceProvider): Map<string, Promise<LoadedDeviceModule>> {
  let cache = providerCaches.get(provider);
  if (cache === undefined) {
    cache = new Map();
    providerCaches.set(provider, cache);
  }
  return cache;
}

function providerIdOf(provider: IDeviceProvider): number {
  let id = providerIds.get(provider);
  if (id === undefined) {
    id = nextProviderId;
    nextProviderId += 1;
    providerIds.set(provider, id);
  }
  return id;
}

async function loadDeviceModuleUncached(
  deviceId: string,
  provider: IDeviceProvider,
  providerId: number,
  loadId: number,
): Promise<LoadedDeviceModule> {
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
  if (!isPlainRecord(resolved)) {
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

  const implementation = await importModuleSource(code, deviceId, providerId, loadId);
  return { deviceId, description, factory: readFactory(implementation, deviceId) };
}

async function importModuleSource(
  code: string,
  deviceId: string,
  providerId: number,
  loadId: number,
): Promise<unknown> {
  let url: string | undefined;
  try {
    url = createModuleUrl(code, deviceId, providerId, loadId);
    return await import(/* @vite-ignore */ url);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new DeviceError(
      'device/implementation-import',
      `Device ${JSON.stringify(deviceId)} implementation could not be loaded: ${detail}`,
      { deviceId, cause },
    );
  } finally {
    if (
      url?.startsWith('blob:') === true &&
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Revocation failure must not replace the loading error.
      }
    }
  }
}

function createModuleUrl(
  code: string,
  deviceId: string,
  providerId: number,
  loadId: number,
): string {
  if (shouldUseBlobUrl()) {
    return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  // The fragment makes the module identity explicit in Node's ESM cache: one provider instance
  // plus one device id maps to one module while the successful load is cached. A failed load
  // uses a fresh load id so a retry is not served from Node's failed-module cache.
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}#${String(providerId)}:${String(loadId)}:${encodeURIComponent(deviceId)}`;
}

function shouldUseBlobUrl(): boolean {
  if (isNodeRuntime()) {
    return false;
  }
  return (
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

function isNodeRuntime(): boolean {
  const candidate = globalThis as {
    process?: { versions?: { node?: unknown } };
  };
  return typeof candidate.process?.versions?.node === 'string';
}

function readFactory(implementation: unknown, deviceId: string): DeviceFactory {
  if (!isObjectLike(implementation) || !('default' in implementation)) {
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
  return /^class\b/.test(source);
}

function isDeviceDescription(value: unknown): value is DeviceDescription {
  return (
    isPlainRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['displayName'] === 'string' &&
    (value['description'] === undefined || typeof value['description'] === 'string') &&
    value['properties'] instanceof Map &&
    value['ports'] instanceof Map &&
    value['pins'] instanceof Map &&
    value['pinGroups'] instanceof Map &&
    value['connections'] instanceof Map &&
    (value['designatorPrefix'] === undefined || typeof value['designatorPrefix'] === 'string')
  );
}
