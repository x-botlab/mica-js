import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpc } from '@mica-js/core/rpc';
import type { RpcEndpoint } from '@mica-js/core/rpc';
import type { SimulationPublish } from '@mica-js/simulator';
import type { WidgetDefinition } from '../../types';
import { widgetAudioGuestService } from '../audio/protocol';
import { createFakeWorklet, flush } from '../audio/test-helpers';
import {
  widgetAssetFailedEvent,
  widgetDeviceTopicService,
  widgetErrorEvent,
  widgetFrameEvent,
  widgetGuestService,
  widgetHostControlService,
  widgetMountMethod,
  widgetPublishEvent,
  widgetSetBindingsMethod,
} from './protocol';
import type {
  WidgetAssetFailedMessage,
  WidgetDeviceTopicChannel,
  WidgetErrorMessage,
  WidgetFrameMessage,
  WidgetPublishMessage,
} from './protocol';
import type { WidgetInputEvent, WidgetImplementation, WidgetInstanceApi } from './types';
import { createWidgetRuntime, startWidgetRuntime } from './runtime';
import type { WidgetRuntime, WidgetRuntimeChannel } from './runtime';

interface FakeBitmap {
  closed: boolean;
  close(): void;
}

interface CapturedFrame {
  readonly bitmap: FakeBitmap;
  readonly width: number;
  readonly height: number;
}

interface CapturedEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly transfer: readonly Transferable[] | undefined;
}

const canvases: FakeCanvas[] = [];

class FakeCanvas {
  width: number;
  height: number;
  readonly frames: CapturedFrame[] = [];
  readonly setTransform = vi.fn();
  readonly clearRect = vi.fn();
  readonly context = {
    setTransform: this.setTransform,
    clearRect: this.clearRect,
  };

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
    this.frames.push({ bitmap, width: this.width, height: this.height });
    return bitmap;
  }
}

type Factory = (api: WidgetInstanceApi) => WidgetImplementation | void;

interface Harness {
  readonly runtime: WidgetRuntime;
  readonly events: CapturedEvent[];
  readonly imports: string[];
}

interface HarnessOptions {
  /** Replaces the code → factory table; used to model module-level state across evaluations. */
  readonly importModule?: (code: string) => Promise<unknown>;
  /** Direct device channel; without it the guest stays in host-routed mode. */
  readonly device?: WidgetDeviceTopicChannel;
}

function createHarness(
  factories: Readonly<Record<string, Factory>>,
  options: HarnessOptions = {},
): Harness {
  const events: CapturedEvent[] = [];
  const imports: string[] = [];

  const channel: WidgetRuntimeChannel = {
    on: () => () => {},
    emit(type: string, payload?: unknown, transfer?: readonly Transferable[]) {
      events.push({ type, payload, transfer });
    },
  };

  const runtime = createWidgetRuntime(channel, {
    importModule:
      options.importModule ??
      (async (code) => {
        imports.push(code);
        return { default: factories[code] };
      }),
    ...(options.device === undefined ? {} : { device: options.device }),
  });

  return { runtime, events, imports };
}

const definition: WidgetDefinition = { properties: {}, ports: {} };

const defaultsDefinition: WidgetDefinition = {
  properties: {
    color: { type: 'color', default: '#22AA55FF' },
    label: { type: 'string', default: null },
    hidden: { type: 'boolean' },
  },
  ports: {},
};

