import { createRpc } from '@mica-js/core/rpc';
import type { RpcProxy } from '@mica-js/core/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeviceSimulationHostGuest } from './guest';
import type { DeviceSimulationHostGuest, DeviceSimulationHostGuestOptions } from './guest';
import { deviceSimulationHostFileSystemService, deviceSimulationHostGuestService } from './rpc';
import type { DeviceSimulationHostRpc } from './rpc';
import {
  TOGGLE_DEVICE,
  TOGGLE_SYMBOL,
  createToggleSymbols,
  resolveToggleDevice,
} from './test-helpers';
import type { SimulationPublish } from './types';

/** One-device schematic; the toggle wiring below is what makes it loadable. */
function toggleSchematicBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      sheet: {
        symbols: [
          {
            id: TOGGLE_SYMBOL,
            device: TOGGLE_DEVICE,
            designator: 'K1',
            x: 0,
            y: 0,
            rotation: 0,
          },
        ],
        wires: [],
        junctions: [],
      },
    }),
  );
}

/** Caller-owned device library the tests hand to the guest, exactly as a device package would. */
const toggleDevices: DeviceSimulationHostGuestOptions = {
  devices: createToggleSymbols(),
  resolveDevice: resolveToggleDevice,
};

interface Harness {
  readonly guest: DeviceSimulationHostGuest;
  readonly api: RpcProxy<DeviceSimulationHostRpc>;
  readonly reads: string[];
  readonly publishes: SimulationPublish[];
  /** Round trip that guarantees the guest handled every message posted before it. */
  sync(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Wires the guest the way a worker script does: the guest registers on one end of a
 * `MessageChannel`, the host drives it through typed RPC on the other.
 */
function createHarness(
  options: DeviceSimulationHostGuestOptions = {},
  read: (uri: string) => Uint8Array = toggleSchematicBytes,
  ports: readonly MessagePort[] = [],
): Harness {
  const channel = new MessageChannel();
  const guest = startDeviceSimulationHostGuest(channel.port2, {
    ...options,
    ...(ports.length === 0 ? {} : { ports }),
  });
  const reads: string[] = [];
  const publishes: SimulationPublish[] = [];

  const endpoint = createRpc(channel.port1);
  endpoint.register(
    deviceSimulationHostFileSystemService,
    {
      async read(uri: string): Promise<Uint8Array> {
        reads.push(uri);
        return read(uri);
      },
    },
    {
      transfer: (member, value) =>
        member === 'read' && value instanceof Uint8Array ? [value.buffer] : [],
    },
  );
  const api = endpoint.getProxy(deviceSimulationHostGuestService);
  api.onDidPublish((publish) => publishes.push(publish));

  const sync = async (): Promise<void> => {
    await api.getSimTime();
  };

  cleanups.push(async () => {
    await guest.dispose();
    endpoint.dispose();
  });

  return { guest, api, reads, publishes, sync };
}

describe('startDeviceSimulationHostGuest', () => {
  it('loads a schematic through the typed host file system service', async () => {
    const harness = createHarness(toggleDevices);

    await harness.api.loadSchematic('file:///boards/demo.sch');

    expect(harness.reads).toEqual(['file:///boards/demo.sch']);
    expect(await harness.api.getSchematic()).toMatchObject({ version: 1 });
    expect(await harness.api.getTopics()).toHaveLength(2);
    expect(await harness.api.getSimTime()).toBe(0);

    await harness.api.loadSchematic(undefined);
    expect(await harness.api.getSchematic()).toBeUndefined();
    expect(await harness.api.getTopics()).toEqual([]);
  });

  it('leaves every reference unresolved when no device library is wired', async () => {
    const harness = createHarness();

    await expect(harness.api.loadSchematic('file:///boards/demo.sch')).rejects.toThrow(
      /no runtime device binding/,
    );
  });

  it('publishes caller-declared topics over the RPC subscription', async () => {
    const harness = createHarness(toggleDevices);
    // Subscribing is a message like any other: round-trip before the guest publishes.
    await harness.sync();

    await harness.api.loadSchematic('file:///boards/demo.sch');
    expect(await harness.api.getTopics()).toEqual([
      {
        symbol: TOGGLE_SYMBOL,
        designator: 'K1',
        port: 'lamp',
        direction: 'input',
        type: 'boolean',
        title: 'Lamp',
      },
      {
        symbol: TOGGLE_SYMBOL,
        designator: 'K1',
        port: 'state',
        direction: 'output',
        type: 'boolean',
        title: 'Lamp state',
      },
    ]);

    await harness.api.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true);
    expect(await harness.api.tick(10_000)).toEqual({ simTime: 10_000, executed: 1 });
    await harness.sync();

    expect(harness.publishes).toEqual([
      { target: { symbol: TOGGLE_SYMBOL, port: 'state' }, payload: true, simTime: 10_000 },
    ]);
    expect(await harness.api.getSimTime()).toBe(10_000);
  });

  it('awaits prepare once, and retries it after a failure', async () => {
    let prepared = 0;
    const harness = createHarness({
      ...toggleDevices,
      prepare: async () => {
        prepared += 1;
      },
    });

    await harness.api.loadSchematic('file:///boards/one.sch');
    await harness.api.loadSchematic('file:///boards/one.sch');
    await harness.api.reset();
    expect(prepared).toBe(1);

    let attempts = 0;
    const failing = createHarness({
      ...toggleDevices,
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('device library unavailable');
      },
    });

    await expect(failing.api.loadSchematic('file:///boards/one.sch')).rejects.toThrow(
      'device library unavailable',
    );
    await failing.api.loadSchematic('file:///boards/one.sch');
    expect(attempts).toBe(2);
  });

  it('keeps the extra startup ports in the order the worker received them', () => {
    const first = new MessageChannel();
    const second = new MessageChannel();
    const harness = createHarness({ ...toggleDevices, ports: [first.port1, second.port1] });

    expect(harness.guest.ports).toHaveLength(2);
    expect(harness.guest.ports[0]).toBe(first.port1);
    expect(harness.guest.ports[1]).toBe(second.port1);
  });

  it('serves the topic contract on the direct port too', async () => {
    const topicChannel = new MessageChannel();
    const harness = createHarness(toggleDevices, toggleSchematicBytes, [topicChannel.port2]);
    const topicEndpoint = createRpc(topicChannel.port1);
    const direct = topicEndpoint.getProxy(deviceSimulationHostGuestService);
    const directPublishes: SimulationPublish[] = [];
    direct.onDidPublish((publish) => directPublishes.push(publish));
    cleanups.push(async () => topicEndpoint.dispose());

    await harness.api.loadSchematic('file:///boards/demo.sch');
    // The direct port reaches the same runtime, without going through the sandbox endpoint.
    expect(await direct.getSchematic()).toMatchObject({ version: 1 });

    await direct.deliver({ symbol: TOGGLE_SYMBOL, port: 'lamp' }, true);
    expect(await direct.tick(10_000)).toEqual({ simTime: 10_000, executed: 1 });
    await direct.getSimTime();

    const published = {
      target: { symbol: TOGGLE_SYMBOL, port: 'state' },
      payload: true,
      simTime: 10_000,
    };
    expect(directPublishes).toEqual([published]);
    // Both channels subscribe to the one runtime, so the host sees the same publish.
    expect(harness.publishes).toEqual([published]);
  });

  it('closes the endpoint when the guest is disposed', async () => {
    const channel = new MessageChannel();
    const guest = startDeviceSimulationHostGuest(channel.port2);

    await guest.dispose();

    await expect(guest.rpc.getProxy(deviceSimulationHostGuestService).getSimTime()).rejects.toThrow(
      /closed/,
    );
  });

  it('registers exactly one guest from the worker script first message', async () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    vi.stubGlobal('self', {
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === 'message') listeners.push(listener);
      },
    });
    vi.resetModules();

    await import('../guest/device-simulation-host');
    expect(listeners).toHaveLength(1);

    const channel = new MessageChannel();
    const extra = new MessageChannel();
    listeners[0]!({ ports: [channel.port2, extra.port2] } as unknown as MessageEvent);
    // A repeated first message must not register a second guest on a lost port.
    listeners[0]!({ ports: [new MessageChannel().port2] } as unknown as MessageEvent);

    const endpoint = createRpc(channel.port1);
    cleanups.push(async () => endpoint.dispose());
    endpoint.register(deviceSimulationHostFileSystemService, {
      read: async () => toggleSchematicBytes(),
    });
    const api = endpoint.getProxy(deviceSimulationHostGuestService);

    // The script wires no devices, so it can clear but not compile; the round trip proves the
    // first message registered the typed services on `event.ports[0]`.
    await api.loadSchematic(undefined);
    expect(await api.getSchematic()).toBeUndefined();
    expect(await api.getSimTime()).toBe(0);
  });
});
