import { SchematicError } from '@mica-js/core/canvas';
import type {
  CanvasBindingCatalog,
  CanvasCommand,
  CanvasDocument,
  CanvasWidgetInstance,
} from '@mica-js/core/canvas';
import { describe, expect, it } from 'vitest';
import { createStaticWidgetProvider } from '../provider/static';
import { WIDGET_ERROR_EVENT, WIDGET_FRAME_EVENT, WIDGET_PUBLISH_EVENT } from '../runtime/protocol';
import type { WidgetAssetRef } from '../runtime/types';
import type { WidgetModule } from '../types';
import { createWidgetHost } from './create-widget-host';
import type {
  WidgetAssetProvider,
  WidgetDiagnostic,
  WidgetLayerChange,
  WidgetPublish,
  WidgetSandbox,
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

class FakeSandbox implements WidgetSandbox {
  state: 'ready' | 'terminated' = 'ready';
  readonly calls: RecordedCall[] = [];
  readonly reasons: string[] = [];
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #failures = new Map<string, Error[]>();
  readonly #gates = new Map<string, Promise<void>>();
  /** Mirrors the guest instance table, so a second `mount` of one id fails like the real guest. */
  readonly #sessions = new Set<string>();

  fail(method: string, error: Error): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  /** Holds the next call of `method` open; the returned function releases it. */
  gate(method: string): () => void {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gates.set(method, pending);
    return release;
  }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method)?.shift();
    if (failure) return Promise.reject(failure);

    const gate = this.#gates.get(method);
    if (gate !== undefined) this.#gates.delete(method);
    // The guest touches its session table when the call runs, not when the host asks for it: a
    // gated `mount` must not look like a live session while the host is still waiting for it.
    return (gate ?? Promise.resolve()).then(() => {
      const guestError = this.#applyGuestState(method, args);
      if (guestError !== undefined) throw guestError;
      return undefined;
    });
  }

  /** Guest sessions still alive; an unmounted id must leave nothing behind. */
  liveSessionIds(): string[] {
    return [...this.#sessions];
  }

  #applyGuestState(method: string, args: readonly unknown[]): Error | undefined {
    // `reset-runtime` takes no arguments and drops every session, like the real guest.
    if (method === 'reset-runtime') {
      this.#sessions.clear();
      return undefined;
    }

    const first = args[0];
    const instanceId =
      typeof first === 'object' && first !== null
        ? (first as { instanceId?: unknown }).instanceId
        : first;
    if (typeof instanceId !== 'string') return undefined;

    if (method === 'mount') {
      if (this.#sessions.has(instanceId)) {
        return new Error(`Widget instance ${JSON.stringify(instanceId)} is already mounted`);
      }
      this.#sessions.add(instanceId);
      return undefined;
    }
    if (method === 'unmount') {
      this.#sessions.delete(instanceId);
      return undefined;
    }
    return undefined;
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

  terminate(reason?: string): Promise<void> {
    this.reasons.push(reason ?? '');
    this.state = 'terminated';
    return Promise.resolve();
  }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(payload);
    }
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** Arguments of every call of `method`, in order. */
  callsOf(method: string): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  argsOf(method: string): readonly unknown[] | undefined {
    return this.calls.find((call) => call.method === method)?.args;
  }
}

function createBitmap(instanceId: string): FakeBitmap {
  const bitmap: FakeBitmap = {
    instanceId,
    closed: false,
    close: () => {
      bitmap.closed = true;
    },
  };
  return bitmap;
}

const asBitmap = (bitmap: FakeBitmap): ImageBitmap => bitmap as unknown as ImageBitmap;

const demoModule: WidgetModule = {
  definition: { properties: {}, ports: {} },
  code: 'export default () => ({});',
};

const provider = createStaticWidgetProvider({ 'demo:indicator': demoModule });

/** Valid UUID v4 ids, because the `.cnv` parser rejects anything else. */
const ID_A = '0f1d5a70-0000-4000-8000-00000000000a';
const ID_B = '0f1d5a70-0000-4000-8000-00000000000b';

/** One canvas instance with a placement the `.cnv` parser accepts. */
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

interface Harness {
  readonly host: ReturnType<typeof createWidgetHost>;
  readonly sandbox: FakeSandbox;
  readonly diagnostics: WidgetDiagnostic[];
  readonly changes: WidgetLayerChange[];
  readonly publishes: WidgetPublish[];
  readonly documents: CanvasDocument[];
  readonly starts: () => number;
}

interface HarnessOptions {
  readonly module?: WidgetModule;
  readonly assets?: WidgetAssetProvider;
  readonly catalog?: CanvasBindingCatalog;
}