function loadRequest(code: string, widgetDefinition: WidgetDefinition = definition) {
  return {
    packages: [{ id: 'demo', modules: { indicator: { definition: widgetDefinition, code } } }],
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

function errors(events: readonly CapturedEvent[]): WidgetErrorMessage[] {
  return events
    .filter((event) => event.type === widgetErrorEvent)
    .map((event) => event.payload as WidgetErrorMessage);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeEndpoint {
  readonly endpoint: RpcEndpoint;
  readonly registrations: Map<string, Record<string, unknown>>;
  readonly proxies: Map<string, unknown>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

function createFakeEndpoint(events: CapturedEvent[]): FakeEndpoint {
  const registrations = new Map<string, Record<string, unknown>>();
  const proxies = new Map<string, unknown>();
  const dispose = vi.fn();
  const endpoint = {
    register(serviceId: string, implementation: Record<string, unknown>) {
      registrations.set(serviceId, implementation);
      return { dispose: () => registrations.delete(serviceId) };
    },
    getProxy(serviceId: string, options?: unknown) {
      proxies.set(serviceId, options);
      return {
        event(type: string, payload?: unknown, transfer?: readonly Transferable[]) {
          events.push({ type, payload, transfer });
          return Promise.resolve();
        },
        write() {
          return Promise.resolve();
        },
      };
    },
    onDidError: () => () => {},
    onDidClose: () => () => {},
    dispose,
  };
  return { endpoint: endpoint as unknown as RpcEndpoint, registrations, proxies, dispose };
}

interface HostControlOptions {
  readonly transfer: (member: string, args: readonly unknown[]) => readonly Transferable[];
}

function guestControl(fake: FakeEndpoint) {
  return fake.registrations.get('guest-control') as unknown as {
    dispatchEvent(type: string, payload: unknown): void;
    terminate(): void;
  };
}

/** In-memory `RpcPort` pair; no structured clone, so transferred bitmaps stay objects. */
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

  #dispatch(data: unknown): void {
    for (const listener of [...this.#listeners]) {
      listener({ data } as unknown as Event);
    }
  }
}

afterEach(() => {
  canvases.length = 0;
  vi.unstubAllGlobals();
});

describe('widget worker entry', () => {
  it('registers every host method on the startup port', () => {
    const fake = createFakeEndpoint([]);

    startWidgetRuntime({ close: vi.fn() } as unknown as MessagePort, {
      createEndpoint: () => fake.endpoint,
    });

    expect([...fake.registrations.keys()]).toEqual(['guest', 'guest-control', 'audio-guest']);
    expect(Object.keys(fake.registrations.get('guest') ?? {})).toEqual([
      'load',
      'mount',
      'unmount',
      'resize',
      'set-properties',
      'set-bindings',
      'deliver',
      'pointer',
      'reset-runtime',
    ]);
    expect(Object.keys(guestControl(fake))).toEqual(['dispatchEvent', 'terminate']);
    expect(Object.keys(fake.registrations.get('audio-guest') ?? {})).toEqual([
      'attachPort',
      'setState',
    ]);
  });

  it('forwards runtime events over host-control with their transfer list', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const events: CapturedEvent[] = [];
    const fake = createFakeEndpoint(events);
    const worker = startWidgetRuntime({ close: vi.fn() } as unknown as MessagePort, {
      createEndpoint: () => fake.endpoint,
      importModule: async () => ({ default: () => ({}) }),
    });

    await worker.runtime.load(loadRequest('widget'));
    worker.runtime.mount(mountRequest());

    const frame = events.find((event) => event.type === widgetFrameEvent);
    expect(frame?.transfer).toEqual([(frame?.payload as WidgetFrameMessage).bitmap]);

    const options = fake.proxies.get('host-control') as HostControlOptions;
    expect(options.transfer('event', ['widget:frame', {}, frame?.transfer])).toEqual([
      frame?.transfer?.[0],
    ]);
    expect(options.transfer('load', [])).toEqual([]);
  });

  it('routes host events into the runtime through guest-control', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const fake = createFakeEndpoint([]);
    const worker = startWidgetRuntime({ close: vi.fn() } as unknown as MessagePort, {
      createEndpoint: () => fake.endpoint,
      importModule: async () => ({
        default: (instanceApi: WidgetInstanceApi) => {
          api = instanceApi;
          return {};
        },
      }),
    });

    await worker.runtime.load(loadRequest('widget'));
    worker.runtime.mount(mountRequest({ audio: { state: 'unavailable' } }));
    expect(api?.audio.state).toBe('unavailable');

    const audio = fake.registrations.get(widgetAudioGuestService) as unknown as {
      setState(state: string): void;
    };
    audio.setState('running');
    expect(api?.audio.state).toBe('running');
  });

  it('disposes the runtime, the endpoint and the port when the host terminates the guest', () => {
    const fake = createFakeEndpoint([]);
    const close = vi.fn();
    const worker = startWidgetRuntime({ close } as unknown as MessagePort, {
      createEndpoint: () => fake.endpoint,
    });

    guestControl(fake).terminate();

    expect(fake.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(() => worker.runtime.mount(mountRequest())).toThrow('disposed');
  });

  it('serves the widget methods over a real RPC endpoint', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const guestPort = new LinkedPort();
    const hostPort = new LinkedPort();
    guestPort.peer = hostPort;
    hostPort.peer = guestPort;

    startWidgetRuntime(guestPort as unknown as MessagePort, {
      importModule: async () => ({ default: () => ({}) }),
    });
    const rpc = createRpc(hostPort);
    const forwarded: CapturedEvent[] = [];
    rpc.register(widgetHostControlService, {
      event: (type: string, payload: unknown, transfer?: readonly Transferable[]) => {
        forwarded.push({ type, payload, transfer });
      },
    });
    const guest = rpc.getProxy(widgetGuestService);

    await guest.load(loadRequest('widget'));
    await guest[widgetMountMethod](mountRequest());
    await tick();

    expect(forwarded.map((event) => event.type)).toContain(widgetFrameEvent);
    const frame = forwarded.find((event) => event.type === widgetFrameEvent);
    expect(frame?.transfer).toEqual([(frame?.payload as WidgetFrameMessage).bitmap]);

    rpc.dispose();
  });

  it('routes topic traffic over the port pair the assembly layer wired', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const guestPort = new LinkedPort();
    const hostPort = new LinkedPort();
    guestPort.peer = hostPort;
    hostPort.peer = guestPort;
    const deviceGuestPort = new LinkedPort();
    const deviceHostPort = new LinkedPort();
    deviceGuestPort.peer = deviceHostPort;
    deviceHostPort.peer = deviceGuestPort;

    let api: WidgetInstanceApi | undefined;
    const received: unknown[] = [];
    const delivered: { readonly payload: unknown; readonly simTime: number | undefined }[] = [];
    const deviceListeners = new Set<(publish: SimulationPublish) => void>();

    // The device guest: the same service name the simulator registers, reached without the host. It
    // has to exist before the widget guest starts, because the guest subscribes at startup.
    const deviceRpc = createRpc(deviceHostPort);
    deviceRpc.register(widgetDeviceTopicService, {
      deliver: async (_target: unknown, payload: unknown, simTime?: number) => {
        delivered.push({ payload, simTime });
      },
      onDidPublish(listener: (publish: SimulationPublish) => void) {
        deviceListeners.add(listener);
        return () => deviceListeners.delete(listener);
      },
    });

    startWidgetRuntime(guestPort as unknown as MessagePort, {
      ports: [deviceGuestPort as unknown as MessagePort],
      importModule: async () => ({
        default: (instanceApi: WidgetInstanceApi) => {
          api = instanceApi;
          instanceApi.subscribe('brightness', (payload) => received.push(payload));
          return {};
        },
      }),
    });

    const rpc = createRpc(hostPort);
    rpc.register(widgetHostControlService, { event: () => {} });
    const guest = rpc.getProxy(widgetGuestService);

    await guest.load(loadRequest('widget'));
    await guest[widgetMountMethod](mountRequest());
    await guest[widgetSetBindingsMethod]('a', {
      value: { symbol: 'led', port: 'input' },
      brightness: { symbol: 'led', port: 'anode' },
    });

    api?.publish('value', 7, 1280);
    await tick();
    expect(delivered).toEqual([{ payload: 7, simTime: 1280 }]);

    for (const listener of [...deviceListeners]) {
      listener({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: 10 });
    }
    // The publish crosses the port pair, so it lands on the guest's queue after this turn.
    await tick();
    expect(received).toEqual([5]);

    rpc.dispose();
    deviceRpc.dispose();
  });
});

