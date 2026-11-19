/**
 * Package access of the sandbox guests (RFC 0020).
 *
 * The host owns the packages, so both guests reach the same typed service: `open` proves the lock
 * resolves and `read` hands over one declared file. The guest caches the bytes, because preparation
 * reads the same file for its digest and again for its content, and each reply transfers ownership.
 */
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { DeviceLock, DeviceRegistry } from '@mica-js/document/fused';
import { fusedHostPackageService } from './protocol';
import type { IFusedPackageFilesWire } from './protocol';
import { FusedBridgeError } from './wire';

/** Wire key of one locked package. */
export function packageLockKey(lock: DeviceLock): string {
  return `${lock.id}@${lock.version}#${lock.integrity}`;
}

/** Registry implementation served by the host over `endpoint`. */
export function createHostPackageGateway(endpoint: RpcEndpoint): DeviceRegistry {
  const host = endpoint.getProxy(fusedHostPackageService);
  const opened = new Map<string, Promise<IFusedPackageFilesWire>>();
  const cache = new Map<string, Uint8Array>();
  const openLock = (lock: DeviceLock): Promise<IFusedPackageFilesWire> => {
    const key = packageLockKey(lock);
    let pending = opened.get(key);
    if (pending === undefined) {
      pending = host.open(lock);
      opened.set(key, pending);
    }
    return pending;
  };
  return {
    open(lock: DeviceLock) {
      return openLock(lock).then((files) => ({
        lock: files.lock,
        files: files.files,
        read: async (path: string) => {
          const key = `${packageLockKey(lock)}\u0000${path}`;
          const cached = cache.get(key);
          if (cached !== undefined) return cached.slice();
          const bytes = await host.read(lock, path);
          if (!(bytes instanceof Uint8Array)) {
            throw new FusedBridgeError(
              'package/not-found',
              `The host returned no bytes for ${lock.id}/${path}.`,
            );
          }
          // The reply transferred ownership, so the cache keeps the only copy of this realm.
          cache.set(key, bytes);
          return bytes.slice();
        },
      }));
    },
  };
}