function createHarness(sandbox = new FakeSandbox(), options: HarnessOptions = {}): Harness {
  const diagnostics: WidgetDiagnostic[] = [];
  const changes: WidgetLayerChange[] = [];
  const publishes: WidgetPublish[] = [];
  const documents: CanvasDocument[] = [];
  let starts = 0;

  const host = createWidgetHost({
    provider:
      options.module === undefined
        ? provider
        : createStaticWidgetProvider({ 'demo:indicator': options.module }),
    sandbox: () => {
      starts += 1;
      return Promise.resolve(sandbox);
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onPublish: (publish) => publishes.push(publish),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  host.layers.subscribe((change) => changes.push(change));
  host.onDocumentChange((document) => documents.push(document));

  return { host, sandbox, diagnostics, changes, publishes, documents, starts: () => starts };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lets the coordination queue drain: every guest call the fake makes settles in a microtask. */
async function flush(): Promise<void> {
  await tick();
  await tick();
}

function layerIds(harness: Harness): string[] {
  return harness.host.layers.list().map((layer) => layer.instanceId);
}

function documentIds(harness: Harness): string[] {
  return harness.host.document.widgets.map((widget) => widget.id);
}

/** Arguments of every guest `mount`, in order. */
function mountRequests(sandbox: FakeSandbox): Record<string, unknown>[] {
  return sandbox.callsOf('mount').map((args) => args[0] as Record<string, unknown>);
}

function mountCount(sandbox: FakeSandbox): number {
  return sandbox.callsOf('mount').length;
}

function unmountCount(sandbox: FakeSandbox): number {
  return sandbox.callsOf('unmount').length;
}

const defaultsModule: WidgetModule = {
  definition: {
    properties: {
      color: { type: 'color', default: '#22AA55FF' },
      label: { type: 'string', default: null },
      hidden: { type: 'boolean' },
    },
    ports: {},
  },
  code: 'export default () => ({});',
};

const assetModule: WidgetModule = {
  definition: {
    properties: {
      texture: { type: 'image', default: { src: 'default.png', mode: 'file' } },
    },
    ports: {},
  },
  code: 'export default () => ({});',
};

/** Registry + schematic the binding validator needs: one widget, one property, one port. */
const catalog: CanvasBindingCatalog = {
  widgetDefinition: (ref) =>
    ref === 'demo:indicator'
      ? { ports: { value: { direction: 'input', type: 'number' } }, propertyKeys: ['color'] }
      : undefined,
  hasSchematic: () => true,
  hasSymbol: () => true,
  symbolPort: () => ({ direction: 'output', type: 'number' }),
};

describe('createWidgetHost', () => {
  it('starts empty and does not start the sandbox before an instance exists', () => {
    const harness = createHarness();

    expect(harness.host.document).toEqual({ version: 1, widgets: [] });
    expect(harness.host.layers.list()).toEqual([]);
    expect(harness.starts()).toBe(0);
  });

  it('mounts every instance in document order and keeps the layer order', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B, x: 40 })));

    expect(harness.starts()).toBe(1);
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
    expect(documentIds(harness)).toEqual([ID_A, ID_B]);
    expect(mountRequests(harness.sandbox).map((request) => request.instanceId)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(harness.changes).toEqual([
      { type: 'added', instanceId: ID_A },
      { type: 'added', instanceId: ID_B },
    ]);
  });

  it('rejects an invalid document without touching the mounted instances', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const before = harness.host.document;

    const futureVersion = { version: 2, widgets: [] } as unknown as CanvasDocument;
    await expect(harness.host.loadDocument(futureVersion)).rejects.toBeInstanceOf(SchematicError);
    const broken = { version: 1, widgets: [{ id: 'not-a-uuid' }] } as unknown as CanvasDocument;
    await expect(harness.host.loadDocument(broken)).rejects.toBeInstanceOf(SchematicError);

    expect(harness.host.document).toBe(before);
    expect(layerIds(harness)).toEqual([ID_A]);
    expect(harness.sandbox.state).toBe('ready');
  });

  it('sends the resolved module to the guest before mounting', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    expect(harness.sandbox.methods().slice(0, 2)).toEqual(['load', 'mount']);
    expect(harness.sandbox.argsOf('load')).toEqual([
      {
        packages: [
          {
            id: 'demo',
            modules: { indicator: { definition: demoModule.definition, code: demoModule.code } },
          },
        ],
      },
    ]);
    expect(harness.sandbox.argsOf('mount')).toEqual([
      { instanceId: ID_A, widget: 'demo:indicator', width: 20, height: 10, dpr: 1, props: {} },
    ]);
  });

  it('fills definition defaults into the mount request and lets document props win', async () => {
    const harness = createHarness(undefined, { module: defaultsModule });

    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const fromDefaults = mountRequests(harness.sandbox)[0]?.props as Record<string, unknown>;
    expect(fromDefaults).toEqual({ color: '#22AA55FF', label: null });
    expect(Object.hasOwn(fromDefaults, 'hidden')).toBe(false);

    harness.host.applyCommand({
      type: 'add-instance',
      instance: instance({ id: ID_B, properties: { color: 'red' } }),
      z: 1,
    });
    await flush();

    expect(mountRequests(harness.sandbox)[1]?.props).toEqual({ color: 'red', label: null });
  });

  it('prefetches nested asset references from document props', async () => {
    const reads: WidgetAssetRef[] = [];
    const assets: WidgetAssetProvider = {
      resolve: async (ref) => {
        reads.push(ref);
        return new TextEncoder().encode(`bytes:${ref.src}`);
      },
    };
    const harness = createHarness(undefined, { module: assetModule, assets });

    await harness.host.loadDocument(
      canvas(
        instance({
          id: ID_A,
          properties: {
            background: { src: 'bg.png', mode: 'inline' },
            layers: [
              { image: { src: 'layer.png', mode: 'store' } },
              { src: 'bg.png', mode: 'inline' },
            ],
            label: 'not an asset',
          },
        }),
      ),
    );

    expect(reads).toEqual([
      { src: 'default.png', mode: 'file' },
      { src: 'bg.png', mode: 'inline' },
      { src: 'layer.png', mode: 'store' },
    ]);
    const assetsSent = mountRequests(harness.sandbox)[0]?.assets as Record<string, Uint8Array>;
    expect(Object.keys(assetsSent).sort()).toEqual(['bg.png', 'default.png', 'layer.png']);
    expect(new TextDecoder().decode(assetsSent['bg.png'])).toBe('bytes:bg.png');
  });

  it('mounts without the failed asset and reports widget/asset-failed', async () => {
    const assets: WidgetAssetProvider = {
      resolve: async (ref) => {
        if (ref.src === 'missing.png') throw new Error('ENOENT');
        return new Uint8Array([1, 2]);
      },
    };
    const harness = createHarness(undefined, { module: assetModule, assets });

    await harness.host.loadDocument(
      canvas(
        instance({
          id: ID_A,
          properties: {
            texture: { src: 'missing.png', mode: 'file' },
            ok: { src: 'ok.png', mode: 'file' },
          },
        }),
      ),
    );

    expect(harness.host.layers.get(ID_A)).toBeDefined();
    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        code: 'widget/asset-failed',
        instanceId: ID_A,
        widget: 'demo:indicator',
      }),
    ]);
    expect(mountRequests(harness.sandbox)[0]?.assets).toEqual({
      'ok.png': new Uint8Array([1, 2]),
    });
  });

  it('does not prefetch or report when no asset source is configured', async () => {
    const harness = createHarness(undefined, { module: assetModule });

    await harness.host.loadDocument(
      canvas(
        instance({
          id: ID_A,
          properties: { texture: { src: 'missing.png', mode: 'file' } },
        }),
      ),
    );

    expect(harness.diagnostics).toEqual([]);
    expect(mountRequests(harness.sandbox)[0]).not.toHaveProperty('assets');
    expect(harness.host.layers.get(ID_A)).toBeDefined();
  });

  it('remounts an instance whose property names an asset the guest never received', async () => {
    const reads: string[] = [];
    const assets: WidgetAssetProvider = {
      resolve: async (ref) => {
        reads.push(ref.src);
        return new TextEncoder().encode(`bytes:${ref.src}`);
      },
    };
    const harness = createHarness(undefined, { module: assetModule, assets });
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    expect(reads).toEqual(['default.png']);

    harness.host.applyCommand({
      type: 'set-property',
      instanceId: ID_A,
      key: 'texture',
      value: { src: 'chosen.png', mode: 'file' },
    });
    await flush();

    // A remount is the only way to hand the new bytes over, so the guest gets a second mount.
    expect(reads).toEqual(['default.png', 'chosen.png']);
    expect(mountCount(harness.sandbox)).toBe(2);
    expect(unmountCount(harness.sandbox)).toBe(1);
    const sent = mountRequests(harness.sandbox)[1]?.assets as Record<string, Uint8Array>;
    expect(new TextDecoder().decode(sent['chosen.png'])).toBe('bytes:chosen.png');
    expect(harness.diagnostics).toEqual([]);
  });

  it('keeps the instance mounted when a property change adds no asset', async () => {
    const harness = createHarness(undefined, { module: defaultsModule });
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.applyCommand({
      type: 'set-property',
      instanceId: ID_A,
      key: 'color',
      value: '#112233',
    });
    await flush();

    expect(mountCount(harness.sandbox)).toBe(1);
    expect(unmountCount(harness.sandbox)).toBe(0);
    expect(harness.sandbox.callsOf('set-properties')).toHaveLength(1);
  });

  it('mounts only the instance an add-instance command introduces', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.applyCommand({
      type: 'add-instance',
      instance: instance({ id: ID_B, x: 40 }),
      z: 1,
    });
    await flush();

    expect(mountCount(harness.sandbox)).toBe(2);
    expect(mountRequests(harness.sandbox)[1]?.instanceId).toBe(ID_B);
    expect(unmountCount(harness.sandbox)).toBe(0);
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
    expect(documentIds(harness)).toEqual([ID_A, ID_B]);
  });

  it('unmounts only the instance a remove-instance command drops', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });
    await flush();

    expect(harness.sandbox.callsOf('unmount')).toEqual([[ID_A]]);
    expect(layerIds(harness)).toEqual([ID_B]);
    expect(documentIds(harness)).toEqual([ID_B]);
    expect(mountCount(harness.sandbox)).toBe(2);
  });

  it('resizes on set-placement without remounting or bumping the frame sequence', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(createBitmap(ID_A)),
      width: 20,
      height: 10,
      dpr: 1,
    });
    const layer = harness.host.layers.get(ID_A);
    expect(layer?.sequence).toBe(1);

    harness.host.applyCommand({
      type: 'set-placement',
      instanceId: ID_A,
      placement: { x: 12, y: 8, width: 60, height: 30, rotation: 15 },
    });
    await flush();

    expect(layer?.width).toBe(60);
    expect(layer?.height).toBe(30);
    expect(layer?.sequence).toBe(1);
    expect(mountCount(harness.sandbox)).toBe(1);
    expect(harness.sandbox.argsOf('resize')).toEqual([ID_A, 60, 30, 1]);
  });

  it('leaves the guest alone when a command changes nothing', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A, properties: { color: 'red' } })));
    const calls = harness.sandbox.calls.length;

    harness.host.applyCommand({
      type: 'set-placement',
      instanceId: ID_A,
      placement: { x: 0, y: 0, width: 20, height: 10, rotation: 0 },
    });
    harness.host.applyCommand({
      type: 'set-property',
      instanceId: ID_A,
      key: 'color',
      value: 'red',
    });
    await flush();

    expect(harness.sandbox.calls.slice(calls)).toEqual([]);
  });

  it('forwards set-property as set-properties without producing frames', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.applyCommand({
      type: 'set-property',
      instanceId: ID_A,
      key: 'color',
      value: '#FF0000',
    });
    await flush();

    expect(harness.sandbox.argsOf('set-properties')).toEqual([ID_A, { color: '#FF0000' }]);
    const layer = harness.host.layers.get(ID_A);
    expect(layer?.sequence).toBe(0);
    expect(layer?.bitmap).toBeUndefined();
    expect(harness.host.document.widgets[0]?.properties).toEqual({ color: '#FF0000' });
  });

  it('reorders layers on set-z without mounting or unmounting', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    harness.host.applyCommand({ type: 'set-z', instanceId: ID_A, z: 1 });
    await flush();

    expect(layerIds(harness)).toEqual([ID_B, ID_A]);
    expect(documentIds(harness)).toEqual([ID_B, ID_A]);
    expect(mountCount(harness.sandbox)).toBe(2);
    expect(unmountCount(harness.sandbox)).toBe(0);
    expect(harness.changes.at(-1)).toEqual({ type: 'reordered' });
  });

  it('rejects an invalid command without changing the document or the layers', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const before = harness.host.document;

    expect(() => harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_B })).toThrow(
      SchematicError,
    );
    await flush();

    expect(harness.host.document).toBe(before);
    expect(layerIds(harness)).toEqual([ID_A]);
    expect(unmountCount(harness.sandbox)).toBe(0);
  });

  it('rejects a command whose bindings do not validate, keeping the previous state', async () => {
    const harness = createHarness(undefined, { catalog });
    await harness.host.loadDocument(canvas(instance({ id: ID_A, properties: { color: 'red' } })));
    const before = harness.host.document;
    const calls = harness.sandbox.calls.length;

    const command: CanvasCommand = {
      type: 'set-property',
      instanceId: ID_A,
      key: 'unknown',
      value: 1,
    };
    expect(() => harness.host.applyCommand(command)).toThrow(SchematicError);
    await flush();

    expect(harness.host.document).toBe(before);
    expect(harness.host.layers.get(ID_A)?.width).toBe(20);
    expect(harness.sandbox.calls.slice(calls)).toEqual([]);
    expect(harness.diagnostics).toEqual([]);
  });

  it('rejects a document whose bindings do not validate', async () => {
    const harness = createHarness(undefined, { catalog });

    await expect(
      harness.host.loadDocument(canvas(instance({ id: ID_A, properties: { width: 1 } }))),
    ).rejects.toBeInstanceOf(SchematicError);

    expect(harness.host.document).toEqual({ version: 1, widgets: [] });
    expect(harness.host.layers.list()).toEqual([]);
    expect(harness.starts()).toBe(0);
  });

  it('skips the reference checks a catalog would enable', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(canvas(instance({ id: ID_A, properties: { width: 1 } })));

    expect(harness.diagnostics).toEqual([]);
    expect(layerIds(harness)).toEqual([ID_A]);
  });

  it('serializes commands so each instance mounts exactly once', async () => {
    const harness = createHarness();
    const release = harness.sandbox.gate('mount');

    harness.host.applyCommand({ type: 'add-instance', instance: instance({ id: ID_A }), z: 0 });
    await tick();
    harness.host.applyCommand({ type: 'add-instance', instance: instance({ id: ID_B }), z: 1 });
    await tick();

    expect(mountCount(harness.sandbox)).toBe(1);

    release();
    await flush();

    expect(mountCount(harness.sandbox)).toBe(2);
    expect(mountRequests(harness.sandbox).map((request) => request.instanceId)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(harness.sandbox.liveSessionIds()).toEqual([ID_A, ID_B]);
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
    expect(harness.diagnostics).toEqual([]);
  });

  it('reuses the running queue when a layer subscriber applies a command', async () => {
    const harness = createHarness();
    let reentered = false;
    harness.host.layers.subscribe((change) => {
      // A subscriber is allowed to edit the document from the notification. That work has to join
      // the running pass; starting a second one would interleave guest calls and resolve
      // `loadDocument` before the instances it mounted are done.
      if (change.type !== 'added' || reentered) return;
      reentered = true;
      harness.host.applyCommand({ type: 'set-z', instanceId: ID_A, z: 1 });
    });

    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    expect(reentered).toBe(true);
    // One queue: both mounts belong to the same pass, so they keep the order it walked.
    expect(harness.sandbox.methods()).toEqual(['load', 'mount', 'load', 'mount']);
    expect(mountRequests(harness.sandbox).map((request) => request.instanceId)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(unmountCount(harness.sandbox)).toBe(0);
    // `loadDocument` resolves after every instance mounted, so the layers already follow the
    // document the subscriber installed.
    expect(layerIds(harness)).toEqual([ID_B, ID_A]);
    expect(documentIds(harness)).toEqual([ID_B, ID_A]);
    expect(harness.diagnostics).toEqual([]);
  });

  it('mounts each instance once when two loadDocument calls race', async () => {
    const harness = createHarness();
    const document = canvas(instance({ id: ID_A }), instance({ id: ID_B }));

    await Promise.all([harness.host.loadDocument(document), harness.host.loadDocument(document)]);

    expect(mountCount(harness.sandbox)).toBe(2);
    expect(harness.diagnostics).toEqual([]);
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
  });

  it('replaces an instance whose widget reference changed in a new document', async () => {
    const sandbox = new FakeSandbox();
    const host = createWidgetHost({
      provider: createStaticWidgetProvider({
        'demo:indicator': demoModule,
        'demo:gauge': demoModule,
      }),
      sandbox: () => Promise.resolve(sandbox),
    });

    await host.loadDocument(canvas(instance({ id: ID_A })));
    await host.loadDocument(canvas(instance({ id: ID_A, widget: 'demo:gauge' })));

    expect(sandbox.callsOf('mount').map((args) => (args[0] as { widget: string }).widget)).toEqual([
      'demo:indicator',
      'demo:gauge',
    ]);
    expect(sandbox.callsOf('unmount')).toEqual([[ID_A]]);
    expect(host.layers.list().map((layer) => layer.instanceId)).toEqual([ID_A]);
  });

  it('notifies document listeners synchronously once per commit', async () => {
    const harness = createHarness();
    const seen: CanvasDocument[] = [];
    const off = harness.host.onDocumentChange((document) => seen.push(document));

    harness.host.applyCommand({ type: 'add-instance', instance: instance({ id: ID_A }), z: 0 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.widgets.map((widget) => widget.id)).toEqual([ID_A]);
    await flush();
    expect(seen).toHaveLength(1);

    off();
    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });
    expect(seen).toHaveLength(1);
    expect(harness.documents).toHaveLength(2);
  });

  it('installs frames, increments the sequence and closes the previous bitmap', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const first = createBitmap(ID_A);
    const second = createBitmap(ID_A);

    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(first),
      width: 20,
      height: 10,
      dpr: 1,
    });
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(second),
      width: 20,
      height: 10,
      dpr: 1,
    });

    const layer = harness.host.layers.get(ID_A);
    expect(layer?.sequence).toBe(2);
    expect(layer?.bitmap).toBe(asBitmap(second));
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('closes frames that arrive for an instance that is gone', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const bitmap = createBitmap('unknown');

    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: 'unknown',
      bitmap: asBitmap(bitmap),
      width: 1,
      height: 1,
      dpr: 1,
    });

    expect(bitmap.closed).toBe(true);
    expect(harness.host.layers.get('unknown')).toBeUndefined();
  });

  it('keeps every other instance when one reports a failure', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    harness.sandbox.emit(WIDGET_ERROR_EVENT, {
      instanceId: ID_A,
      phase: 'render',
      error: { name: 'Error', message: 'bad frame' },
    });

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        code: 'widget/render-failed',
        instanceId: ID_A,
        widget: 'demo:indicator',
      }),
    ]);
    expect(harness.host.layers.get(ID_A)).toBeDefined();
    expect(harness.host.layers.get(ID_B)).toBeDefined();
  });

  it('reports delivery failures without dropping the instance', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.sandbox.emit(WIDGET_ERROR_EVENT, {
      instanceId: ID_A,
      phase: 'deliver',
      error: { name: 'TypeError', message: 'listener exploded' },
    });

    expect(harness.diagnostics[0]).toMatchObject({
      code: 'widget/deliver-failed',
      instanceId: ID_A,
    });
    expect(harness.host.layers.get(ID_A)).toBeDefined();
  });

  it('forwards published payloads to the host callback', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.sandbox.emit(WIDGET_PUBLISH_EVENT, {
      instanceId: ID_A,
      port: 'value',
      payload: 3,
      simTime: 1280,
    });
    harness.sandbox.emit(WIDGET_PUBLISH_EVENT, {
      instanceId: ID_A,
      port: 'value',
      payload: 4,
    });

    expect(harness.publishes).toEqual([
      { instanceId: ID_A, port: 'value', payload: 3, simTime: 1280 },
      { instanceId: ID_A, port: 'value', payload: 4, simTime: 0 },
    ]);
  });

  it('delivers payloads and input events to mounted instances', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.deliver(ID_A, 'value', 0.5, 64);
    harness.host.dispatch(ID_A, { type: 'pointerdown', x: 1, y: 2 });
    await flush();

    expect(harness.sandbox.argsOf('deliver')).toEqual([ID_A, 'value', 0.5, 64]);
    expect(harness.sandbox.argsOf('pointer')).toEqual([ID_A, { type: 'pointerdown', x: 1, y: 2 }]);
  });

  it('removes the layer and closes its bitmap when the document drops the instance', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const bitmap = createBitmap(ID_A);
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });

    expect(harness.host.layers.get(ID_A)).toBeUndefined();
    expect(bitmap.closed).toBe(true);
    expect(harness.changes.at(-1)).toEqual({ type: 'removed', instanceId: ID_A });

    await flush();
    expect(harness.sandbox.argsOf('unmount')).toEqual([ID_A]);
  });

  it('cancels a mount in flight and releases its guest session', async () => {
    const harness = createHarness();
    const release = harness.sandbox.gate('mount');

    const loading = harness.host.loadDocument(canvas(instance({ id: ID_A })));
    await tick();
    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });
    release();
    await loading;
    await flush();

    expect(harness.host.layers.list()).toEqual([]);
    // The document removal unmounts, then the cancelled mount releases the session the guest
    // created while the host was still waiting, so `unmount` ends the call log.
    expect(harness.sandbox.methods().at(-1)).toBe('unmount');
    expect(harness.sandbox.callsOf('unmount')).toEqual([[ID_A], [ID_A]]);
    expect(harness.sandbox.liveSessionIds()).toEqual([]);
    expect(harness.diagnostics).toEqual([]);
    expect(documentIds(harness)).toEqual([]);
  });

  it('leaves a newer instance alone when a cancelled mount unwinds', async () => {
    const harness = createHarness();
    const release = harness.sandbox.gate('mount');

    const loading = harness.host.loadDocument(canvas(instance({ id: ID_A })));
    await tick();
    harness.host.applyCommand({ type: 'remove-instance', instanceId: ID_A });
    harness.host.applyCommand({ type: 'add-instance', instance: instance({ id: ID_A }), z: 0 });
    release();
    await loading;
    await flush();

    expect(harness.host.layers.get(ID_A)).toBeDefined();
    expect(harness.sandbox.liveSessionIds()).toEqual([ID_A]);
    expect(harness.diagnostics).toEqual([]);
  });

  it('reports missing instances for the instance-scoped methods', async () => {
    const harness = createHarness();

    harness.host.deliver('ghost', 'value', 1, 0);
    harness.host.dispatch('ghost', { type: 'pointerdown' });

    expect(harness.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'widget/instance-not-found',
      'widget/instance-not-found',
    ]);
    expect(harness.starts()).toBe(0);
  });

  it('reports widgets the provider does not know', async () => {
    const harness = createHarness();

    await harness.host.loadDocument(canvas(instance({ id: ID_A, widget: 'demo:missing' })));

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/unknown-widget', widget: 'demo:missing' }),
    ]);
    expect(harness.host.layers.list()).toEqual([]);
    expect(harness.starts()).toBe(0);
  });

  it('drops the layer of an instance whose guest mount fails and keeps the rest', async () => {
    const harness = createHarness();
    harness.sandbox.fail('mount', new Error('factory exploded'));

    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/mount-failed', instanceId: ID_A }),
    ]);
    expect(layerIds(harness)).toEqual([ID_B]);
    expect(harness.sandbox.liveSessionIds()).toEqual([ID_B]);
  });

  it('retries a failed instance on the next command', async () => {
    const harness = createHarness();
    harness.sandbox.fail('mount', new Error('factory exploded'));
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    expect(layerIds(harness)).toEqual([]);

    harness.host.applyCommand({
      type: 'set-placement',
      instanceId: ID_A,
      placement: { x: 0, y: 0, width: 30, height: 10, rotation: 0 },
    });
    await flush();

    expect(layerIds(harness)).toEqual([ID_A]);
    expect(harness.host.layers.get(ID_A)?.width).toBe(30);
  });

  it('repaints every layer when the device pixel ratio changes', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));

    harness.host.resize(2);

    expect(harness.host.layers.get(ID_A)?.dpr).toBe(2);
    await flush();
    expect(harness.sandbox.argsOf('resize')).toEqual([ID_A, 20, 10, 2]);
  });

  it('clears layers and reports one runtime failure when the sandbox terminates', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const bitmap = createBitmap(ID_A);
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    harness.sandbox.state = 'terminated';
    harness.host.deliver(ID_A, 'value', 1, 0);
    await flush();

    expect(harness.diagnostics).toEqual([
      expect.objectContaining({ code: 'widget/runtime-failed' }),
    ]);
    expect(harness.host.layers.list()).toEqual([]);
    expect(bitmap.closed).toBe(true);
  });

  it('reports a runtime failure when the sandbox cannot start', async () => {
    const diagnostics: WidgetDiagnostic[] = [];
    const host = createWidgetHost({
      provider,
      sandbox: () => Promise.reject(new Error('no iframe')),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await host.loadDocument(canvas(instance({ id: ID_A })));

    expect(diagnostics).toEqual([expect.objectContaining({ code: 'widget/runtime-failed' })]);
    expect(host.layers.list()).toEqual([]);
  });

  it('terminates the sandbox and closes every bitmap on dispose', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const bitmap = createBitmap(ID_A);
    harness.sandbox.emit(WIDGET_FRAME_EVENT, {
      instanceId: ID_A,
      bitmap: asBitmap(bitmap),
      width: 20,
      height: 10,
      dpr: 1,
    });

    await harness.host.dispose();
    await harness.host.dispose();

    expect(harness.sandbox.reasons).toHaveLength(1);
    expect(bitmap.closed).toBe(true);
    expect(harness.host.layers.list()).toEqual([]);
  });

  it('cancels a mount interrupted by dispose without reporting a failure', async () => {
    const harness = createHarness();
    const release = harness.sandbox.gate('mount');

    const loading = harness.host.loadDocument(canvas(instance({ id: ID_A })));
    await tick();
    const disposing = harness.host.dispose();
    release();

    await loading;
    await disposing;

    expect(harness.diagnostics).toEqual([]);
    expect(harness.host.layers.list()).toEqual([]);
    expect(harness.sandbox.reasons).toHaveLength(1);
  });

  it('terminates a sandbox that finishes starting after dispose', async () => {
    const sandbox = new FakeSandbox();
    let resolveStart: ((value: WidgetSandbox) => void) | undefined;
    const host = createWidgetHost({
      provider,
      sandbox: () =>
        new Promise<WidgetSandbox>((resolve) => {
          resolveStart = resolve;
        }),
    });

    const loading = host.loadDocument(canvas(instance({ id: ID_A })));
    await tick();
    const disposing = host.dispose();
    resolveStart?.(sandbox);

    await loading;
    await disposing;

    expect(sandbox.reasons).toHaveLength(1);
    expect(host.layers.list()).toEqual([]);
  });

  it('resets the guest runtime and mounts the current document again', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));
    expect(mountCount(harness.sandbox)).toBe(2);

    const resetting = harness.host.reset();
    // Layers vanish synchronously, so the editor can paint placeholders right away.
    expect(layerIds(harness)).toEqual([]);
    await resetting;

    expect(harness.sandbox.methods()).toContain('reset-runtime');
    expect(harness.sandbox.methods().filter((method) => method === 'reset-runtime')).toHaveLength(
      1,
    );
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
    expect(documentIds(harness)).toEqual([ID_A, ID_B]);
  });

  it('mounts brand-new instances on reset instead of adopting the old ones', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A }), instance({ id: ID_B })));
    expect(mountCount(harness.sandbox)).toBe(2);
    expect(unmountCount(harness.sandbox)).toBe(0);

    await harness.host.reset();

    // Four mounts total: the original two and the two the reset re-created. Nothing is adopted, so
    // the host never sends a redundant unmount for the instances it dropped synchronously.
    expect(mountCount(harness.sandbox)).toBe(4);
    expect(unmountCount(harness.sandbox)).toBe(0);
    expect(mountRequests(harness.sandbox).map((request) => request.instanceId)).toEqual([
      ID_A,
      ID_B,
      ID_A,
      ID_B,
    ]);
  });

  it('re-loads and re-prefetches assets for every instance the reset remounts', async () => {
    const reads: string[] = [];
    const harness = createHarness(undefined, {
      module: assetModule,
      assets: {
        resolve: async (ref) => {
          reads.push(ref.src);
          return new TextEncoder().encode(ref.src);
        },
      },
    });
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    expect(reads).toEqual(['default.png']);

    await harness.host.reset();

    expect(reads).toEqual(['default.png', 'default.png']);
    expect(harness.sandbox.methods().filter((method) => method === 'load')).toHaveLength(2);
    const assetsSent = mountRequests(harness.sandbox)[1]?.assets as Record<string, Uint8Array>;
    expect(new TextDecoder().decode(assetsSent['default.png'])).toBe('default.png');
  });

  it('does not interleave a reset with a concurrent command', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    const before = harness.sandbox.methods().length;
    const release = harness.sandbox.gate('reset-runtime');

    const resetting = harness.host.reset();
    harness.host.applyCommand({
      type: 'add-instance',
      instance: instance({ id: ID_B }),
      z: 1,
    });
    await flush();
    // The queued command waits for the reset, which is still parked in the guest: no new mount may
    // start while `reset-runtime` is in flight.
    expect(harness.sandbox.methods().slice(before)).toEqual(['reset-runtime']);

    release();
    await resetting;

    const methods = harness.sandbox.methods();
    const resetAt = methods.indexOf('reset-runtime');
    expect(methods[resetAt]).toBe('reset-runtime');
    // Everything after the reset is the remount of the full, current document.
    expect(methods.slice(resetAt + 1).filter((method) => method === 'mount')).toHaveLength(2);
    expect(layerIds(harness)).toEqual([ID_A, ID_B]);
  });

  it('reports a failed reset instead of rejecting', async () => {
    const harness = createHarness();
    await harness.host.loadDocument(canvas(instance({ id: ID_A })));
    harness.sandbox.fail('reset-runtime', new Error('reset exploded'));

    await expect(harness.host.reset()).resolves.toBeUndefined();

    expect(harness.diagnostics[0]).toMatchObject({
      code: 'widget/runtime-failed',
      message: expect.stringContaining('reset exploded'),
    });
    // The remount is attempted anyway; a broken reset must not stop the pass. The fake keeps its
    // session table when `reset-runtime` fails, so that attempt fails too and is reported.
    expect(mountCount(harness.sandbox)).toBe(2);
    expect(harness.diagnostics[1]).toMatchObject({ code: 'widget/mount-failed' });
  });
});
