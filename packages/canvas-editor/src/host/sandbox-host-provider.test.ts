import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toDisposable } from '@mica-js/core/lifecycle';
import type { SandboxWorker } from '@mica-js/sandbox';
import type { DeviceSimulationHost, DeviceTopic } from '@mica-js/simulator';
import type { WidgetProvider } from '@mica-js/widget';
import {
  deviceSimulationGuest,
  widgetGuest,
  SandboxHostProvider,
  type SandboxHostProviderOptions,
} from './sandbox-host-provider';

/**
 * `createWidgetHost` starts the widget runtime when a document loads, and that runtime is a worker
 * bundle only `@mica-js/widget`'s own build produces. The provider only has to pass the right
 * options through, so this test replaces the factory and inspects what it received.
 */
const factory = vi.hoisted(() => {
  const state: {
    options: Record<string, unknown> | undefined;
    createSandbox: ((options: Record<string, unknown>) => Promise<unknown>) | undefined;
    order: string[];
    createError: unknown;
  } = { options: undefined, createSandbox: undefined, order: [], createError: undefined };
  return {
    state,
    createWidgetHost: (
      options: Record<string, unknown>,
      createSandbox: (options: Record<string, unknown>) => Promise<unknown>,
    ) => {
      if (state.createError !== undefined) {
        throw state.createError;
      }
      state.options = options;
      state.createSandbox = createSandbox;
      return {
        dispose: async () => {
          state.order.push('widget:dispose');
        },
      };
    },
  };
});

const deviceAdapter = vi.hoisted(() => {
  const state: {
    host: unknown;
    error: unknown;
    options: Record<string, unknown> | undefined;
    onCreate: (() => void) | undefined;
  } = { host: undefined, error: undefined, options: undefined, onCreate: undefined };
  return {
    state,
    create: async (options: Record<string, unknown>) => {
      state.options = options;
      state.onCreate?.();
      if (state.error !== undefined) throw state.error;
      const sandbox = options.sandbox as SandboxWorker;
      const ports = options.ports as readonly MessagePort[];
      const rpc = new MessageChannel();
      sandbox.postMessage(null, [rpc.port1, ...ports]);
      return state.host;
    },
  };
});

vi.mock('@mica-js/widget', () => ({
  createWidgetHost: factory.createWidgetHost,
  createWidgetSandboxFromWorker: async () => ({}),
}));
vi.mock('@mica-js/simulator/sandbox', () => ({
  createDeviceSimulationHostFromSandbox: deviceAdapter.create,
}));

/** Records what the host does to the guest instead of starting a real sandbox. */
class FakeWorker {
  readonly id = 'worker';
  readonly name = 'fake';
  readonly state = 'ready';
  readonly ready: Promise<void> = Promise.resolve();
  readonly terminations: (string | undefined)[] = [];
  /** Ports the provider transferred with the first ordinary message, in arrival order. */
  readonly ports: MessagePort[] = [];

  postMessage(_message: unknown, transfer: readonly Transferable[] = []): void {
    this.ports.push(...(transfer as MessagePort[]));
  }

  onError(): () => void {
    return () => {};
  }

  async terminate(reason?: string): Promise<void> {
    this.terminations.push(reason);
  }
}

/** Device simulation host stand-in: the provider only disposes it and hands it to the widget host. */
class FakeDeviceHost {
  readonly order: string[];
  topics: readonly DeviceTopic[] = [];

  constructor(order: string[]) {
    this.order = order;
  }

  async loadSchematic(): Promise<void> {}

  async reset(): Promise<void> {}

  async tick(): Promise<{ simTime: number; executed: number }> {
    return { simTime: 0, executed: 0 };
  }

  async deliver(): Promise<void> {}

  readonly onDidPublish = () => toDisposable(() => {});

  async getTopics(): Promise<readonly DeviceTopic[]> {
    return this.topics;
  }

  async getSimTime(): Promise<number> {
    return 0;
  }

  async getSchematic(): Promise<undefined> {
    return undefined;
  }

  async dispose(): Promise<void> {
    this.order.push('device:dispose');
  }
}

const widgetProvider: WidgetProvider = {
  resolve: async () => undefined,
};

const fs = { read: async () => new Uint8Array() };

interface Harness {
  readonly provider: SandboxHostProvider;
  readonly labels: string[];
  readonly workers: FakeWorker[];
  readonly deviceHost: FakeDeviceHost;
  readonly order: string[];
}

function harness(overrides: Partial<SandboxHostProviderOptions> = {}): Harness {
  const labels: string[] = [];
  const workers: FakeWorker[] = [];
  const order = factory.state.order;
  order.length = 0;
  factory.state.options = undefined;
  const deviceHost = new FakeDeviceHost(order);
  deviceAdapter.state.host = deviceHost as unknown as DeviceSimulationHost;
  deviceAdapter.state.error = undefined;
  deviceAdapter.state.options = undefined;
  deviceAdapter.state.onCreate = () => order.push('device:create');
  const options: SandboxHostProviderOptions = {
    getSandboxWorker(label) {
      labels.push(label);
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as SandboxWorker;
    },
    fs,
    widgetProvider,
    ...overrides,
  };
  return { provider: new SandboxHostProvider(options), labels, workers, deviceHost, order };
}

beforeEach(() => {
  factory.state.options = undefined;
  factory.state.createSandbox = undefined;
  factory.state.createError = undefined;
  deviceAdapter.state.options = undefined;
  deviceAdapter.state.error = undefined;
  deviceAdapter.state.onCreate = undefined;
});