describe('widget guest runtime', () => {
  it('renders and transfers one frame on mount, scaled by the device pixel ratio', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ dpr: 2 }));

    const frames = events.filter((event) => event.type === widgetFrameEvent);
    expect(frames).toHaveLength(1);

    const payload = frames[0]?.payload as WidgetFrameMessage;
    expect(payload).toMatchObject({ instanceId: 'a', width: 40, height: 20, dpr: 2 });
    expect(frames[0]?.transfer).toEqual([payload.bitmap]);

    const canvas = canvases[0];
    expect(canvas?.width).toBe(80);
    expect(canvas?.height).toBe(40);
    expect(canvas?.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('coalesces every invalidate in one tick into a single frame', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(1);

    api?.invalidate();
    api?.invalidate();
    api?.invalidate();
    await tick();

    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(2);
  });

  it('keeps a static instance from producing frames until it is invalidated', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({ render: () => {} }) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    await tick();
    await tick();

    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(1);
  });

  it('commits one frame when the factory invalidates during construction', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({
      widget: (api) => {
        api.invalidate();
        return { render: () => {} };
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    const committed = (): number =>
      events.filter((event) => event.type === widgetFrameEvent).length;

    expect(committed()).toBe(1);
    await tick();
    await tick();
    expect(committed()).toBe(1);
  });

  it('updates props and repaints once per set-properties call', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let seen: Readonly<Record<string, unknown>> | undefined;
    const { runtime, events } = createHarness({
      widget: (api) => ({
        render: () => {
          seen = api.props;
        },
      }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setProperties('a', { color: 'red' });
    await tick();

    expect(seen).toEqual({ color: 'red' });
    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(2);
  });

  it('merges property defaults on mount and set-properties, keeping null distinct', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const seen: Readonly<Record<string, unknown>>[] = [];
    const { runtime } = createHarness({
      widget: (api) => ({
        render: () => {
          seen.push(api.props);
        },
      }),
    });

    await runtime.load(loadRequest('widget', defaultsDefinition));
    runtime.mount(mountRequest());
    runtime.setProperties('a', { color: 'red' });
    await tick();

    expect(seen[0]).toEqual({ color: '#22AA55FF', label: null });
    expect(Object.hasOwn(seen[0] as object, 'hidden')).toBe(false);
    expect(seen[1]).toEqual({ color: 'red', label: null });
  });

  it('deep-clones and freezes defaults per instance', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const defaults = { nested: { list: [1, 2] } };
    const configurable: WidgetDefinition = {
      properties: { config: { type: 'object', default: defaults } },
      ports: {},
    };
    const seen: Record<string, unknown>[] = [];
    const { runtime } = createHarness({
      widget: (api) => {
        seen.push(api.props.config as Record<string, unknown>);
        return {};
      },
    });

    await runtime.load(loadRequest('widget', configurable));
    runtime.mount(mountRequest({ instanceId: 'a' }));
    runtime.mount(mountRequest({ instanceId: 'b' }));

    const [first, second] = seen;
    expect(first).not.toBe(second);
    expect(first).not.toBe(defaults);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.nested)).toBe(true);
    expect(Object.isFrozen((first?.nested as { list: number[] }).list)).toBe(true);
    expect(() => (first?.nested as { list: number[] }).list.push(3)).toThrow(TypeError);
    expect(defaults.nested.list).toEqual([1, 2]);
    expect((second?.nested as { list: number[] }).list).toEqual([1, 2]);
  });

  it('returns a copy of prefetched asset bytes on every read', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'a.png': new Uint8Array([1, 2, 3]) } }));

    const first = await api?.assets.readBinary('a.png');
    expect([...(first as Uint8Array)]).toEqual([1, 2, 3]);
    (first as Uint8Array)[0] = 9;

    const second = await api?.assets.readBinary('a.png');
    expect(second).not.toBe(first);
    expect([...(second as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('rejects unprefetched assets and reports each src once', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    await expect(api?.assets.readBinary('missing.png')).rejects.toThrow('not prefetched');
    await expect(api?.assets.readBinary('missing.png')).rejects.toThrow('not prefetched');
    await expect(api?.assets.readBinary('other.png')).rejects.toThrow('not prefetched');

    const failures = events
      .filter((event) => event.type === widgetAssetFailedEvent)
      .map((event) => event.payload as WidgetAssetFailedMessage);
    expect(failures.map((failure) => failure.src)).toEqual(['missing.png', 'other.png']);
    expect(failures[0]).toMatchObject({ instanceId: 'a' });
  });

  it('rebuilds the canvas and commits on resize', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.resize('a', 10, 5, 2);

    const rendered = events.filter((event) => event.type === widgetFrameEvent);
    expect(rendered).toHaveLength(2);
    expect(rendered[1]?.payload).toMatchObject({ width: 10, height: 5, dpr: 2 });
    expect(canvases[0]?.width).toBe(20);
    expect(canvases[0]?.height).toBe(10);
  });

  it('contains a factory failure to the failing instance', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({
      widget: () => {
        throw new Error('factory exploded');
      },
      other: () => ({}),
    });

    await runtime.load({
      packages: [
        {
          id: 'demo',
          modules: {
            indicator: { definition, code: 'widget' },
            second: { definition, code: 'other' },
          },
        },
      ],
    });

    expect(() => runtime.mount(mountRequest())).toThrow('factory exploded');
    expect(errors(events)).toEqual([
      { instanceId: 'a', phase: 'mount', error: { name: 'Error', message: 'factory exploded' } },
    ]);

    runtime.mount(mountRequest({ instanceId: 'b', widget: 'demo:second' }));
    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(1);
  });

  it('stops a failed instance instead of reporting the same render error repeatedly', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {
          render: () => {
            throw new Error('bad render');
          },
        };
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    api?.invalidate();
    await tick();
    api?.invalidate();
    await tick();

    expect(errors(events)).toEqual([
      { instanceId: 'a', phase: 'render', error: { name: 'Error', message: 'bad render' } },
    ]);
    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(0);
  });

  it('delivers payloads with their simulation time and isolates listener failures', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const received: { payload: unknown; simTime: number }[] = [];
    const { runtime, events } = createHarness({
      widget: (api) => {
        api.subscribe('brightness', (payload, meta) => {
          received.push({ payload, simTime: meta.simTime });
        });
        api.subscribe('brightness', () => {
          throw new Error('listener exploded');
        });
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.deliver('a', 'brightness', 0.5, 42);

    expect(received).toEqual([{ payload: 0.5, simTime: 42 }]);
    expect(errors(events)).toEqual([
      { instanceId: 'a', phase: 'deliver', error: { name: 'Error', message: 'listener exploded' } },
    ]);
  });

  it('publishes port payloads as events', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    api?.publish('value', 7);
    api?.publish('value', 8, 1280);

    expect(events.filter((event) => event.type === widgetPublishEvent)).toEqual([
      {
        type: widgetPublishEvent,
        payload: { instanceId: 'a', port: 'value', payload: 7, simTime: 0 },
        transfer: undefined,
      },
      {
        type: widgetPublishEvent,
        payload: { instanceId: 'a', port: 'value', payload: 8, simTime: 1280 },
        transfer: undefined,
      },
    ]);
  });

  it('forwards input to the instance', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const inputs: WidgetInputEvent[] = [];
    const { runtime } = createHarness({
      widget: () => ({ input: (event) => inputs.push(event) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.pointer('a', { type: 'pointerdown', x: 3, y: 4, button: 0 });

    expect(inputs).toEqual([{ type: 'pointerdown', x: 3, y: 4, button: 0 }]);
  });

  it('releases the instance on unmount', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let disposed = 0;
    const { runtime } = createHarness({
      widget: () => ({ dispose: () => (disposed += 1) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.unmount('a');

    expect(disposed).toBe(1);
    expect(canvases[0]?.width).toBe(1);
    expect(() => runtime.deliver('a', 'brightness', 1, 0)).toThrow('is not mounted');
  });

  it('loads each widget once, even when the same package is sent twice', async () => {
    const { runtime, imports } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    await runtime.load(loadRequest('widget'));

    expect(imports).toEqual(['widget']);
  });

  it('rejects when a widget module cannot be evaluated', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime } = createHarness({});

    await expect(runtime.load(loadRequest('missing'))).rejects.toThrow(
      'must default-export a factory function',
    );
    expect(() => runtime.mount(mountRequest())).toThrow('is not loaded');
  });

  it('keeps a widget module evaluated once across reset-runtime', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let evaluations = 0;
    let factoryCalls = 0;
    /** One bump closure per factory call; each closes over its own counter. */
    const bumps: (() => number)[] = [];
    const { runtime } = createHarness(
      {},
      {
        importModule: async () => {
          evaluations += 1;
          return {
            default: () => {
              factoryCalls += 1;
              // Instance state lives in the closure, so every mount starts from zero even though
              // the module itself is evaluated only once.
              let counter = 0;
              bumps.push(() => {
                counter += 1;
                return counter;
              });
              return {};
            },
          };
        },
      },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ instanceId: 'a' }));
    runtime.mount(mountRequest({ instanceId: 'b' }));
    runtime.resetRuntime();
    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ instanceId: 'a' }));

    // The factory ran again for every mount — that is what gives the fresh instance its own
    // closure — while the module source itself was evaluated exactly once.
    expect(factoryCalls).toBe(3);
    expect(evaluations).toBe(1);
    // Each instance owns an independent counter: bumping every closure returns 1, never 1/2/3.
    expect(bumps.map((bump) => bump())).toEqual([1, 1, 1]);
  });

  it('answers a repeated load from the factory cache after reset-runtime', async () => {
    const { runtime, imports } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    runtime.resetRuntime();
    await runtime.load(loadRequest('widget'));

    // Re-importing would restart module-level state, so the reset deliberately keeps the factory.
    expect(imports).toEqual(['widget']);
  });

  it('releases every session on reset-runtime, so stale subscriptions go quiet', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let received = 0;
    const disposed: string[] = [];
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        instanceApi.subscribe('brightness', () => {
          received += 1;
        });
        return { dispose: () => disposed.push(instanceApi.instanceId) };
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.deliver('a', 'brightness', 1, 0);
    expect(received).toBe(1);
    const canvas = canvases[0];
    expect(canvas?.width).toBe(40);

    runtime.resetRuntime();

    expect(disposed).toEqual(['a']);
    expect(canvas?.width).toBe(1);
    expect(canvas?.height).toBe(1);
    expect(() => runtime.deliver('a', 'brightness', 2, 0)).toThrow('is not mounted');
    expect(received).toBe(1);
    // The old api is inert: a late invalidation must not paint a released session.
    api?.invalidate();
    await tick();
    expect(canvases).toHaveLength(1);
  });

  it('keeps the runtime usable after reset-runtime', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.resetRuntime();

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    expect(events.filter((event) => event.type === widgetFrameEvent)).toHaveLength(2);
  });

  it('exposes api.audio with the state the mount carried', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });
    const worklet = createFakeWorklet();
    runtime.attachAudioPort(worklet.port);

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ audio: { state: 'running', session: 'guest-1' } }));

    expect(api?.audio.state).toBe('running');

    const tone = api?.audio.tone({ type: 'square', frequency: 440, volume: 0 });
    await flush();
    expect(worklet.callsOf('createTone')).toEqual([
      {
        member: 'createTone',
        args: ['guest-1', { voiceId: tone?.id, type: 'square', frequency: 440, volume: 0 }],
      },
    ]);

    // Unmounting the instance settles the handle; the widget never has to clean up by hand.
    runtime.unmount('a');
    await expect(tone?.ended).resolves.toEqual({ reason: 'disposed' });
    runtime.dispose();
    worklet.dispose();
  });

  it('reports audio unavailable when the mount carried no audio', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    expect(api?.audio.state).toBe('unavailable');
    const stream = api?.audio.createStream({ sampleRate: 48000 });
    await expect(stream?.write(new Float32Array(4))).resolves.toBe(false);
    await tick();
    expect(events.filter((event) => event.type.startsWith('widget:audio'))).toHaveLength(0);
    runtime.dispose();
  });
});

