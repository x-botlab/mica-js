import type {
  CanvasBindingCatalog,
  CanvasBindingTarget,
  CanvasDocument,
  CanvasWidgetInstance,
} from '@mica-js/core/canvas';
import { SchematicError } from '@mica-js/core/canvas';
import type { SchematicDocument } from '@mica-js/core/schematic';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import { describe, expect, it } from 'vitest';
import { HostFsError } from '../host-fs/errors';
import type { HostFs } from '../host-fs/types';
import { createStaticWidgetProvider } from '../package/static-provider';
import {
  widgetDeliverMethod,
  widgetFrameEvent,
  widgetPointerMethod,
  widgetPublishEvent,
  widgetSetBindingsMethod,
} from '../guest/widget/protocol';
import type { WidgetInputEvent } from '../guest/widget/types';
import type { WidgetModule } from '../types';
import type { DeviceSimulationHost, DeviceTopic, SimulationPublish } from '@mica-js/simulator';
import { createWidgetHost } from './widget-host';
import type {
  Widget,
  WidgetDiagnostic,
  WidgetPublish,
  WidgetSandbox,
  WidgetHostMode,
} from './types';

interface FakeBitmap {
  readonly instanceId: string;
  closed: boolean;
  close(): void;
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Minimal sandbox: records calls, lets a test emit guest events. */
class FakeSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  /** Set by a test that models a guest holding the direct device channel (RFC 0018). */
  directDevice = false;
  readonly calls: RecordedCall[] = [];
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

  call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    return Promise.resolve(undefined);
  }

  on(type: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      this.#listeners.get(type)?.delete(listener);
    };
  }

  terminate(): Promise<void> {
    this.state = 'terminated';
    return Promise.resolve();
  }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(payload);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  callsOf(method: string): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }
}

/** Manual frame scheduler: a test decides when a frame happens. */
class ManualFrames {
  #callbacks: (() => void)[] = [];

  readonly request = (callback: () => void): (() => void) => {
    this.#callbacks.push(callback);
    return () => {
      this.#callbacks = this.#callbacks.filter((pending) => pending !== callback);
    };
  };

  get pending(): number {
    return this.#callbacks.length;
  }

  /** Runs the scheduled frame (at most one is pending) and drains what it started. */
  async run(): Promise<void> {
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    for (const callback of callbacks) callback();
    await flush();
  }
}

/** Stand-in for `DeviceSimulationHost`: records steps, publishes on demand. */
class FakeDeviceHost implements DeviceSimulationHost {
  readonly schematics: (string | undefined)[] = [];
  readonly ticks: number[] = [];
  readonly delivered: {
    readonly target: CanvasBindingTarget;
    readonly payload: unknown;
    readonly simTime?: number;
  }[] = [];
  /** Endpoints the running devices report; a test sets them per schematic. */
  topics: readonly DeviceTopic[] = [];
  /** Schematic document the runtime runs, used for symbol presence. */
  schematic: SchematicDocument | undefined;
  /** Methods in arrival order, to check `loadSchematic` precedes the catalog read. */
  readonly calls: string[] = [];
  loadError: Error | undefined;
  simTime = 0;
  readonly #publishes = new Emitter<SimulationPublish>();
  readonly onDidPublish: Event<SimulationPublish> = this.#publishes.event;

  async loadSchematic(uri: string | undefined): Promise<void> {
    this.calls.push('loadSchematic');
    const failure = this.loadError;
    this.loadError = undefined;
    if (failure !== undefined) throw failure;
    this.schematics.push(uri);
    this.simTime = 0;
  }

  async reset(): Promise<void> {
    this.calls.push('reset');
    this.simTime = 0;
  }

  async tick(dt: number): Promise<{ readonly simTime: number; readonly executed: number }> {
    this.ticks.push(dt);
    this.simTime += dt;
    return { simTime: this.simTime, executed: 1 };
  }

  async deliver(target: CanvasBindingTarget, payload: unknown, simTime?: number): Promise<void> {
    this.delivered.push({
      target,
      payload,
      ...(simTime === undefined ? {} : { simTime }),
    });
  }

