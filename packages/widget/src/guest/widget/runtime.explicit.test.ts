import { timePs } from '@mica-js/core';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetDefinition } from '../../types';
import {
  widgetErrorEvent,
  widgetFrameEvent,
  widgetGuestService,
  widgetHostControlService,
  widgetMountMethod,
  widgetPublishEvent,
  widgetSetBindingsMethod,
  widgetSimulationRuntimeService,
  widgetStepMethod,
} from './protocol';
import type {
  IWidgetSimulationRuntimeChannel,
  WidgetErrorMessage,
  WidgetFrameMessage,
  IWidgetGuestRuntimeConfig,
  IWidgetGuestStep,
  WidgetPublishMessage,
  IWidgetSimulationPublish,
} from './protocol';
import type { WidgetInstanceApi, WidgetImplementation } from './types';
import { createWidgetRuntime, startWidgetRuntime } from './runtime';
import type { WidgetRuntime, WidgetRuntimeChannel } from './runtime';

interface FakeBitmap {
  closed: boolean;
  close(): void;
}

const canvases: FakeCanvas[] = [];

class FakeCanvas {
  width: number;
  height: number;
  readonly frames: FakeBitmap[] = [];
  readonly context = { setTransform: vi.fn(), clearRect: vi.fn() };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    canvases.push(this);
  }

  getContext(kind: string): unknown {
    return kind === '2d' ? this.context : null;
  }

  transferToImageBitmap(): FakeBitmap {
    const bitmap: FakeBitmap = { closed: false, close: () => (bitmap.closed = true) };
    this.frames.push(bitmap);
    return bitmap;
  }
}

afterEach(() => {
  canvases.length = 0;
  vi.unstubAllGlobals();
});

type Factory = (api: WidgetInstanceApi) => WidgetImplementation | void;

interface CapturedEvent {
  readonly type: string;
  readonly payload: unknown;
}

interface GuestHarness {
  readonly runtime: WidgetRuntime;
  readonly events: CapturedEvent[];
  readonly imports: string[];
}

function createGuestHarness(
  factories: Readonly<Record<string, Factory>>,
  options: {
    readonly explicitStepping?: boolean;
    readonly device?: IWidgetSimulationRuntimeChannel;
  } = {},
): GuestHarness {
  const events: CapturedEvent[] = [];
  const imports: string[] = [];
  const channel: WidgetRuntimeChannel = {
    on: () => () => {},
    emit(type, payload) {
      events.push({ type, payload });
    },
  };
  const runtime = createWidgetRuntime(channel, {
    importModule: async (code) => {
      imports.push(code);
      return { default: factories[code] };
    },
    ...(options.explicitStepping === undefined
      ? {}
      : { explicitStepping: options.explicitStepping }),
    ...(options.device === undefined ? {} : { device: options.device }),
  });
  return { runtime, events, imports };
}

interface FakeDeviceChannel {
  readonly channel: IWidgetSimulationRuntimeChannel;
  readonly delivered: {
    readonly target: { readonly symbol: string; readonly port: string };
    readonly payload: unknown;
    readonly simTime: number | undefined;
  }[];
  publish(publish: IWidgetSimulationPublish): void;
}

