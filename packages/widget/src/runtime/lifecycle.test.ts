import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestContext } from '@mica-js/sandbox';
import type { WidgetDefinition } from '../types';
import { WIDGET_ASSET_FAILED_EVENT, WIDGET_ERROR_EVENT, WIDGET_FRAME_EVENT } from './protocol';
import type { WidgetAssetFailedMessage, WidgetErrorMessage, WidgetFrameMessage } from './protocol';
import type { WidgetInstance, WidgetInstanceApi } from './types';
import { createWidgetRuntime } from './worker-entry';
import type { WidgetRuntime } from './worker-entry';

interface FakeBitmap {
  close(): void;
}

interface CapturedFrame {
  readonly bitmap: FakeBitmap;
  readonly width: number;
  readonly height: number;
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
    const bitmap: FakeBitmap = { close: () => {} };
    this.frames.push({ bitmap, width: this.width, height: this.height });
    return bitmap;
  }
}

/**
 * Deterministic animation clock. `advance` moves virtual time and runs exactly one scheduled
 * frame, so tick cadence tests never depend on wall-clock timing.
 */
class TestClock {
  now = 0;
  #nextHandle = 1;
  readonly #frames = new Map<number, () => void>();

  get pending(): number {
    return this.#frames.size;
  }

  readonly requestFrame = (callback: () => void): (() => void) => {
    const handle = this.#nextHandle++;
    this.#frames.set(handle, callback);
    return () => {
      this.#frames.delete(handle);
    };
  };

  advance(deltaMs: number): void {
    this.now += deltaMs;
    const next = this.#frames.entries().next();
    if (next.done) return;
    const [handle, callback] = next.value;
    this.#frames.delete(handle);
    callback();
  }

  advanceFrames(count: number, deltaMs: number): void {
    for (let index = 0; index < count; index += 1) this.advance(deltaMs);
  }
}

type Factory = (api: WidgetInstanceApi) => WidgetInstance | void;

interface HarnessOptions {
  readonly clock?: TestClock;
  readonly importModule?: (code: string) => Promise<unknown>;
  readonly createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
}

interface CapturedEvent {
  readonly type: string;
  readonly payload: unknown;
}

interface Harness {
  readonly runtime: WidgetRuntime;
  readonly clock: TestClock;
  readonly events: CapturedEvent[];
}

function createHarness(
  factories: Readonly<Record<string, Factory>>,
  options: HarnessOptions = {},
): Harness {
  const clock = options.clock ?? new TestClock();
  const events: CapturedEvent[] = [];
  const context = {
    id: 'guest-1',
    name: 'widget-lifecycle-test',
    signal: new AbortController().signal,
    handle: () => {},
    invoke: async () => undefined,
    invokeWith: async () => undefined,
    on: () => () => {},
    off: () => {},
    emit(type: string, payload?: unknown) {
      events.push({ type, payload });
    },
    log: () => {},
    createSurface: () => {
      throw new Error('the widget runtime must not create surfaces');
    },
  };

  const runtime = createWidgetRuntime(context as unknown as GuestContext, {
    importModule:
      options.importModule ??
      (async (code) => ({
        default: factories[code],
      })),
    now: () => clock.now,
    requestFrame: (callback) => clock.requestFrame(callback),
    ...(options.createImageBitmap === undefined
      ? {}
      : { createImageBitmap: options.createImageBitmap }),
  });

  return { runtime, clock, events };
}

const definition: WidgetDefinition = { properties: {}, ports: {} };