  publish(publish: SimulationPublish): void {
    this.#publishes.fire(publish);
  }

  get hasListeners(): boolean {
    return this.#publishes.hasListeners;
  }

  async getTopics(): Promise<readonly DeviceTopic[]> {
    this.calls.push('getTopics');
    return this.topics;
  }

  async getSimTime(): Promise<number> {
    return this.simTime;
  }

  async getSchematic(): Promise<SchematicDocument | undefined> {
    this.calls.push('getSchematic');
    return this.schematic;
  }

  async dispose(): Promise<void> {
    // The caller owns the runtime; the host only unsubscribes.
  }
}

const demoModule: WidgetModule = {
  definition: {
    properties: {
      color: { type: 'color', default: '#22AA55FF' },
    },
    ports: { value: { direction: 'input', type: 'number' } },
  },
  code: 'export default () => ({});',
};

const provider = createStaticWidgetProvider({ 'demo:indicator': demoModule });

/** Valid UUID v4 ids, because the `.cnv` parser rejects anything else. */
const ID_A = '0f1d5a70-0000-4000-8000-00000000000a';
const ID_B = '0f1d5a70-0000-4000-8000-00000000000b';

function instance(
  overrides: Partial<CanvasWidgetInstance> & { readonly id: string },
): CanvasWidgetInstance {
  return {
    widget: 'demo:indicator',
    x: 0,
    y: 0,
    width: 20,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

function canvas(...widgets: readonly CanvasWidgetInstance[]): CanvasDocument {
  return { version: 1, widgets };
}

function createBitmap(instanceId: string): ImageBitmap {
  const bitmap: FakeBitmap = {
    instanceId,
    closed: false,
    close: () => {
      bitmap.closed = true;
    },
  };
  return bitmap as unknown as ImageBitmap;
}

interface HarnessOptions {
  readonly sandbox?: FakeSandbox;
  readonly deviceHost?: FakeDeviceHost;
  readonly frame?: ManualFrames;
  readonly fs?: HostFs;
  readonly module?: WidgetModule;
  readonly catalog?: CanvasBindingCatalog;
  readonly mode?: WidgetHostMode;
}

interface Harness {
  readonly host: ReturnType<typeof createWidgetHost>;
  readonly sandbox: FakeSandbox;
  readonly deviceHost: FakeDeviceHost;
  readonly frames: ManualFrames;
  readonly adds: Widget[];
  readonly changes: Widget[];
  readonly removals: string[];
  readonly orders: (readonly string[])[];
  readonly diagnostics: WidgetDiagnostic[];
  readonly publishes: WidgetPublish[];
}

/** Uses the RFC 0018 option names and subscribes to the four widget events. */
function createHarness(options: HarnessOptions = {}): Harness {
  const sandbox = options.sandbox ?? new FakeSandbox();
  const deviceHost = options.deviceHost ?? new FakeDeviceHost();
  const frames = options.frame ?? new ManualFrames();
  const adds: Widget[] = [];
  const changes: Widget[] = [];
  const removals: string[] = [];
  const orders: (readonly string[])[] = [];
  const diagnostics: WidgetDiagnostic[] = [];
  const publishes: WidgetPublish[] = [];

  const host = createWidgetHost(
    {
      widgetProvider:
        options.module === undefined
          ? provider
          : createStaticWidgetProvider({ 'demo:indicator': options.module }),
      deviceHost,
      frame: {
        requestFrame: frames.request,
        stepMs: 0.000001,
      },
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      onDidReportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onDidPublish: (publish) => publishes.push(publish),
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    },
    async () => sandbox,
  );
  host.onDidAddWidget((widget) => adds.push(widget));
  host.onDidChangeWidget((widget) => changes.push(widget));
  host.onDidRemoveWidget((instanceId) => removals.push(instanceId));
  host.onDidReorderWidgets((order) => orders.push(order));

  return {
    host,
    sandbox,
    deviceHost,
    frames,
    adds,
    changes,
    removals,
    orders,
    diagnostics,
    publishes,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lets the coordination queue drain: every guest call settles in a microtask. */
async function flush(): Promise<void> {
  await tick();
  await tick();
}

function createMemoryHostFs(entries: Readonly<Record<string, string>> = {}): HostFs {
  const encoder = new TextEncoder();
  return {
    async read(uri) {
      const entry = entries[uri];
      if (entry === undefined) throw new HostFsError('FileNotFound', uri);
      return encoder.encode(entry);
    },
  };
}

function emitFrame(sandbox: FakeSandbox, instanceId: string, bitmap: ImageBitmap): void {
  sandbox.emit(widgetFrameEvent, { instanceId, bitmap });
}

/**
 * Catalog whose schematic facts only exist once the device host loaded them, like a production
 * catalog over the running schematic: validating before `loadSchematic` sees an unknown schematic.
 */
function createSchematicCatalog(deviceHost: FakeDeviceHost): CanvasBindingCatalog {
  return {
    widgetDefinition: () => ({
      ports: { value: { direction: 'input', type: 'number' } },
      propertyKeys: ['color'],
    }),
    hasSchematic: (path) => deviceHost.schematics.includes(path),
    hasSymbol: (symbolId) => symbolId === 'U1',
    symbolPort: () => ({ direction: 'output', type: 'number' }),
  };
}

describe('widget instance projection (RFC 0018)', () => {
  it('lists instances in drawing order without bitmaps', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(
      canvas(
        instance({ id: ID_A, x: 4, y: 6, width: 30, height: 12, rotation: 90 }),
        instance({
          id: ID_B,
          properties: { color: '#ff0000ff' },
          bindings: { value: { symbol: 'U1', port: 'level' } },
        }),
      ),
    );

    const listed = harness.host.listInstances();
    expect(listed.map((entry) => entry.instanceId)).toEqual([ID_A, ID_B]);
    expect(listed[0]).toMatchObject({
      widget: 'demo:indicator',
      x: 4,
      y: 6,
      width: 30,
      height: 12,
      rotation: 90,
      dpr: 1,
      sequence: 0,
    });
    expect(listed[1]?.properties).toEqual({ color: '#ff0000ff' });
    expect(listed[1]?.bindings).toEqual({ value: { symbol: 'U1', port: 'level' } });
    expect('bitmap' in (listed[0] as object)).toBe(false);
  });

  it('reports a mounted instance once with its complete state', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, properties: { color: '#00ff00ff' } })),
    );

    expect(harness.adds).toHaveLength(1);
    expect(harness.adds[0]).toMatchObject({
      instanceId: ID_A,
      widget: 'demo:indicator',
      width: 20,
      height: 10,
      rotation: 0,
      dpr: 1,
      properties: { color: '#00ff00ff' },
      sequence: 0,
    });
    expect(harness.adds[0]?.bitmap).toBeUndefined();
  });

  it('reports a new bitmap through the change event and bumps the sequence', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    const bitmap = createBitmap(ID_A);
    emitFrame(harness.sandbox, ID_A, bitmap);

    expect(harness.changes).toHaveLength(1);
    expect(harness.changes[0]?.bitmap).toBe(bitmap);
    expect(harness.changes[0]?.sequence).toBe(1);
    expect(harness.host.listInstances()[0]?.sequence).toBe(1);
  });

  it('reports geometry and property changes through the change event', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.applyCommand({
      type: 'set-placement',
      instanceId: ID_A,
      placement: { x: 11, y: 12, width: 21, height: 22, rotation: 45 },
    });
    await flush();

    expect(harness.changes.at(-1)).toMatchObject({
      instanceId: ID_A,
      x: 11,
      y: 12,
      width: 21,
      height: 22,
      rotation: 45,
    });
    // Only the size change reaches the guest.
    expect(harness.sandbox.callsOf('resize')).toHaveLength(1);

    harness.host.applyCommand({
      type: 'set-property',
      instanceId: ID_A,
      key: 'color',
      value: '#123456ff',
    });
    await flush();

    expect(harness.changes.at(-1)?.properties).toEqual({ color: '#123456ff' });
    expect(harness.sandbox.callsOf('set-properties')).toHaveLength(1);
  });

  it('reports the new pixel ratio for every instance on resize', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    harness.host.resize(2);

    expect(harness.host.listInstances().map((entry) => entry.dpr)).toEqual([2, 2]);
    expect(harness.changes.map((widget) => widget.dpr)).toEqual([2, 2]);
  });

  it('reports removals and reorders', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    harness.host.applyCommand({ type: 'set-z', instanceId: ID_B, z: 0 });
    await flush();

    expect(harness.orders.at(-1)).toEqual([ID_B, ID_A]);
    expect(harness.host.listInstances().map((entry) => entry.instanceId)).toEqual([ID_B, ID_A]);

    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });
    await flush();

    expect(harness.removals).toEqual([ID_A]);
    expect(harness.host.listInstances().map((entry) => entry.instanceId)).toEqual([ID_B]);
  });

  it('invalidate reports every instance as removed and then added again', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));
    const bitmap = createBitmap(ID_A);
    emitFrame(harness.sandbox, ID_A, bitmap);

    harness.host.invalidate();

    expect(harness.removals).toEqual([ID_A, ID_B]);
    expect(harness.adds.map((widget) => widget.instanceId)).toEqual([ID_A, ID_B, ID_A, ID_B]);
    expect(harness.adds.at(-2)?.bitmap).toBe(bitmap);
    // A full sync rebuilds the composite, it does not restart the widgets.
    expect(harness.sandbox.callsOf('mount')).toHaveLength(2);
    expect(harness.sandbox.callsOf('unmount')).toHaveLength(0);
  });

  it('empties the projection on reset and repopulates it from the current document', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    const pass = harness.host.reset();
    expect(harness.host.listInstances()).toEqual([]);
    await pass;

    expect(harness.host.listInstances().map((entry) => entry.instanceId)).toEqual([ID_A]);
    expect(harness.removals).toEqual([ID_A]);
    expect(harness.adds.map((widget) => widget.instanceId)).toEqual([ID_A, ID_A]);
  });
});

