/**
 * Worker script of the Playground device simulation guest.
 *
 * The `@mica-js/sandbox/vite` plugin bundles this module into a self-contained script, so the file is
 * the worker body itself: `event.ports[0]` is the sandbox port the typed RPC registration takes, and
 * `event.ports[1..]` are the extra ports the caller transferred, forwarded unchanged to the guest.
 *
 * The simulator ships no device models, so the Playground bundles its own library: `public/devices`
 * is read through the host file system the guest already talks to, and `createContractBinding` turns
 * each contract into the IR description and topic bridges the compiler needs.
 */
import { defineRpcService } from '@mica-js/core/rpc';
import type { DeviceReference } from '@mica-js/core/schematic';
import {
  startDeviceSimulationHostGuest,
  type DeviceDescription,
  type SchematicDeviceBinding,
} from '@mica-js/simulator';
import { DEMO_ELECTRICAL, loadDeviceFactories } from './device-implementations';
import { createContractBinding } from './device-contracts';
import { DEVICE_LIBRARY_ROOT, loadDeviceLibrary, type DeviceLibrary } from './device-library';

/**
 * Host file system the guest reads bytes through.
 *
 * It is the service the simulator's guest adapter registers on the host side, so reading the device
 * library rides the existing channel instead of a second one; only the wire key is repeated here
 * because the simulator does not export the service id.
 */
interface HostFileSystemRpc {
  read(uri: string): Promise<Uint8Array>;
}

const hostFileSystemService = defineRpcService<HostFileSystemRpc>('host-capabilities');

let started = false;

self.addEventListener('message', (event: MessageEvent) => {
  if (started) return;
  const port = event.ports[0];
  if (port === undefined) return;
  started = true;

  let loaded: DeviceLibrary | undefined;
  let factories: ReadonlyMap<string, NonNullable<DeviceDescription['factory']>> = new Map();

  const library = (): DeviceLibrary => {
    if (loaded === undefined) {
      throw new Error('Device library is not loaded yet');
    }
    return loaded;
  };

  const guest = startDeviceSimulationHostGuest(port, {
    electrical: DEMO_ELECTRICAL,
    // `event.ports[1]` is the direct topic channel (RFC 0018); the widget guest holds the other end.
    ports: event.ports.slice(1),
    // `prepare` runs on the first schematic load, once `startDeviceSimulationHostGuest` returned the
    // endpoint, so the device library is read through the host file system on the same channel.
    prepare: async () => {
      const files = guest.rpc.getProxy(hostFileSystemService);
      const reader = {
        label: 'demo',
        async read(path: string): Promise<Uint8Array> {
          const bytes = await files.read(`${DEVICE_LIBRARY_ROOT}/${path}`);
          if (!(bytes instanceof Uint8Array)) {
            throw new TypeError(`Device library reader returned ${typeof bytes} for ${path}`);
          }
          return bytes;
        },
      };
      const next = await loadDeviceLibrary(reader);
      factories = await loadDeviceFactories(reader, next);
      loaded = next;
    },
    devices: () => library().symbols,
    resolveDevice: (reference: DeviceReference): SchematicDeviceBinding | undefined => {
      const entry = library().find(reference.raw);
      if (entry === undefined) return undefined;
      const factory = factories.get(entry.reference);
      if (factory === undefined)
        throw new Error(`Missing paired implementation for ${entry.reference}`);
      return createContractBinding(entry, factory);
    },
  });
});