describe('SandboxHostProvider', () => {
  it('starts the device guest and wraps the device host in a widget host', async () => {
    const harnessed = harness();

    const host = await harnessed.provider.createWidgetHost();

    expect(harnessed.labels).toEqual([deviceSimulationGuest]);
    expect(harnessed.provider.widgetHost).toBe(host);
    expect(harnessed.provider.deviceHost).toBe(harnessed.deviceHost);
    // The widget host is built over the device host, the file system and the widget definitions.
    expect(factory.state.options).toMatchObject({
      widgetProvider,
      deviceHost: harnessed.deviceHost,
      fs,
    });
    await factory.state.createSandbox?.({});
    expect(harnessed.labels).toEqual([deviceSimulationGuest, widgetGuest]);

    await harnessed.provider.dispose();
  });

  it('wires one port pair between the device guest and the widget guest', async () => {
    const harnessed = harness();

    await harnessed.provider.createWidgetHost();

    // The device guest receives its RPC port and the direct topic port in one startup message;
    // the widget host receives the other end of the direct channel.
    const devicePorts = harnessed.workers[0]?.ports ?? [];
    expect(devicePorts).toHaveLength(2);
    const widgetPort = (factory.state.options as { devicePort?: MessagePort } | undefined)
      ?.devicePort;
    expect(widgetPort).toBeInstanceOf(MessagePort);
    expect(widgetPort).not.toBe(devicePorts[1]);

    await harnessed.provider.dispose();
  });

  it('creates one host however often it is asked', async () => {
    const harnessed = harness();

    const [first, second] = await Promise.all([
      harnessed.provider.createWidgetHost(),
      harnessed.provider.createWidgetHost(),
    ]);

    expect(first).toBe(second);
    expect(harnessed.labels).toHaveLength(1);
    await harnessed.provider.dispose();
  });

  it('disposes the widget host before the device host it drives', async () => {
    const harnessed = harness();
    await harnessed.provider.createWidgetHost();

    await harnessed.provider.dispose();

    expect(harnessed.order).toEqual(['device:create', 'widget:dispose', 'device:dispose']);
    expect(harnessed.provider.widgetHost).toBeUndefined();
    expect(harnessed.provider.deviceHost).toBeUndefined();
  });

  it('disposes once, however often dispose is called', async () => {
    const harnessed = harness();
    await harnessed.provider.createWidgetHost();

    await Promise.all([harnessed.provider.dispose(), harnessed.provider.dispose()]);
    await harnessed.provider.dispose();

    expect(harnessed.order.filter((entry) => entry === 'device:dispose')).toHaveLength(1);
  });

  it('disposes a host that was still being created', async () => {
    let release: ((worker: SandboxWorker) => void) | undefined;
    const harnessed = harness({
      getSandboxWorker: () =>
        new Promise<SandboxWorker>((resolve) => {
          release = resolve;
        }),
    });

    const creating = harnessed.provider.createWidgetHost();
    const disposing = harnessed.provider.dispose();
    release?.(new FakeWorker() as unknown as SandboxWorker);
    await disposing;

    // The host that appeared after `dispose()` started is released too, not leaked.
    await expect(creating).resolves.toBeDefined();
    expect(harnessed.order).toEqual(['device:create', 'widget:dispose', 'device:dispose']);
  });

  it('terminates the guest when the device provider refuses it', async () => {
    const harnessed = harness();
    deviceAdapter.state.error = new Error('device guest rejected');

    await expect(harnessed.provider.createWidgetHost()).rejects.toThrow('device guest rejected');

    expect(harnessed.workers[0]?.terminations).toEqual(['device simulation host failed to start']);
    expect(factory.state.options).toBeUndefined();
    expect(harnessed.provider.widgetHost).toBeUndefined();
    expect(harnessed.provider.deviceHost).toBeUndefined();
    await harnessed.provider.dispose();
  });

  it('releases the device host when the widget host cannot be created', async () => {
    const harnessed = harness();
    factory.state.createError = new TypeError('createWidgetHost requires a widgetProvider');

    await expect(harnessed.provider.createWidgetHost()).rejects.toThrow(
      'requires a widgetProvider',
    );

    expect(harnessed.order).toEqual(['device:create', 'device:dispose']);
    expect(harnessed.provider.deviceHost).toBeUndefined();
    await harnessed.provider.dispose();
  });

  it('reports the device endpoints as binding targets, resolving the designator', async () => {
    const harnessed = harness();
    harnessed.deviceHost.topics = [
      { symbol: 's1', designator: 'S1', port: 'pressed', direction: 'output', type: 'boolean' },
      // A symbol the schematic gives no designator: the id stands in.
      { symbol: 's2', port: 'value', direction: 'input', type: 'number' },
    ];

    // The provider is still creating the device host when the targets are asked for.
    const creating = harnessed.provider.createWidgetHost();

    await expect(harnessed.provider.getBindingTargets()).resolves.toEqual([
      { symbol: 's1', designator: 'S1', port: 'pressed', direction: 'output', type: 'boolean' },
      { symbol: 's2', designator: 's2', port: 'value', direction: 'input', type: 'number' },
    ]);
    await creating;
    await harnessed.provider.dispose();
  });

  it('answers with no targets before a host exists and after disposal', async () => {
    const harnessed = harness();
    harnessed.deviceHost.topics = [
      { symbol: 's1', designator: 'S1', port: 'pressed', direction: 'output', type: 'boolean' },
    ];

    await expect(harnessed.provider.getBindingTargets()).resolves.toEqual([]);

    await harnessed.provider.createWidgetHost();
    await harnessed.provider.dispose();

    await expect(harnessed.provider.getBindingTargets()).resolves.toEqual([]);
  });

  it('refuses to create a host once it is disposed', async () => {
    const harnessed = harness();
    await harnessed.provider.dispose();

    await expect(harnessed.provider.createWidgetHost()).rejects.toThrow(
      'The sandbox host provider was already disposed.',
    );
  });
});