describe('frame clock (RFC 0018)', () => {
  it('advances one fixed step per frame after the document loaded', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    expect(harness.frames.pending).toBe(1);

    await harness.frames.run();

    expect(harness.deviceHost.ticks).toEqual([1_000]);
    expect(harness.frames.pending).toBe(1);
  });

  it('does not advance while paused and re-times on resume', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.pause();
    expect(harness.frames.pending).toBe(0);
    await harness.host.resume();
    expect(harness.frames.pending).toBe(1);

    await harness.frames.run();
    expect(harness.deviceHost.ticks).toEqual([1_000]);
  });

  it('stops the clock and unsubscribes on dispose', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    await harness.host.dispose();

    expect(harness.frames.pending).toBe(0);
    expect(harness.deviceHost.hasListeners).toBe(false);
  });

  it('dispatches queued input at the next step start', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const event: WidgetInputEvent = { type: 'pointerdown', x: 1, y: 2 };

    harness.host.dispatch(ID_A, event);
    expect(harness.sandbox.callsOf(widgetPointerMethod)).toHaveLength(0);

    await harness.frames.run();

    expect(harness.sandbox.callsOf(widgetPointerMethod)[0]).toEqual([ID_A, event]);
  });
});

describe('schematic wiring (RFC 0018)', () => {
  it('resolves the document schematic against the canvas URI', async () => {
    const harness = createHarness({
      fs: createMemoryHostFs({
        'file:///work/canvas.cnv': JSON.stringify({
          version: 1,
          schematic: 'boards/main.sch',
          widgets: [instance({ id: ID_A })],
        }),
      }),
    });

    await harness.host.loadDocument('file:///work/canvas.cnv');

    expect(harness.deviceHost.schematics).toEqual(['file:///work/boards/main.sch']);
  });

  it('clears the runtime when the document has no schematic', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    expect(harness.deviceHost.schematics).toEqual([undefined]);
  });

  it('rejects the load and keeps the previous state when the schematic fails', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    harness.deviceHost.loadError = new Error('bad schematic');

    await expect(
      harness.host.loadDocument({ version: 1, schematic: 'file:///work/broken.sch', widgets: [] }),
    ).rejects.toThrow('bad schematic');

    expect(harness.host.listInstances().map((entry) => entry.instanceId)).toEqual([ID_A]);
    expect(harness.removals).toEqual([]);
  });

  it('validates bindings only after the schematic loaded', async () => {
    const deviceHost = new FakeDeviceHost();
    const harness = createHarness({ deviceHost, catalog: createSchematicCatalog(deviceHost) });

    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })],
    });

    expect(deviceHost.schematics).toEqual(['file:///work/main.sch']);
    expect(harness.diagnostics).toEqual([]);
    expect(harness.sandbox.callsOf('mount')).toHaveLength(1);
  });

  it('keeps the previous document and instances when bindings fail after the schematic load', async () => {
    const deviceHost = new FakeDeviceHost();
    const harness = createHarness({ deviceHost, catalog: createSchematicCatalog(deviceHost) });
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const before = harness.host.getDocument();

    await expect(
      harness.host.loadDocument({
        version: 1,
        schematic: 'file:///work/next.sch',
        widgets: [instance({ id: ID_B, properties: { unknown: 1 } })],
      }),
    ).rejects.toBeInstanceOf(SchematicError);

    expect(deviceHost.schematics).toEqual([undefined, 'file:///work/next.sch']);
    expect(harness.host.getDocument()).toBe(before);
    expect(harness.host.listInstances().map((entry) => entry.instanceId)).toEqual([ID_A]);
    expect(harness.removals).toEqual([]);
  });

  it('loads the schematic in edit mode and only advances it in simulation mode', async () => {
    const harness = createHarness({ mode: 'edit' });
    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [],
    });

    expect(harness.deviceHost.schematics).toEqual(['file:///work/main.sch']);
    expect(harness.frames.pending).toBe(0);
    await harness.frames.run();
    expect(harness.deviceHost.ticks).toEqual([]);

    await harness.host.setMode('simulation');
    expect(harness.deviceHost.schematics).toEqual(['file:///work/main.sch']);
    expect(harness.deviceHost.calls).toContain('reset');
    expect(harness.frames.pending).toBe(1);
    await harness.frames.run();
    expect(harness.deviceHost.ticks).toEqual([1_000]);

    await harness.host.setMode('edit');
    expect(harness.deviceHost.schematics).toEqual(['file:///work/main.sch']);
    expect(harness.frames.pending).toBe(0);
    await harness.frames.run();
    expect(harness.deviceHost.ticks).toEqual([1_000]);
  });

  it('reloads the schematic on reset', async () => {
    const harness = createHarness();
    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [],
    });

    await harness.host.reset();

    expect(harness.deviceHost.schematics).toEqual([
      'file:///work/main.sch',
      'file:///work/main.sch',
    ]);
  });

  it('reads widget property resources through fs against the canvas URI', async () => {
    const textureModule: WidgetModule = {
      definition: {
        properties: {
          texture: { type: 'image', default: { src: 'img/default.png', mode: 'file' } },
          icon: { type: 'image' },
        },
        ports: {},
      },
      code: 'export default () => ({});',
    };
    const harness = createHarness({
      module: textureModule,
      fs: createMemoryHostFs({
        'file:///work/main.cnv': JSON.stringify({
          version: 1,
          widgets: [
            instance({
              id: ID_A,
              properties: {
                texture: { src: 'img/tex.png', mode: 'file' },
                icon: { src: 'aWNvbg==', mode: 'inline' },
              },
            }),
          ],
        }),
        'file:///work/img/tex.png': 'PNG-bytes',
      }),
    });

    await harness.host.loadDocument('file:///work/main.cnv');

    const mount = harness.sandbox.callsOf('mount')[0]?.[0] as
      { assets?: Record<string, Uint8Array> } | undefined;
    expect(Object.keys(mount?.assets ?? {}).sort()).toEqual(['aWNvbg==', 'img/tex.png']);
    expect(new TextDecoder().decode(mount?.assets?.['img/tex.png'])).toBe('PNG-bytes');
    // `inline` carries base64, so it never reaches fs.
    expect(new TextDecoder().decode(mount?.assets?.['aWNvbg=='])).toBe('icon');
  });
});

