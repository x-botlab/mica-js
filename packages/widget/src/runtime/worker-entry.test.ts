import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestContext } from '@mica-js/sandbox';
import type { WidgetDefinition } from '../types';
import {
  WIDGET_ASSET_FAILED_EVENT,
  WIDGET_ERROR_EVENT,
  WIDGET_FRAME_EVENT,
  WIDGET_PUBLISH_EVENT,
} from './protocol';
import type { WidgetAssetFailedMessage, WidgetErrorMessage, WidgetFrameMessage } from './protocol';
import type { WidgetInputEvent, WidgetInstance, WidgetInstanceApi } from './types';
import { createWidgetRuntime, setup } from './worker-entry';
import type { WidgetRuntime } from './worker-entry';

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

type Factory = (api: WidgetInstanceApi) => WidgetInstance | void;

interface Harness {
  readonly runtime: WidgetRuntime;
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
  readonly events: CapturedEvent[];
  readonly context: GuestContext;
  readonly imports: string[];
}

function createHarness(factories: Readonly<Record<string, Factory>>): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: CapturedEvent[] = [];
  const imports: string[] = [];

  const context = {
    id: 'guest-1',
    name: 'widget-test',
    signal: new AbortController().signal,
    handle(name: string, handler: (...args: never[]) => unknown) {
      handlers.set(name, handler as unknown as (...args: unknown[]) => unknown);
    },
    invoke: async () => undefined,
    invokeWith: async () => undefined,
    on: () => () => {},
    off: () => {},
    emit(type: string, payload?: unknown, transfer?: readonly Transferable[]) {
      events.push({ type, payload, transfer });
    },
    log: () => {},
    createSurface: () => {
      throw new Error('the widget runtime must not create surfaces');
    },
  };

  const runtime = createWidgetRuntime(context as unknown as GuestContext, {
    importModule: async (code) => {
      imports.push(code);
      return { default: factories[code] };
    },
  });

  return { runtime, handlers, events, context: context as unknown as GuestContext, imports };
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
    .filter((event) => event.type === WIDGET_ERROR_EVENT)
    .map((event) => event.payload as WidgetErrorMessage);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  canvases.length = 0;
  vi.unstubAllGlobals();
});

describe('widget guest runtime', () => {
  it('exposes every host method through the guest context', () => {
    const { handlers, context } = createHarness({});

    setup(context);

    expect([...handlers.keys()]).toEqual([
      'load',
      'mount',
      'unmount',
      'resize',
      'set-properties',
      'deliver',
      'pointer',
    ]);
  });

  it('renders and transfers one frame on mount, scaled by the device pixel ratio', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({}) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ dpr: 2 }));

    const frames = events.filter((event) => event.type === WIDGET_FRAME_EVENT);
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
    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(1);

    api?.invalidate();
    api?.invalidate();
    api?.invalidate();
    await tick();

    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(2);
  });

  it('keeps a static instance from producing frames until it is invalidated', async () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const { runtime, events } = createHarness({ widget: () => ({ render: () => {} }) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    await tick();
    await tick();

    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(1);
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
      events.filter((event) => event.type === WIDGET_FRAME_EVENT).length;

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
    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(2);
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
      .filter((event) => event.type === WIDGET_ASSET_FAILED_EVENT)
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

    const rendered = events.filter((event) => event.type === WIDGET_FRAME_EVENT);
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
    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(1);
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
    expect(events.filter((event) => event.type === WIDGET_FRAME_EVENT)).toHaveLength(0);
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

    expect(events.filter((event) => event.type === WIDGET_PUBLISH_EVENT)).toEqual([
      {
        type: WIDGET_PUBLISH_EVENT,
        payload: { instanceId: 'a', port: 'value', payload: 7, simTime: 0 },
        transfer: undefined,
      },
      {
        type: WIDGET_PUBLISH_EVENT,
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
});
