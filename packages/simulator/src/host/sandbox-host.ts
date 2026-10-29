import { createRpc } from '@mica-js/core/rpc';
import { loggerService } from '@mica-js/core/logging';
import { toDisposable } from '@mica-js/core/lifecycle';
import type { CanvasBindingTarget } from '@mica-js/core/canvas';
import type { SandboxWorker } from '@mica-js/sandbox';
import { deviceSimulationHostFileSystemService, deviceSimulationHostGuestService } from './rpc';
import type { DeviceSimulationHost, DeviceSimTickReport, DeviceTopic } from './types';

/**
 * Read-only byte access the device host needs for schematics.
 *
 * Structurally equal to RFC 0019's `HostFs`, so one object can serve `WidgetHost` and the device
 * host without a second adapter.
 */
export interface DeviceSimulationHostFileSystem {
  read(uri: string): Promise<Uint8Array>;
}

/**
 * The running sandbox the host adapter drives: the full public surface of `SandboxWorker`, kept
 * structural so tests can inject an in-process RPC peer.
 */
export interface SandboxDeviceSimulationHostOptions {
  /**
   * The running sandbox to drive. The caller creates it — for example with the Vite-generated
   * `DeviceSimulationHostGuestSandbox` — and this factory never constructs one.
   */
  readonly sandbox: SandboxWorker;
  /** Host capability: source of schematic bytes; the guest never reads the host file system. */
  readonly fs: DeviceSimulationHostFileSystem;
  /** Extra ports transferred after the RPC port in the guest's first startup message. */
  readonly ports?: readonly MessagePort[];
}

/**
 * Builds a `DeviceSimulationHost` that runs the unified-IR circuit inside a `@mica-js/sandbox` guest.
 *
 * The caller creates the sandbox and passes it in with the other initialization options, so the
 * same host adapter works with the Vite-generated guest class and with in-process RPC peers. The
 * sandbox receives only a `MessagePort`; every call below travels over the typed `guest` RPC service
 * and schematic bytes arrive through the typed `host-capabilities` service. `Circuit` stays entirely
 * inside the guest.
 */
export async function createDeviceSimulationHostFromSandbox({
  sandbox,
  fs,
  ports = [],
}: SandboxDeviceSimulationHostOptions): Promise<DeviceSimulationHost> {
  let channel: MessageChannel | undefined;
  let rpc: ReturnType<typeof createRpc> | undefined;
  let logRegistration: { dispose(): void } | undefined;
  try {
    await sandbox.ready;
    channel = new MessageChannel();
    const endpoint = createRpc(channel.port1);
    rpc = endpoint;
    logRegistration = endpoint.register(loggerService, {
      write(record) {
        const method = console[record.level] ?? console.log;
        method.call(console, `[${record.scope}]`, record.message, ...record.data);
      },
    });
    sandbox.postMessage(null, [channel.port2, ...ports]);
  } catch (error) {
    logRegistration?.dispose();
    rpc?.dispose();
    channel?.port1.close();
    channel?.port2.close();
    await sandbox.terminate('device simulation host failed to start').catch(() => undefined);
    throw error;
  }

  const endpoint = rpc;
  if (endpoint === undefined) {
    throw new Error('Device simulation RPC endpoint was not created.');
  }
  endpoint.register(
    deviceSimulationHostFileSystemService,
    {
      read: (uri: string) => fs.read(uri),
    },
    {
      transfer: (member, value) =>
        member === 'read' && value instanceof Uint8Array ? [value.buffer] : [],
    },
  );
  const guest = endpoint.getProxy(deviceSimulationHostGuestService);
  let disposed = false;

  return {
    loadSchematic: (uri: string | undefined) => guest.loadSchematic(uri),
    reset: () => guest.reset(),
    tick: (dt: number): Promise<DeviceSimTickReport> => guest.tick(dt),
    deliver: (target: CanvasBindingTarget, payload: unknown, simTime?: number) =>
      guest.deliver(target, payload, simTime),
    onDidPublish: (listener) => toDisposable(guest.onDidPublish(listener)),
    getTopics: (): Promise<readonly DeviceTopic[]> => guest.getTopics(),
    getSimTime: () => guest.getSimTime(),
    getSchematic: () => guest.getSchematic(),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await guest.dispose();
      } finally {
        logRegistration?.dispose();
        endpoint.dispose();
        await sandbox.terminate('disposed');
      }
    },
  };
}