/** Minimal `.sch` carrying the given symbol ids; only symbol presence matters here. */
function schematicWith(...symbolIds: readonly string[]): SchematicDocument {
  return {
    version: 1,
    sheet: {
      symbols: symbolIds.map((id) => ({ id, device: 'demo:led', x: 0, y: 0, rotation: 0 })),
      wires: [],
      junctions: [],
    },
  };
}

function deviceTopic(
  symbol: string,
  port: string,
  overrides: Partial<DeviceTopic> = {},
): DeviceTopic {
  return { symbol, port, direction: 'output', type: 'number', ...overrides };
}

describe('automatic binding catalog (RFC 0018)', () => {
  it('assembles the catalog from the loaded schematic and the provider', async () => {
    const harness = createHarness();
    harness.deviceHost.schematic = schematicWith('U1');
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];

    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })],
    });

    // The endpoint list describes the runtime the document was just loaded into.
    expect(harness.deviceHost.calls[0]).toBe('loadSchematic');
    expect(harness.deviceHost.calls).toEqual(expect.arrayContaining(['getTopics', 'getSchematic']));
    expect(harness.diagnostics).toEqual([]);
    expect(harness.sandbox.callsOf('mount')).toHaveLength(1);
  });

  it('skips only instances whose schematic symbol has no endpoint', async () => {
    const harness = createHarness();
    harness.deviceHost.schematic = schematicWith('U1', 'U2');
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];

    // `U2` exists in the schematic but has no matching endpoint; the valid instance still mounts.
    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [
        instance({ id: ID_A, bindings: { value: { symbol: 'U2', port: 'level' } } }),
        instance({ id: ID_B, bindings: { value: { symbol: 'U1', port: 'level' } } }),
      ],
    });

    expect(harness.sandbox.callsOf('mount')).toHaveLength(1);
    expect(harness.sandbox.callsOf('mount')[0]?.[0]).toMatchObject({ instanceId: ID_B });
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'widget/binding-failed',
        instanceId: ID_A,
        bindingCode: 'canvas/unknown-target-port',
        pointer: '/widgets/0/bindings/value/port',
      }),
    );
  });

  it('skips a binding to a symbol the running schematic does not have', async () => {
    const harness = createHarness();
    harness.deviceHost.schematic = schematicWith('U1');
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];

    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A, bindings: { value: { symbol: 'U9', port: 'level' } } })],
    });

    expect(harness.host.getDocument().widgets).toHaveLength(1);
    expect(harness.sandbox.callsOf('mount')).toEqual([]);
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({ instanceId: ID_A, bindingCode: 'canvas/unknown-symbol' }),
    );
  });

  it('skips a binding to a port the device endpoint does not declare', async () => {
    const harness = createHarness();
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];

    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'missing' } } })],
    });

    expect(harness.sandbox.callsOf('mount')).toEqual([]);
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({ instanceId: ID_A, bindingCode: 'canvas/unknown-target-port' }),
    );
  });

  it('skips a binding whose sides disagree on direction and payload type', async () => {
    const harness = createHarness();
    harness.deviceHost.topics = [
      deviceTopic('U1', 'level', { direction: 'input', type: 'string' }),
    ];

    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })],
    });

    expect(harness.sandbox.callsOf('mount')).toEqual([]);
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({ instanceId: ID_A, bindingCode: 'topic/type-mismatch' }),
    );
  });

  it('checks widget ports and properties against the provider definition', async () => {
    const harness = createHarness();

    await expect(
      harness.host.loadDocument(
        canvas(
          instance({
            id: ID_A,
            properties: { width: 1 },
            bindings: { pressed: { symbol: 'U1', port: 'level' } },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'canvas/unknown-property' }),
        expect.objectContaining({ code: 'canvas/unknown-port' }),
      ],
    });
  });

  it('keeps a widget the provider does not know a mount-time diagnostic', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, widget: 'demo:missing', properties: { unknown: 1 } })),
    );

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/unknown-widget', widget: 'demo:missing' }),
    ]);
    expect(harness.host.getLayers().list()).toEqual([]);
  });

  it('skips an instance when a command introduces a binding error', async () => {
    const harness = createHarness();
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];
    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A })],
    });
    const beforeMounts = harness.sandbox.callsOf('mount').length;

    expect(() =>
      harness.host.applyCommand({
        type: 'set-binding',
        instanceId: ID_A,
        port: 'value',
        target: { symbol: 'U9', port: 'level' },
      }),
    ).not.toThrow();
    await flush();

    expect(harness.host.getDocument().widgets[0]?.bindings).toEqual({
      value: { symbol: 'U9', port: 'level' },
    });
    expect(harness.sandbox.callsOf('unmount')).toHaveLength(1);
    expect(harness.sandbox.callsOf('mount')).toHaveLength(beforeMounts);
    expect(harness.diagnostics).toContainEqual(
      expect.objectContaining({ instanceId: ID_A, bindingCode: 'canvas/unknown-symbol' }),
    );

    harness.host.applyCommand({
      type: 'set-binding',
      instanceId: ID_A,
      port: 'value',
      target: { symbol: 'U1', port: 'level' },
    });
    await flush();

    expect(harness.sandbox.callsOf('mount')).toHaveLength(beforeMounts + 1);
    expect(harness.host.getDocument().widgets[0]?.bindings).toEqual({
      value: { symbol: 'U1', port: 'level' },
    });
  });

  it('re-reads the endpoints when reset reloads the schematic', async () => {
    const harness = createHarness();
    harness.deviceHost.topics = [deviceTopic('U1', 'level')];
    await harness.host.loadDocument({
      version: 1,
      schematic: 'file:///work/main.sch',
      widgets: [instance({ id: ID_A })],
    });

    harness.deviceHost.topics = [deviceTopic('U2', 'level')];
    await harness.host.reset();

    expect(() =>
      harness.host.applyCommand({
        type: 'set-binding',
        instanceId: ID_A,
        port: 'value',
        target: { symbol: 'U2', port: 'level' },
      }),
    ).not.toThrow();
  });

  it('lets an explicit catalog replace the assembled one', async () => {
    const deviceHost = new FakeDeviceHost();
    const catalog: CanvasBindingCatalog = {
      widgetDefinition: () => undefined,
      hasSchematic: () => false,
      hasSymbol: () => false,
      symbolPort: () => undefined,
    };
    const harness = createHarness({ deviceHost, catalog });

    await expect(harness.host.loadDocument(canvas(instance({ id: ID_A })))).rejects.toMatchObject({
      code: 'canvas/unknown-widget',
    });
    // The explicit catalog is the only source, so nothing is assembled behind it.
    expect(deviceHost.calls).toEqual(['loadSchematic']);
  });
});