const defaultsDefinition: WidgetDefinition = {
  properties: {
    color: { type: 'color', default: '#22AA55FF' },
    label: { type: 'string', default: null },
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

function frames(events: readonly CapturedEvent[]): WidgetFrameMessage[] {
  return events
    .filter((event) => event.type === WIDGET_FRAME_EVENT)
    .map((event) => event.payload as WidgetFrameMessage);
}

function errors(events: readonly CapturedEvent[]): WidgetErrorMessage[] {
  return events
    .filter((event) => event.type === WIDGET_ERROR_EVENT)
    .map((event) => event.payload as WidgetErrorMessage);
}

function assetFailures(events: readonly CapturedEvent[]): WidgetAssetFailedMessage[] {
  return events
    .filter((event) => event.type === WIDGET_ASSET_FAILED_EVENT)
    .map((event) => event.payload as WidgetAssetFailedMessage);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
});

afterEach(() => {
  canvases.length = 0;
  vi.unstubAllGlobals();
});

describe('widget lifecycle: onPropsChanged', () => {
  it('notifies listeners after api.props already holds the merged snapshot', async () => {
    let api: WidgetInstanceApi | undefined;
    const seen: Record<string, unknown>[] = [];
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget', defaultsDefinition));
    runtime.mount(mountRequest());

    api?.onPropsChanged((props) => {
      seen.push({ ...props });
    });
    runtime.setProperties('a', { color: 'red' });

    expect(seen).toEqual([{ color: 'red', label: null }]);
    expect(api?.props).toEqual({ color: 'red', label: null });
    expect(Object.isFrozen(api?.props)).toBe(true);
  });

  it('notifies listeners serially in registration order', async () => {
    let api: WidgetInstanceApi | undefined;
    const order: string[] = [];
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    api?.onPropsChanged((props) => order.push(`first:${String(props.count)}`));
    api?.onPropsChanged((props) => order.push(`second:${String(props.count)}`));

    runtime.setProperties('a', { count: 1 });
    runtime.setProperties('a', { count: 2 });

    expect(order).toEqual(['first:1', 'second:1', 'first:2', 'second:2']);
  });

  it('stops notifying a listener after its unsubscribe function runs', async () => {
    let api: WidgetInstanceApi | undefined;
    let calls = 0;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    const unsubscribe = api?.onPropsChanged(() => {
      calls += 1;
    });
    runtime.setProperties('a', { color: 'red' });
    unsubscribe?.();
    runtime.setProperties('a', { color: 'blue' });

    expect(calls).toBe(1);
  });

  it('isolates a throwing listener, reports it, and keeps notifying the rest', async () => {
    let api: WidgetInstanceApi | undefined;
    const seen: unknown[] = [];
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    api?.onPropsChanged(() => {
      throw new Error('props listener exploded');
    });
    api?.onPropsChanged((props) => {
      seen.push(props.color);
    });

    runtime.setProperties('a', { color: 'red' });
    await flush();

    expect(seen).toEqual(['red']);
    expect(errors(events)).toEqual([
      {
        instanceId: 'a',
        phase: 'deliver',
        error: { name: 'Error', message: 'props listener exploded' },
      },
    ]);
    // The repaint still happened despite the listener failure.
    expect(frames(events)).toHaveLength(2);
  });

  it('drops listeners when the instance is released and a remount starts clean', async () => {
    let firstApi: WidgetInstanceApi | undefined;
    let firstCalls = 0;
    let mountCount = 0;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        mountCount += 1;
        if (mountCount === 1) firstApi = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    firstApi?.onPropsChanged(() => {
      firstCalls += 1;
    });

    runtime.unmount('a');
    runtime.mount(mountRequest());
    runtime.setProperties('a', { color: 'red' });

    expect(firstCalls).toBe(0);
  });
});

describe('widget lifecycle: onResize', () => {
  it('notifies listeners with the new logical size before painting', async () => {
    let api: WidgetInstanceApi | undefined;
    const seen: { width: number; height: number; apiWidth: number; apiHeight: number }[] = [];
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    api?.onResize((width, height) => {
      seen.push({ width, height, apiWidth: api?.width ?? -1, apiHeight: api?.height ?? -1 });
    });
    runtime.resize('a', 200, 100, 2);

    expect(seen).toEqual([{ width: 200, height: 100, apiWidth: 200, apiHeight: 100 }]);
    expect(frames(events)).toHaveLength(2);
    expect(frames(events)[1]).toMatchObject({ width: 200, height: 100, dpr: 2 });
    expect(canvases[0]?.width).toBe(400);
    expect(canvases[0]?.height).toBe(200);
  });

  it('notifies listeners in registration order', async () => {
    let api: WidgetInstanceApi | undefined;
    const order: string[] = [];
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    api?.onResize(() => order.push('first'));
    api?.onResize(() => order.push('second'));
    runtime.resize('a', 80, 40, 1);

    expect(order).toEqual(['first', 'second']);
  });

  it('repaints but stays quiet when only the device pixel ratio changes', async () => {
    let api: WidgetInstanceApi | undefined;
    let calls = 0;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    api?.onResize(() => {
      calls += 1;
    });

    runtime.resize('a', 40, 20, 2);

    expect(calls).toBe(0);
    expect(frames(events)).toHaveLength(2);
    expect(canvases[0]?.width).toBe(80);
    expect(canvases[0]?.height).toBe(40);
  });

  it('stops notifying after unsubscribe and keeps the repaint', async () => {
    let api: WidgetInstanceApi | undefined;
    let calls = 0;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    const unsubscribe = api?.onResize(() => {
      calls += 1;
    });
    runtime.resize('a', 60, 30, 1);
    unsubscribe?.();
    runtime.resize('a', 70, 35, 1);

    expect(calls).toBe(1);
    expect(frames(events)).toHaveLength(3);
  });

  it('isolates a throwing resize listener and still paints the new size', async () => {
    let api: WidgetInstanceApi | undefined;
    const seen: number[] = [];
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    api?.onResize(() => {
      throw new Error('resize listener exploded');
    });
    api?.onResize((width) => seen.push(width));

    runtime.resize('a', 200, 100, 1);

    expect(seen).toEqual([200]);
    expect(errors(events)).toEqual([
      {
        instanceId: 'a',
        phase: 'deliver',
        error: { name: 'Error', message: 'resize listener exploded' },
      },
    ]);
    expect(frames(events)[1]).toMatchObject({ width: 200, height: 100 });
  });

  it('drops resize listeners when the instance is released', async () => {
    let firstApi: WidgetInstanceApi | undefined;
    let firstCalls = 0;
    let mountCount = 0;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        mountCount += 1;
        if (mountCount === 1) firstApi = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    firstApi?.onResize(() => {
      firstCalls += 1;
    });

    runtime.unmount('a');
    runtime.mount(mountRequest());
    runtime.resize('a', 90, 45, 1);

    expect(firstCalls).toBe(0);
  });
});

describe('widget lifecycle: tick', () => {
  it('ticks once per animation frame with the elapsed milliseconds (~60 FPS)', async () => {
    const deltas: number[] = [];
    const { runtime, clock } = createHarness({
      widget: () => ({ tick: (deltaMs) => deltas.push(deltaMs) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    clock.advanceFrames(12, 16);

    expect(deltas).toEqual(Array.from({ length: 12 }, () => 16));
    expect(clock.pending).toBe(1);
  });

  it('does not schedule a frame loop for instances without a tick handler', async () => {
    const { runtime, clock } = createHarness({ widget: () => ({ render: () => {} }) });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    expect(clock.pending).toBe(0);
  });

  it('ticks every mounted instance in mount order', async () => {
    const order: string[] = [];
    const { runtime, clock } = createHarness({
      widget: (api) => ({ tick: () => order.push(api.instanceId) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ instanceId: 'a' }));
    runtime.mount(mountRequest({ instanceId: 'b' }));
    clock.advance(16);

    expect(order).toEqual(['a', 'b']);
  });

  it('stops ticking unmounted instances and cancels the loop when none remain', async () => {
    let ticks = 0;
    const { runtime, clock } = createHarness({
      widget: () => ({ tick: () => (ticks += 1) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    clock.advance(16);
    expect(ticks).toBe(1);

    runtime.unmount('a');
    expect(clock.pending).toBe(0);
    clock.advance(16);

    expect(ticks).toBe(1);
  });

  it('stops ticking on reset-runtime and restarts for the next mount', async () => {
    let ticks = 0;
    const { runtime, clock } = createHarness({
      widget: () => ({ tick: () => (ticks += 1) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    clock.advance(16);
    expect(ticks).toBe(1);

    runtime.resetRuntime();
    expect(clock.pending).toBe(0);
    clock.advance(16);
    expect(ticks).toBe(1);

    runtime.mount(mountRequest());
    expect(clock.pending).toBe(1);
    clock.advance(16);
    expect(ticks).toBe(2);
  });

  it('stops ticking when the runtime is disposed', async () => {
    let ticks = 0;
    const { runtime, clock } = createHarness({
      widget: () => ({ tick: () => (ticks += 1) }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    runtime.dispose();

    expect(clock.pending).toBe(0);
    clock.advance(16);
    expect(ticks).toBe(0);
  });

  it('contains a throwing tick and pauses only the failing instance', async () => {
    let secondTicks = 0;
    const { runtime, clock, events } = createHarness({
      widget: (api) => ({
        tick:
          api.instanceId === 'a'
            ? () => {
                throw new Error('tick exploded');
              }
            : () => (secondTicks += 1),
      }),
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ instanceId: 'a' }));
    runtime.mount(mountRequest({ instanceId: 'b' }));

    clock.advance(16);
    clock.advance(16);
    clock.advance(16);

    expect(secondTicks).toBe(3);
    expect(errors(events)).toEqual([
      { instanceId: 'a', phase: 'render', error: { name: 'Error', message: 'tick exploded' } },
    ]);
    expect(clock.pending).toBe(1);
  });

  it('repaints only when a tick calls invalidate', async () => {
    let api: WidgetInstanceApi | undefined;
    const { runtime, clock, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {
          render: () => {},
          tick: () => api?.invalidate(),
        };
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());
    expect(frames(events)).toHaveLength(1);

    clock.advance(16);
    await flush();
    expect(frames(events)).toHaveLength(2);

    clock.advance(16);
    await flush();
    expect(frames(events)).toHaveLength(3);
  });
});

describe('widget lifecycle: assets.loadImage', () => {
  it('decodes prefetched bytes and infers the PNG MIME type', async () => {
    let api: WidgetInstanceApi | undefined;
    const blobs: Blob[] = [];
    const bitmap = { width: 4, height: 2, close: () => {} } as unknown as ImageBitmap;
    const { runtime } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      {
        createImageBitmap: async (blob) => {
          blobs.push(blob);
          return bitmap;
        },
      },
    );
    const bytes = new Uint8Array([137, 80, 78, 71]);

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'icon.png': bytes } }));

    const loaded = await api?.assets.loadImage('icon.png');

    expect(loaded).toBe(bitmap);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('image/png');
    expect([...new Uint8Array(await (blobs[0] as Blob).arrayBuffer())]).toEqual([...bytes]);
  });

  it('infers the MIME type from PNG, JPEG, WebP and SVG extensions', async () => {
    let api: WidgetInstanceApi | undefined;
    const types: string[] = [];
    const { runtime } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      {
        createImageBitmap: async (blob) => {
          types.push(blob.type);
          return { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap;
        },
      },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(
      mountRequest({
        assets: {
          'icon.png': new Uint8Array([1]),
          'photo.jpg': new Uint8Array([2]),
          'photo.jpeg': new Uint8Array([3]),
          'anim.webp': new Uint8Array([4]),
          'vector.svg': new Uint8Array([5]),
          'data.bin': new Uint8Array([6]),
          'icon.png?v=2#fragment': new Uint8Array([7]),
        },
      }),
    );

    for (const src of [
      'icon.png',
      'photo.jpg',
      'photo.jpeg',
      'anim.webp',
      'vector.svg',
      'data.bin',
      'icon.png?v=2#fragment',
    ]) {
      await api?.assets.loadImage(src);
    }

    expect(types).toEqual([
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
      'application/octet-stream',
      'image/png',
    ]);
  });

  it('returns a fresh bitmap and buffer copy for every call', async () => {
    let api: WidgetInstanceApi | undefined;
    let decodes = 0;
    const { runtime } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      {
        createImageBitmap: async () => {
          decodes += 1;
          return { width: decodes, height: decodes, close: () => {} } as unknown as ImageBitmap;
        },
      },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'icon.png': new Uint8Array([1, 2, 3]) } }));

    const first = await api?.assets.loadImage('icon.png');
    const second = await api?.assets.loadImage('icon.png');

    expect(decodes).toBe(2);
    expect(first).not.toBe(second);
    expect((first as ImageBitmap).width).toBe(1);
    expect((second as ImageBitmap).width).toBe(2);
  });

  it('rejects missing assets and reports the failure once per src', async () => {
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    await expect(api?.assets.loadImage('missing.png')).rejects.toThrow('not prefetched');
    await expect(api?.assets.loadImage('missing.png')).rejects.toThrow('not prefetched');

    expect(assetFailures(events).map((failure) => failure.src)).toEqual(['missing.png']);
  });

  it('rejects when the image bytes cannot be decoded', async () => {
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createHarness(
      {
        widget: (instanceApi) => {
          api = instanceApi;
          return {};
        },
      },
      {
        createImageBitmap: async () => {
          throw new Error('decode failed');
        },
      },
    );

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'broken.png': new Uint8Array([0]) } }));

    await expect(api?.assets.loadImage('broken.png')).rejects.toThrow('decode failed');
  });

  it('rejects with a clear error when no image decoder exists', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    let api: WidgetInstanceApi | undefined;
    const { runtime } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest({ assets: { 'icon.png': new Uint8Array([1]) } }));

    await expect(api?.assets.loadImage('icon.png')).rejects.toThrow('createImageBitmap');
  });

  it('rejects a non-string src without touching the prefetched assets', async () => {
    let api: WidgetInstanceApi | undefined;
    const { runtime, events } = createHarness({
      widget: (instanceApi) => {
        api = instanceApi;
        return {};
      },
    });

    await runtime.load(loadRequest('widget'));
    runtime.mount(mountRequest());

    await expect(api?.assets.loadImage(42 as unknown as string)).rejects.toThrow(
      'src must be a string',
    );
    expect(assetFailures(events)).toHaveLength(0);
  });
});