/** Stand-in for the device guest reachable over the direct port (RFC 0018). */
function createFakeDeviceChannel() {
  const delivered: {
    readonly target: { readonly symbol: string; readonly port: string };
    readonly payload: unknown;
    readonly simTime: number | undefined;
  }[] = [];
  const listeners = new Set<(publish: SimulationPublish) => void>();
  const channel: WidgetDeviceTopicChannel = {
    deliver: async (target, payload, simTime) => {
      delivered.push({ target, payload, simTime });
    },
    onDidPublish(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    channel,
    delivered,
    publish(publish: SimulationPublish) {
      for (const listener of [...listeners]) listener(publish);
    },
  };
}

describe('widget guest direct device channel', () => {
  it('delivers a bound publish to the device guest instead of the host', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const device = createFakeDeviceChannel();
    const { runtime, events } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      { device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { value: { symbol: 'led', port: 'input' } });
    api?.publish('value', 7, 1280);
    await tick();

    expect(device.delivered).toEqual([
      { target: { symbol: 'led', port: 'input' }, payload: 7, simTime: 1280 },
    ]);
    // The host still sees the publish, marked as already routed, so it neither forwards nor loses it.
    const publish = events.find((event) => event.type === widgetPublishEvent);
    expect(publish?.payload).toEqual({
      instanceId: 'a',
      port: 'value',
      payload: 7,
      simTime: 1280,
      direct: true,
    } satisfies WidgetPublishMessage);
  });

  it('leaves an unbound publish to the host', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const device = createFakeDeviceChannel();
    const { runtime, events } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      { device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    api?.publish('value', 7);
    await tick();

    expect(device.delivered).toEqual([]);
    const publish = events.find((event) => event.type === widgetPublishEvent);
    expect(publish?.payload).toMatchObject({ instanceId: 'a', port: 'value' });
    expect((publish?.payload as WidgetPublishMessage).direct).toBeUndefined();
  });

  it('fans device publishes out to every bound instance port', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const received: [unknown, { simTime: number }][] = [];
    const device = createFakeDeviceChannel();
    const { runtime } = createHarness(
      {
        widget: (api) => {
          api.subscribe('brightness', (payload, meta) => received.push([payload, meta]));
          return {};
        },
      },
      { device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { brightness: { symbol: 'led', port: 'anode' } });
    device.publish({ target: { symbol: 'led', port: 'anode' }, payload: 5, simTime: 10 });
    device.publish({ target: { symbol: 'led', port: 'cathode' }, payload: 6, simTime: 20 });

    expect(received).toEqual([[5, { simTime: 10 }]]);
  });

  it('forwards a bindings change before the next publish', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const device = createFakeDeviceChannel();
    const { runtime } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      { device: device.channel },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { value: { symbol: 'led', port: 'input' } });
    runtime.setBindings('a', { value: { symbol: 'relay', port: 'coil' } });
    api?.publish('value', 1);
    await tick();

    expect(device.delivered).toEqual([
      { target: { symbol: 'relay', port: 'coil' }, payload: 1, simTime: 0 },
    ]);
  });

  it('keeps routing through the host when the worker got no device port', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.setBindings('a', { value: { symbol: 'led', port: 'input' } });
    api?.publish('value', 7, 1280);

    const publish = events.find((event) => event.type === widgetPublishEvent);
    expect(publish?.payload).toEqual({
      instanceId: 'a',
      port: 'value',
      payload: 7,
      simTime: 1280,
    } satisfies WidgetPublishMessage);
  });
});