describe('topic routing with a device host (RFC 0018)', () => {
  it('forwards a bound widget publish to the device endpoint', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })),
    );

    harness.sandbox.emit(widgetPublishEvent, { instanceId: ID_A, port: 'value', payload: 0.5 });
    await flush();

    expect(harness.deviceHost.delivered).toEqual([
      { target: { symbol: 'U1', port: 'level' }, payload: 0.5, simTime: 0 },
    ]);
  });

  it('stamps an unbound publish with the simulation time and keeps it host-local', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    await harness.frames.run();

    harness.sandbox.emit(widgetPublishEvent, { instanceId: ID_A, port: 'value', payload: 1 });
    await flush();

    expect(harness.deviceHost.delivered).toEqual([]);
    expect(harness.publishes).toHaveLength(1);
    expect(harness.publishes[0]?.simTime).toBe(1_000);
  });

  it('delivers a device publish to every widget bound to the endpoint', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(
      canvas(
        instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } }),
        instance({ id: ID_B }),
      ),
    );

    harness.deviceHost.publish({
      target: { symbol: 'U1', port: 'level' },
      payload: 7,
      simTime: 1_000,
    });
    await flush();

    expect(harness.sandbox.callsOf(widgetDeliverMethod)).toEqual([[ID_A, 'value', 7, 1_000]]);
  });

  it('seeds a widget that mounts after the publish with the level already published', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    // A level topic only publishes on change, so this value is what the endpoint carries now.
    harness.deviceHost.publish({
      target: { symbol: 'U1', port: 'level' },
      payload: 7,
      simTime: 1_000,
    });
    await flush();

    harness.host.applyCommand({
      type: 'add-instance',
      instance: instance({ id: ID_B, bindings: { value: { symbol: 'U1', port: 'level' } } }),
      z: 1,
    });
    await flush();

    expect(harness.sandbox.callsOf(widgetDeliverMethod)).toEqual([[ID_B, 'value', 7, 1_000]]);
  });
});