function createFakeDeviceChannel(
  deliver?: (
    target: { readonly symbol: string; readonly port: string },
    payload: unknown,
    simTime: number | undefined,
  ) => Promise<void>,
): FakeDeviceChannel {
  const delivered: FakeDeviceChannel['delivered'] = [];
  const listeners = new Set<(publish: IWidgetSimulationPublish) => void>();
  const channel: IWidgetSimulationRuntimeChannel = {
    deliver: async ({ target, payload, simTime }) => {
      delivered.push({ target, payload, simTime });
      await deliver?.(target, payload, simTime);
    },
    onDidPublish(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    channel,
    delivered,
    publish(publish) {
      for (const listener of [...listeners]) listener(publish);
    },
  };
}

const definition: WidgetDefinition = { properties: {}, ports: {} };

function loadRequest(code: string) {
  return {
    packages: [{ id: 'demo', modules: { indicator: { definition, code } } }],
  };
}

function mountRequest(extra: Record<string, unknown> = {}) {
  return {
    instanceId: 'a',
    widget: 'demo:indicator',
    width: 40,
    height: 20,
    dpr: 1,
    ...extra,
  };
}

function frames(events: readonly CapturedEvent[]): WidgetFrameMessage[] {
  return events
    .filter((event) => event.type === widgetFrameEvent)
    .map((event) => event.payload as WidgetFrameMessage);
}

function publishes(events: readonly CapturedEvent[]): WidgetPublishMessage[] {
  return events
    .filter((event) => event.type === widgetPublishEvent)
    .map((event) => event.payload as WidgetPublishMessage);
}

function errors(events: readonly CapturedEvent[]): WidgetErrorMessage[] {
  return events
    .filter((event) => event.type === widgetErrorEvent)
    .map((event) => event.payload as WidgetErrorMessage);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('widget guest explicit stepping', () => {
  it('defers repaints until step and uses the step time for an omitted publish timestamp', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createGuestHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      { explicitStepping: true },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    expect(frames(events)).toHaveLength(1);

    api?.invalidate();
    await tick();
    expect(frames(events)).toHaveLength(1);

    const step: IWidgetGuestStep = {
      simTime: timePs(100),
      dt: timePs(25),
      mode: 'simulation',
    };
    await runtime.step(step);
    expect(frames(events)).toHaveLength(2);

    api?.publish('value', 7);
    expect(publishes(events)[0]).toMatchObject({
      simTime: timePs(100),
      instanceId: 'a',
      port: 'value',
    });
    runtime.dispose();
  });

  it('keeps automatic repaint scheduling when the runtime was not configured for stepping', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createGuestHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    api?.invalidate();
    await tick();

    expect(frames(events)).toHaveLength(2);
    api?.publish('value', 7);
    expect(publishes(events)[0]).toMatchObject({ simTime: timePs(0) });
    runtime.dispose();
  });

  it('replaces prefetched assets without remounting', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createGuestHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'a.bin': new Uint8Array([1]) } }));
    expect([...(await api!.assets.readBinary('a.bin'))]).toEqual([1]);

    runtime.setAssets('a', { 'a.bin': new Uint8Array([2, 3]) });
    expect([...(await api!.assets.readBinary('a.bin'))]).toEqual([2, 3]);
    runtime.dispose();
  });

  it('queues direct device publishes until the next explicit step', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const received: [unknown, { simTime: number }][] = [];
    const device = createFakeDeviceChannel();
    const { runtime } = createGuestHarness(
      {
        widget: (api) => {
          api.subscribe('brightness', (payload, meta) => received.push([payload, meta]));
          return {};
        },
      },
      { explicitStepping: true, device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { brightness: { symbol: 'led', port: 'anode' } });

    device.publish({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: timePs(10) });
    expect(received).toEqual([]);

    await runtime.step({ simTime: timePs(10), dt: timePs(1), mode: 'simulation' });
    expect(received).toEqual([[5, { simTime: timePs(10) }]]);
    runtime.dispose();
  });

  it('drops queued direct input when its only instance unmounts', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const received: unknown[] = [];
    const device = createFakeDeviceChannel();
    const { runtime } = createGuestHarness(
      {
        widget: (api) => {
          api.subscribe('brightness', (payload) => received.push(payload));
          return {};
        },
      },
      { explicitStepping: true, device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { brightness: { symbol: 'led', port: 'anode' } });
    device.publish({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: timePs(10) });

    runtime.unmount('a');
    await runtime.step({ simTime: timePs(10), dt: timePs(1), mode: 'simulation' });
    expect(received).toEqual([]);
    runtime.dispose();
  });

  it('resolves step only after direct widget publishes settle', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let resolveDelivery: (() => void) | undefined;
    const device = createFakeDeviceChannel(
      () =>
        new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createGuestHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      { explicitStepping: true, device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { value: { symbol: 'led', port: 'input' } });
    api!.publish('value', 7, 100);

    let stepped = false;
    const stepping = runtime
      .step({ simTime: timePs(100), dt: timePs(0), mode: 'edit' })
      .then(() => {
        stepped = true;
      });
    await tick();
    expect(stepped).toBe(false);

    resolveDelivery?.();
    await stepping;
    expect(stepped).toBe(true);
    expect(device.delivered).toEqual([
      { target: { symbol: 'led', port: 'input' }, payload: 7, simTime: timePs(100) },
    ]);
    runtime.dispose();
  });

  it('waits for publishes triggered by queued input before resolving step', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let resolveDelivery: (() => void) | undefined;
    const device = createFakeDeviceChannel(
      () =>
        new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    const { runtime } = createGuestHarness(
      {
        widget: (api) => {
          api.subscribe('brightness', (payload, meta) => {
            api.publish('value', payload, meta.simTime);
          });
          return {};
        },
      },
      { explicitStepping: true, device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', {
      brightness: { symbol: 'led', port: 'anode' },
      value: { symbol: 'led', port: 'input' },
    });
    device.publish({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: timePs(10) });

    let stepped = false;
    const stepping = runtime
      .step({ simTime: timePs(10), dt: timePs(1), mode: 'simulation' })
      .then(() => {
        stepped = true;
      });
    await tick();
    expect(device.delivered).toHaveLength(1);
    expect(stepped).toBe(false);

    resolveDelivery?.();
    await stepping;
    expect(stepped).toBe(true);
    runtime.dispose();
  });

  it('rejects explicit mount when the first paint fails and allows a retry', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let calls = 0;
    const { runtime, events } = createGuestHarness(
      {
        widget: () => {
          calls += 1;
          if (calls === 1) {
            return {
              render: () => {
                throw new Error('bad paint');
              },
            };
          }
          return {};
        },
      },
      { explicitStepping: true },
    );

    await runtime.load(loadRequest('widget'));
    expect(() => runtime.mount(mountRequest())).toThrow('failed during its first paint');
    expect(errors(events)).toEqual([
      { instanceId: 'a', phase: 'render', error: { name: 'Error', message: 'bad paint' } },
    ]);
    expect(frames(events)).toHaveLength(0);

    runtime.mount(mountRequest());
    expect(frames(events)).toHaveLength(1);
    runtime.dispose();
  });
});

