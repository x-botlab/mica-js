import { createRpc } from '@mica-js/core/rpc';
import { loggerService } from '@mica-js/core/logging';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { DeviceReference, DeviceSymbolProvider } from '@mica-js/core/schematic';
import type { SchematicDeviceBinding } from '../unified-ir/runtime';
import { deviceSimulationHostFileSystemService, deviceSimulationHostGuestService } from './rpc';
import type { DeviceSimulationHostRpc } from './rpc';
import { createSchematicDeviceSimulationHost } from './runtime';

/**
 * Device wiring a worker script hands to {@link startDeviceSimulationHostGuest}.
 *
 * The simulator ships no device models, so every option defaults to "knows no references": a
 * package that owns devices bundles its own worker script and supplies these.
 */
export interface DeviceSimulationHostGuestOptions {
  /** Symbol geometry of the schematics this guest loads, or a factory called per load. */
  readonly devices?: DeviceSymbolProvider | (() => DeviceSymbolProvider);
  /** Resolves a schematic device reference; when omitted every reference stays unresolved. */
  readonly resolveDevice?: (reference: DeviceReference) => SchematicDeviceBinding | undefined;
  /**
   * Awaited before the first schematic load, so a device library can be read through the host file
   * system before anything compiles. Runs at most once.
   */
  readonly prepare?: () => Promise<void>;
  /**
   * Extra ports the worker received in the first ordinary message. The RPC port comes first, so these are
   * `event.ports` from index 1 onward, in the order the caller transferred them. The first one is
   * the direct topic channel (RFC 0018): the widget guest holds the other end and talks to this
   * guest without the host relaying.
   */
  readonly ports?: readonly MessagePort[];
}

/** Running guest: where the typed services live and which ports the worker was handed. */
export interface DeviceSimulationHostGuest {
  /**
   * Endpoint the typed device simulation services are registered on. A worker script that owns
   * further capabilities registers them here instead of opening a second sandbox channel.
   */
  readonly rpc: RpcEndpoint;
  /** Extra startup ports, in the order the worker received them. */
  readonly ports: readonly MessagePort[];
  /** Releases the circuit and closes the endpoint. */
  dispose(): Promise<void>;
}

/**
 * Registers RFC 0018's device simulation services on a sandbox RPC port.
 *
 * A worker script obtains the port from `event.ports[0]` and calls this function; nothing else is
 * needed, because the guest is a plain module the `@mica-js/sandbox/vite` plugin bundles into a
 * self-contained script. The guest registers `deviceSimulationHostGuestService` and reads schematics
 * through `deviceSimulationHostFileSystemService`, so schematic bytes never enter the guest's own
 * message handling and every payload is a typed RPC DTO.
 */
export function startDeviceSimulationHostGuest(
  port: MessagePort,
  options: DeviceSimulationHostGuestOptions = {},
): DeviceSimulationHostGuest {
  const { devices, resolveDevice, prepare, ports = [] } = options;
  const rpc = createRpc(port);
  const logger = rpc.getProxy(loggerService);
  void logger
    .write({
      level: 'debug',
      scope: 'device-simulation',
      message: 'guest-started',
      data: [{ extraPortCount: ports.length }],
    })
    .catch(() => undefined);
  const files = rpc.getProxy(deviceSimulationHostFileSystemService);
  const host = createSchematicDeviceSimulationHost({
    async read(uri: string): Promise<Uint8Array> {
      const bytes = await files.read(uri);
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError(`DeviceSimulationHost file system returned ${typeof bytes} for ${uri}`);
      }
      return bytes;
    },
    ...(devices === undefined ? {} : { devices }),
    resolveDevice: resolveDevice ?? (() => undefined),
  });

  let prepared: Promise<void> | undefined;
  const ensurePrepared = async (): Promise<void> => {
    if (prepare === undefined) return;
    prepared ??= prepare();
    try {
      await prepared;
    } catch (error) {
      // A failed preparation must not poison later loads: forget it so the next call retries.
      prepared = undefined;
      throw error;
    }
  };

  const service: DeviceSimulationHostRpc = {
    async loadSchematic(uri: string | undefined): Promise<void> {
      void logger
        .write({
          level: 'debug',
          scope: 'device-simulation',
          message: 'load-schematic-start',
          data: [uri],
        })
        .catch(() => undefined);
      try {
        if (uri !== undefined) await ensurePrepared();
        await host.loadSchematic(uri);
        void logger
          .write({
            level: 'debug',
            scope: 'device-simulation',
            message: 'load-schematic-end',
            data: [uri],
          })
          .catch(() => undefined);
      } catch (error) {
        void logger
          .write({
            level: 'error',
            scope: 'device-simulation',
            message: 'load-schematic-failed',
            data: [uri, String(error)],
          })
          .catch(() => undefined);
        throw error;
      }
    },
    async reset(): Promise<void> {
      await ensurePrepared();
      return host.reset();
    },
    tick: (dt: number) => host.tick(dt),
    deliver: (target, payload, simTime) => host.deliver(target, payload, simTime),
    onDidPublish: (listener) => {
      const subscription = host.onDidPublish(listener);
      return () => subscription.dispose();
    },
    getTopics: () => host.getTopics(),
    getSimTime: () => host.getSimTime(),
    getSchematic: () => host.getSchematic(),
    dispose: () => host.dispose(),
  };

  const registration = rpc.register(deviceSimulationHostGuestService, service);

  // The direct topic channel registers the same contract on the extra port, so the widget guest can
  // deliver and subscribe without the host in between. It only calls `deliver` and `onDidPublish`;
  // schematic, topics and the clock stay the host's business.
  const topicPort = ports[0];
  const topicRpc = topicPort === undefined ? undefined : createRpc(topicPort);
  const topicRegistration = topicRpc?.register(deviceSimulationHostGuestService, service);

  let disposed = false;
  return {
    rpc,
    ports,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      topicRegistration?.dispose();
      topicRpc?.dispose();
      registration.dispose();
      await host.dispose();
      rpc.dispose();
    },
  };
}