describe('direct device channel (RFC 0018)', () => {
  it('hands the device port to the first sandbox it starts', async () => {
    const sandbox = new FakeSandbox();
    const devicePort = { close() {} } as unknown as MessagePort;
    const handedOver: (MessagePort | undefined)[] = [];
    const host = createWidgetHost(
      {
        widgetProvider: provider,
        deviceHost: new FakeDeviceHost(),
        devicePort,
        frame: { requestFrame: () => () => {}, stepMs: 0.000001 },
      },
      async (options) => {
        handedOver.push(options.devicePort);
        return sandbox;
      },
    );

    await host.loadDocument(canvas(instance({ id: ID_A })));

    // A port can be transferred once, so only the first sandbox receives it.
    expect(handedOver).toEqual([devicePort]);
    await host.dispose();
  });

  it('sends the binding map to a guest that routes topic traffic', async () => {
    const harness = createHarness();
    harness.sandbox.directDevice = true;
    const binding: CanvasBindingTarget = { symbol: 'U1', port: 'level' };

    await harness.host.loadDocument(canvas(instance({ id: ID_A, bindings: { value: binding } })));

    expect(harness.sandbox.callsOf(widgetSetBindingsMethod)).toEqual([[ID_A, { value: binding }]]);

    harness.host.applyCommand({
      type: 'set-binding',
      instanceId: ID_A,
      port: 'value',
      target: { symbol: 'U2', port: 'out' },
    });
    await flush();

    expect(harness.sandbox.callsOf(widgetSetBindingsMethod).at(-1)).toEqual([
      ID_A,
      { value: { symbol: 'U2', port: 'out' } },
    ]);
  });

  it('keeps the binding map host-side for a guest without the channel', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })),
    );

    expect(harness.sandbox.callsOf(widgetSetBindingsMethod)).toEqual([]);
  });

  it('does not forward a publish the guest already delivered', async () => {
    const harness = createHarness();
    harness.sandbox.directDevice = true;
    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })),
    );

    harness.sandbox.emit(widgetPublishEvent, {
      instanceId: ID_A,
      port: 'value',
      payload: 0.5,
      simTime: 0,
      direct: true,
    });
    await flush();

    expect(harness.deviceHost.delivered).toEqual([]);
    // The host still hears about it, so a listener sees every publish exactly once.
    expect(harness.publishes).toHaveLength(1);
  });

  it('leaves device publishes to the guest and still seeds a later mount', async () => {
    const harness = createHarness();
    harness.sandbox.directDevice = true;
    await harness.host.loadDocument(
      canvas(instance({ id: ID_A, bindings: { value: { symbol: 'U1', port: 'level' } } })),
    );

    harness.deviceHost.publish({
      target: { symbol: 'U1', port: 'level' },
      payload: 7,
      simTime: 1_000,
    });
    await flush();

    // The guest fans this out itself; a second delivery from the host would duplicate it.
    expect(harness.sandbox.callsOf(widgetDeliverMethod)).toEqual([]);

    harness.host.applyCommand({
      type: 'add-instance',
      instance: instance({ id: ID_B, bindings: { value: { symbol: 'U1', port: 'level' } } }),
      z: 1,
    });
    await flush();

    // Seeding stays host-side: the instance mounted after the publish gets the level once.
    expect(harness.sandbox.callsOf(widgetDeliverMethod)).toEqual([[ID_B, 'value', 7, 1_000]]);
  });
});

describe('options (RFC 0018)', () => {
  it('requires a widget provider', () => {
    expect(() => createWidgetHost({} as never, async () => new FakeSandbox())).toThrow(TypeError);
  });
});