/** In-memory `RpcPort` pair; structured clone is unnecessary for the protocol test. */
class LinkedPort {
  peer: LinkedPort | undefined;
  readonly #listeners = new Set<(event: Event) => void>();

  postMessage(message: unknown): void {
    const peer = this.peer;
    if (!peer) throw new Error('LinkedPort is not connected');
    queueMicrotask(() => peer.#dispatch(message));
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (type === 'message') this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    if (type === 'message') this.#listeners.delete(listener);
  }

  close(): void {
    this.#listeners.clear();
    this.peer = undefined;
  }

  #dispatch(data: unknown): void {
    for (const listener of [...this.#listeners]) {
      listener({ data } as unknown as Event);
    }
  }
}

function linkedPair(): [LinkedPort, LinkedPort] {
  const left = new LinkedPort();
  const right = new LinkedPort();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

describe('widget guest simulation-runtime direct lane', () => {
  it('switches the direct port to the simulation-runtime contract before the first mount', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const [guestPort, hostPort] = linkedPair();
    const [deviceGuestPort, deviceHostPort] = linkedPair();

    const delivered: {
      readonly target: { readonly symbol: string; readonly port: string };
      readonly payload: unknown;
      readonly simTime: number | undefined;
    }[] = [];
    const deviceListeners = new Set<(publish: IWidgetSimulationPublish) => void>();
    const deviceRpc: RpcEndpoint = createRpc(deviceHostPort);
    deviceRpc.register(widgetSimulationRuntimeService, {
      deliver: async (message) => {
        delivered.push(message);
      },
      onDidPublish(listener) {
        deviceListeners.add(listener);
        return () => deviceListeners.delete(listener);
      },
    });

    const received: [unknown, { simTime: number }][] = [];
    let api: WidgetInstanceApi | undefined;
    const worker = startWidgetRuntime(guestPort as unknown as MessagePort, {
      ports: [deviceGuestPort as unknown as MessagePort],
      importModule: async () => ({
        default: (instanceApi: WidgetInstanceApi) => {
          api = instanceApi;
          instanceApi.subscribe('brightness', (payload, meta) => received.push([payload, meta]));
          return {};
        },
      }),
    });

    const forwarded: CapturedEvent[] = [];
    const rpc = createRpc(hostPort);
    rpc.register(widgetHostControlService, {
      event: (type: string, payload: unknown) => {
        forwarded.push({ type, payload });
      },
    });
    const guest = rpc.getProxy(widgetGuestService);

    const config: IWidgetGuestRuntimeConfig = {
      explicitStepping: true,
      directTopicService: 'simulation-runtime',
    };
    await expect(guest.configure(config)).resolves.toBe(true);

    await guest.load(loadRequest('widget'));
    await guest[widgetMountMethod](mountRequest({ generation: 7 }));
    await tick();
    await guest[widgetSetBindingsMethod]('a', {
      value: { symbol: 'led', port: 'input' },
      brightness: { symbol: 'led', port: 'anode' },
    });

    api?.publish('value', 7, 1280);
    await tick();
    expect(delivered).toEqual([
      { target: { symbol: 'led', port: 'input' }, payload: 7, simTime: timePs(1280) },
    ]);
    expect(publishes(forwarded)[0]).toMatchObject({ direct: true, simTime: timePs(1280) });
    expect(frames(forwarded)[0]?.generation).toBe(7);

    for (const listener of [...deviceListeners]) {
      listener({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: timePs(10) });
    }
    await tick();
    expect(received).toEqual([]);

    await guest[widgetStepMethod]({ simTime: timePs(10), dt: timePs(1), mode: 'simulation' });
    expect(received).toEqual([[5, { simTime: timePs(10) }]]);

    worker.dispose();
    rpc.dispose();
    deviceRpc.dispose();
    guestPort.close();
    hostPort.close();
    deviceGuestPort.close();
    deviceHostPort.close();
  });

  it('reports no direct lane when the worker received no device port', async () => {
    const events: CapturedEvent[] = [];
    const runtime = createWidgetRuntime({
      emit(type, payload) {
        events.push({ type, payload });
      },
      on: () => () => {},
    });

    expect(
      runtime.configure({ explicitStepping: true, directTopicService: 'simulation-runtime' }),
    ).toBe(false);
    runtime.dispose();
  });
});
