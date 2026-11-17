import { toTimePs } from '@mica-js/core';
import type {
  DeviceRegistry,
  FusedDocument,
  PackageFiles,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type { ModelEvent, Value } from '@mica-js/sdk/fused';
import { afterEach, describe, expect, it } from 'vitest';
import { startFusedDisplayGuest } from './display/guest';
import type { IFusedOverlaySurface } from './display/view';
import { createFusedRuntime } from './host/runtime';
import type { IFusedRuntime, IFusedWorker, IFusedWorkerFactories } from './host/types';
import type {
  IFusedModelClient,
  IFusedOverlayFrame,
  IFusedView2D,
  IFusedView2DContext,
  IFusedViewInput,
} from './protocol';
import { startFusedSimulationGuest } from './simulation/guest';
import { transferOverlayFrame, transferResourceBytes } from './wire';
import {
  createWorkletNode,
  FakeAudioContext,
  flush,
} from '../../../../widget/src/host/audio/test-helpers';

const DEVICE = 'test:lamp';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const STEP = toTimePs(1, 'ms');

const GEOMETRY = {
  sizing: 'flexible' as const,
  bounds: { x: -1, y: -1, width: 8, height: 8 },
  bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
  pins: {},
};

const MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'lamp',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Lamp',
  properties: { label: { type: 'string', default: 'lamp' } },
  pins: {},
  view2d: { geometry: GEOMETRY, entry: 'view.js' },
  model: {
    entry: 'model.js',
    methods: {
      setOn: { params: { type: 'boolean' }, returns: { type: 'null' } },
      getOn: { params: { type: 'null' }, returns: { type: 'boolean' } },
    },
    events: { onDidChange: { type: 'boolean' } },
  },
};

const MODEL_CODE = 'model-entry';
const VIEW_CODE = 'view-entry';

const MODEL_IR = { kind: 'device', name: 'Lamp', declarations: [] };

const cleanups: Array<() => Promise<void> | void> = [];

describe('instance audio integration', () => {
  it.each([false, true])(
    'keeps simulation available when audio is unavailable (loader failure: %s)',
    async (failLoader) => {
      const data = await fixture();
      const host = workbench();
      const diagnostics: string[] = [];
      const runtime = await createFusedRuntime({
        ...data,
        step: STEP,
        mode: 'run',
        workers: host.workers,
        onDiagnostic: (entry) => diagnostics.push(entry.code),
        ...(failLoader
          ? {
              audio: {
                context: new FakeAudioContext() as unknown as AudioContext,
                getAudioWorklet: async () => {
                  throw new Error('audio device unavailable');
                },
              },
            }
          : {}),
      });
      cleanups.push(() => runtime.dispose());
      expect(runtime.getState().status).toBe('running');
      const api = host.views[0]!.context.audio;
      expect(api.state).toBe('unavailable');
      const tone = api.tone({ frequency: 440 });
      tone.stop();
      await expect(tone.ended).resolves.toEqual({ reason: 'stopped' });
      const stream = api.createStream({ sampleRate: 8000 });
      await expect(stream.write(new Float32Array(8))).resolves.toBe(false);
      stream.end();
      await expect(stream.ended).resolves.toEqual({ reason: 'finished' });
      expect(diagnostics.includes('audio/failed')).toBe(failLoader);
    },
  );

  it('isolates instance volume and clears voices and PCM across pause, reset and disposal', async () => {
    const data = await fixture();
    const second = '22222222-2222-4222-8222-222222222222';
    const document = {
      ...data.document,
      instances: [...data.document.instances, { ...data.document.instances[0]!, id: second }],
    };
    const host = workbench();
    const context = new FakeAudioContext();
    const worklet = createWorkletNode();
    cleanups.push(() => worklet.dispose());
    const runtime = await createFusedRuntime({
      document,
      registry: data.registry,
      step: STEP,
      mode: 'run',
      workers: host.workers,
      audio: {
        context: context as unknown as AudioContext,
        getAudioWorklet: async () => worklet.node as unknown as AudioWorkletNode,
      },
    });
    cleanups.push(() => runtime.dispose());
    const a = host.views[0]!.context.audio;
    const b = host.views[1]!.context.audio;
    expect(host.surfaces).toHaveLength(0);
    const tone = a.tone({ frequency: 480, type: 'square' });
    const stream = a.createStream({ sampleRate: 48000, bufferMs: 50, startMs: 0 });
    const samples = new Float32Array(stream.capacityFrames).fill(0.25);
    await expect(stream.write(samples)).resolves.toBe(true);
    expect(samples.buffer.byteLength).toBeGreaterThan(0);
    await expect(stream.write(new Float32Array(1))).resolves.toBe(false);
    expect(stream.bufferedFrames).toBeLessThanOrEqual(stream.capacityFrames);
    runtime.audio.setInstanceVolume(INSTANCE_ID, 0);
    const other = b.tone({ frequency: 960, type: 'square' });
    await flush();
    expect(worklet.render().left.some((sample) => sample !== 0)).toBe(true);
    other.stop();
    await flush();
    expect(worklet.render().left.every((sample) => sample === 0)).toBe(true);
    runtime.audio.setInstanceVolume(INSTANCE_ID, 1);
    runtime.pause();
    await flush();
    const before = stream.bufferedFrames;
    expect(worklet.render().left.every((sample) => sample === 0)).toBe(true);
    expect(stream.bufferedFrames).toBe(before);
    await runtime.resume();
    await flush();
    expect(worklet.render().left.some((sample) => sample !== 0)).toBe(true);
    await runtime.reset();
    await expect(tone.ended).resolves.toEqual({ reason: 'disposed' });
    await expect(stream.ended).resolves.toEqual({ reason: 'disposed' });
    await flush();
    expect(worklet.render().left.every((sample) => sample === 0)).toBe(true);
    const last = host.views.at(-1)!.context.audio.tone({ frequency: 480 });
    await runtime.dispose();
    await expect(last.ended).resolves.toEqual({ reason: 'disposed' });
    await flush();
    expect(worklet.render().left.every((sample) => sample === 0)).toBe(true);
  });

  it('preserves browser suspension until the caller activates the context', async () => {
    const data = await fixture();
    const host = workbench();
    const context = new FakeAudioContext({ state: 'suspended' });
    const worklet = createWorkletNode();
    cleanups.push(() => worklet.dispose());
    const runtime = await createFusedRuntime({
      ...data,
      step: STEP,
      mode: 'run',
      workers: host.workers,
      audio: {
        context: context as unknown as AudioContext,
        getAudioWorklet: async () => worklet.node as unknown as AudioWorkletNode,
      },
    });
    cleanups.push(() => runtime.dispose());
    const api = host.views[0]!.context.audio;
    expect(api.state).toBe('suspended');
    const states: string[] = [];
    const subscription = api.onDidChangeState((state) => states.push(state));
    context.setState('running');
    await flush();
    expect(api.state).toBe('running');
    expect(states).toEqual(['running']);
    subscription.dispose();
  });
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** JSON Canonicalization Scheme subset: sorted keys, no extra whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `sha256:${hex.join('')}`;
}

interface Fixture {
  readonly document: FusedDocument;
  readonly registry: DeviceRegistry;
}

async function fixture(
  manifest: UnifiedDeviceManifest = MANIFEST,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<Fixture> {
  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    'model.js': new TextEncoder().encode(MODEL_CODE),
    'view.js': new TextEncoder().encode(VIEW_CODE),
  };
  for (const [path, content] of Object.entries(extraFiles)) {
    files[path] = new TextEncoder().encode(content);
  }
  const table: Record<string, { size: number; integrity: string }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    table[path] = { size: bytes.length, integrity: await sha256(new TextDecoder().decode(bytes)) };
  }
  const integrity = await sha256(
    canonicalJson({ id: DEVICE, version: manifest.version, files: table }),
  );
  const registry: DeviceRegistry = {
    async open(lock): Promise<PackageFiles> {
      if (lock.id !== DEVICE) throw new Error(`unknown package ${lock.id}`);
      return {
        lock,
        files: table,
        read: async (path: string) => {
          const bytes = files[path];
          if (bytes === undefined) throw new Error(`unknown file ${path}`);
          return bytes.slice();
        },
      };
    },
  };
  const document: FusedDocument = {
    version: 2,
    dependencies: { [DEVICE]: { version: manifest.version, integrity } },
    instances: [
      {
        id: INSTANCE_ID,
        device: DEVICE,
        placement: { x: 0, y: 0, rotation: 0 },
        properties: {},
      },
    ],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
  return { document, registry };
}

interface ViewSpy {
  readonly context: IFusedView2DContext;
  readonly events: Value[];
  /** Ordered trace of factory subscriptions and the `initialize` hook. */
  readonly trace: string[];
  readonly inputs: IFusedViewInput[];
  renders: number;
  disposed: boolean;
}

interface SurfaceSpy extends IFusedOverlaySurface {
  readonly calls: string[];
}

interface Workbench {
  readonly workers: IFusedWorkerFactories;
  readonly views: ViewSpy[];
  readonly surfaces: SurfaceSpy[];
  readonly terminated: { simulation: number; display: number };
  /** Makes the next view factory call throw, to prove one broken presentation is contained. */
  failNextView: boolean;
}

function isMessagePort(value: unknown): value is MessagePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly postMessage?: unknown }).postMessage === 'function' &&
    typeof (value as { readonly addEventListener?: unknown }).addEventListener === 'function'
  );
}

function fakeWorker(
  start: (port: MessagePort, ports: readonly MessagePort[]) => void,
): IFusedWorker {
  return {
    state: 'ready',
    ready: Promise.resolve(),
    postMessage(_message: unknown, transfer: readonly Transferable[] = []) {
      const ports = transfer.filter(isMessagePort);
      const first = ports[0];
      if (first === undefined) throw new Error('the fake worker needs an RPC port');
      start(first, ports.slice(1));
    },
    async terminate() {
      return undefined;
    },
  };
}

interface WorkbenchOptions {
  /** Makes the model fire an event while it initializes, before any presentation initialize runs. */
  readonly initialEvent?: boolean;
  /** Makes the next view factory call throw, to prove one broken presentation is contained. */
  readonly failFirstView?: boolean;
}

function workbench(options: WorkbenchOptions = {}): Workbench {
  const views: ViewSpy[] = [];
  const surfaces: SurfaceSpy[] = [];
  const terminated = { simulation: 0, display: 0 };
  const state = { failNextView: options.failFirstView === true };
  const factory = (context: IFusedView2DContext): IFusedView2D => {
    if (state.failNextView) {
      state.failNextView = false;
      throw new Error('factory exploded');
    }
    const spy: ViewSpy = {
      context,
      events: [],
      trace: [],
      inputs: [],
      renders: 0,
      disposed: false,
    };
    views.push(spy);
    const subscription = context.model?.events['onDidChange']?.((event: ModelEvent<Value>) => {
      spy.events.push(event.value);
      spy.trace.push(`event:${String(event.value)}`);
    });
    return {
      initialize() {
        spy.trace.push('initialize');
      },
      renderOverlay() {
        spy.renders += 1;
      },
      input(event) {
        spy.inputs.push(event);
        void context.model?.methods['setOn']?.(true).catch(() => undefined);
      },
      dispose() {
        spy.disposed = true;
        subscription?.dispose();
      },
    };
  };
  const workers: IFusedWorkerFactories = {
    createSimulationWorker() {
      const worker = fakeWorker((port, ports) => {
        const guest = startFusedSimulationGuest(port, {
          ports,
          importModule: async (code) => {
            if (code !== MODEL_CODE) throw new Error(`unknown model source ${code}`);
            return modelNamespace(options.initialEvent === true);
          },
        });
        cleanups.push(() => guest.dispose());
      });
      return {
        ...worker,
        async terminate(reason?: string) {
          terminated.simulation += 1;
          await worker.terminate(reason);
        },
      };
    },
    createDisplayWorker() {
      const worker = fakeWorker((port, ports) => {
        const guest = startFusedDisplayGuest(port, {
          ports,
          importModule: async (code) => {
            if (code !== VIEW_CODE) throw new Error(`unknown view source ${code}`);
            return { default: factory };
          },
          createSurface: (width, height) => {
            const surface = surfaceSpy(width, height);
            surfaces.push(surface);
            return surface;
          },
        });
        cleanups.push(() => guest.dispose());
      });
      return {
        ...worker,
        async terminate(reason?: string) {
          terminated.display += 1;
          await worker.terminate(reason);
        },
      };
    },
  };
  return {
    workers,
    views,
    surfaces,
    terminated,
    get failNextView() {
      return state.failNextView;
    },
    set failNextView(value: boolean) {
      state.failNextView = value;
    },
  };
}

function modelNamespace(initialEvent = false): unknown {
  return {
    model: MODEL_IR,
    create: (context: { readonly events: Record<string, { fire(value: unknown): void }> }) => {
      let on = false;
      if (initialEvent) {
        // Factory-phase event: it must reach factories that subscribed before the model existed.
        context.events['onDidChange']?.fire(true);
      }
      return {
        methods: {
          setOn(value: boolean) {
            on = value;
            context.events['onDidChange']?.fire(on);
            return null;
          },
          getOn() {
            return on;
          },
        },
        sync() {},
        dispose() {},
      };
    },
  };
}

function surfaceSpy(width: number, height: number): SurfaceSpy {
  const calls: string[] = [];
  const context = {
    save() {
      calls.push('save');
    },
    restore() {
      calls.push('restore');
    },
    clearRect(_x: number, _y: number, w: number, h: number) {
      calls.push(`clear:${w}x${h}`);
    },
    setTransform(a: number, _b: number, _c: number, _d: number, e: number, f: number) {
      calls.push(`transform:${a},${e},${f}`);
    },
  } as unknown as OffscreenCanvasRenderingContext2D;
  return {
    width,
    height,
    calls,
    getContext: () => context,
    // A plain object stands in for the bitmap: the host transfers a real ImageBitmap only.
    transferToImageBitmap: () => ({ width, height }) as unknown as ImageBitmap,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function start(
  options: {
    readonly mode?: 'edit' | 'run';
    readonly bench?: Workbench;
    readonly frames?: IFusedOverlayFrame[];
    readonly diagnostics?: unknown[];
  } = {},
): Promise<{ runtime: IFusedRuntime; bench: Workbench }> {
  const bench = options.bench ?? workbench();
  const { document, registry } = await fixture();
  const runtime = await createFusedRuntime({
    document,
    registry,
    step: STEP,
    mode: options.mode ?? 'edit',
    workers: bench.workers,
    onOverlay: (frame) => options.frames?.push(frame),
    onDiagnostic: (entry) => options.diagnostics?.push(entry),
  });
  cleanups.push(() => runtime.dispose());
  return { runtime, bench };
}

describe('fused wire hooks', () => {
  it('transfers a real overlay bitmap and leaves other members alone', () => {
    class FakeBitmap {
      close(): void {}
    }
    const scope = globalThis as { ImageBitmap?: unknown };
    const original = scope.ImageBitmap;
    scope.ImageBitmap = FakeBitmap;
    try {
      const bitmap = new FakeBitmap();
      expect(transferOverlayFrame('render', { bitmap })).toEqual([bitmap]);
      expect(transferOverlayFrame('prepare', { bitmap })).toEqual([]);
      expect(transferOverlayFrame('render', undefined)).toEqual([]);
    } finally {
      if (original === undefined) delete scope.ImageBitmap;
      else scope.ImageBitmap = original;
    }
  });

  it('transfers only the buffers the host copied', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(transferResourceBytes('readResource', bytes)).toEqual([bytes.buffer]);
    expect(transferResourceBytes('read', bytes)).toEqual([]);
    expect(transferResourceBytes('readResource', bytes.subarray(1))).toEqual([]);
  });
});
describe('fused runtime bridge', () => {
  it.each(['edit', 'run'] as const)(
    'keeps geometry-only devices available without a presentation error in %s mode',
    async (mode) => {
      const data = await fixture({ ...MANIFEST, view2d: { geometry: GEOMETRY } });
      const bench = workbench();
      const diagnostics: string[] = [];
      const runtime = await createFusedRuntime({
        ...data,
        step: STEP,
        mode,
        workers: bench.workers,
        onDiagnostic: (entry) => diagnostics.push(entry.code),
      });
      cleanups.push(() => runtime.dispose());

      expect(runtime.display.instances[0]?.geometry).toEqual(GEOMETRY);
      expect(bench.views).toHaveLength(0);
      expect(diagnostics).toEqual([]);
      if (mode === 'run') {
        const model = runtime.getModel(INSTANCE_ID);
        await model.methods['setOn']!(true);
        expect(await model.methods['getOn']!(null)).toBe(true);
      }
    },
  );

  it('prepares the edit presentation without any model', async () => {
    const { runtime, bench } = await start({ mode: 'edit' });

    expect(runtime.getState()).toEqual({ status: 'idle', simTime: 0 });
    expect(runtime.display.mode).toBe('edit');
    expect(runtime.display.instances.map((entry) => entry.instanceId)).toEqual([INSTANCE_ID]);
    const instance = runtime.display.instances[0]!;
    expect(instance.props).toEqual({ label: 'lamp' });
    expect(instance.geometry.bounds.width).toBe(8);
    expect(instance.view).toBe('view.js');
    expect(instance.methods).toEqual(['setOn', 'getOn']);
    expect(instance.events).toEqual(['onDidChange']);

    expect(bench.views).toHaveLength(1);
    expect(bench.views[0]!.context.mode).toBe('edit');
    expect(bench.views[0]!.context.model).toBeUndefined();

    await expect(runtime.resume()).rejects.toMatchObject({
      code: 'runtime/unavailable-state',
    });
    expect(() => runtime.getModel(INSTANCE_ID)).toThrowError(/not in run mode/);
  });

  it('resolves a geometry file reference before preparing the presentation', async () => {
    const manifest: UnifiedDeviceManifest = {
      ...MANIFEST,
      view2d: { geometry: 'views/geometry.json', entry: 'view.js' },
    };
    const { document, registry } = await fixture(manifest, {
      'views/geometry.json': JSON.stringify(GEOMETRY),
    });
    const bench = workbench();
    const runtime = await createFusedRuntime({
      document,
      registry,
      step: STEP,
      mode: 'edit',
      workers: bench.workers,
    });
    cleanups.push(() => runtime.dispose());

    const instance = runtime.display.instances[0]!;
    expect(instance.geometry.bounds).toEqual({ x: -1, y: -1, width: 8, height: 8 });
    expect(instance.view).toBe('view.js');
    expect(bench.views[0]!.context.geometry.bounds.width).toBe(8);
  });
  it('mounts models and drives them from the editor and from the presentation', async () => {
    const { runtime, bench } = await start({ mode: 'run' });

    // A run session starts advancing as soon as the presentations subscribed.
    expect(runtime.getState().status).toBe('running');
    expect(runtime.getState().simTime).toBeGreaterThanOrEqual(STEP);
    const view = bench.views[0]!;
    expect(view.context.mode).toBe('run');
    const displayModel = view.context.model;
    expect(displayModel).toBeDefined();

    const hostModel = runtime.getModel(INSTANCE_ID);
    const hostEvents: Value[] = [];
    const subscription = hostModel.events['onDidChange']!((event) => hostEvents.push(event.value));
    cleanups.push(() => subscription.dispose());

    await hostModel.methods['setOn']!(true);
    expect(await hostModel.methods['getOn']!(null)).toBe(true);
    await waitFor(() => hostEvents.includes(true));

    await displayModel!.methods['setOn']!(false);
    expect(view.events).toContain(false);

    runtime.display.input(INSTANCE_ID, {
      type: 'pointerdown',
      position: { x: 1, y: 2 },
      button: 0,
      buttons: 1,
    });
    await waitFor(() => view.inputs.length === 1);
    await waitFor(() => hostEvents.includes(true));
    expect(await hostModel.methods['getOn']!(null)).toBe(true);

    runtime.pause();
    await waitFor(() => runtime.getState().status === 'paused');
    await runtime.step();
    expect(runtime.getState().status).toBe('paused');
  });

  it('renders overlays in edit mode without a model', async () => {
    const frames: IFusedOverlayFrame[] = [];
    const { runtime, bench } = await start({ mode: 'edit', frames });

    const frame = await runtime.display.render(INSTANCE_ID, { width: 8, height: 8, scale: 1 });
    expect(frame).toMatchObject({ instanceId: INSTANCE_ID, generation: 1 });
    expect(frames).toHaveLength(1);
    expect(bench.views[0]!.context.model).toBeUndefined();
    expect(bench.views[0]!.renders).toBe(1);
  });

  it('renders overlays with the local transform and drops superseded frames', async () => {
    const frames: IFusedOverlayFrame[] = [];
    const { runtime, bench } = await start({ mode: 'run', frames });

    const frame = await runtime.display.render(INSTANCE_ID, {
      width: 16,
      height: 16,
      scale: 2,
    });
    expect(frame).toMatchObject({
      instanceId: INSTANCE_ID,
      width: 16,
      height: 16,
      scale: 2,
      generation: 1,
    });
    expect(frames).toHaveLength(1);
    const calls = bench.surfaces[0]!.calls;
    expect(calls).toContain('save');
    expect(calls).toContain('clear:16x16');
    // Local origin (-1, -1) at two device pixels per unit.
    expect(calls).toContain('transform:2,2,2');
    expect(calls).toContain('restore');

    const [superseded, latest] = await Promise.all([
      runtime.display.render(INSTANCE_ID, { width: 16, height: 16, scale: 2 }),
      runtime.display.render(INSTANCE_ID, { width: 16, height: 16, scale: 2 }),
    ]);
    expect(superseded).toBeUndefined();
    expect(latest?.generation).toBe(3);
    expect(frames.map((entry) => entry.generation)).toEqual([1, 3]);
  });

  it('repaints when a presentation asks for it', async () => {
    const frames: IFusedOverlayFrame[] = [];
    const bench = workbench();
    const view = bench.workers.createDisplayWorker;
    await start({ mode: 'run', bench, frames });
    expect(view).toBeDefined();

    const spy = bench.views[0]!;
    spy.context.invalidate();
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.instanceId).toBe(INSTANCE_ID);
  });

  it('switches modes by releasing and rebuilding models and presentations', async () => {
    const { runtime, bench } = await start({ mode: 'run' });
    expect(runtime.display.instances).toHaveLength(1);

    await runtime.prepareDisplay({ mode: 'edit' });
    expect(runtime.display.mode).toBe('edit');
    expect(runtime.getState()).toEqual({ status: 'idle', simTime: 0 });
    expect(bench.views[0]!.disposed).toBe(true);
    expect(bench.views[1]!.context.model).toBeUndefined();
    expect(() => runtime.getModel(INSTANCE_ID)).toThrowError(/not in run mode/);

    await runtime.prepareDisplay({ mode: 'run' });
    expect(runtime.display.mode).toBe('run');
    expect(bench.views[2]!.context.model).toBeDefined();
    expect(runtime.display.instances.map((entry) => entry.instanceId)).toEqual([INSTANCE_ID]);
  });

  it('verifies packages and mounts models without WebCrypto, as in the sandbox', async () => {
    // Digests of the fixture are computed with the real WebCrypto before the sandbox condition.
    const { document, registry } = await fixture();
    const bench = workbench();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // An opaque-origin sandbox worker exposes no `crypto.subtle` at all.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const runtime = await createFusedRuntime({
        document,
        registry,
        step: STEP,
        mode: 'run',
        workers: bench.workers,
      });
      cleanups.push(() => runtime.dispose());

      expect(runtime.display.instances).toHaveLength(1);
      expect(runtime.getState().status).toBe('running');
      const model = runtime.getModel(INSTANCE_ID);
      await model.methods['setOn']!(true);
      expect(await model.methods['getOn']!(null)).toBe(true);
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as { crypto?: unknown }).crypto;
      } else {
        Object.defineProperty(globalThis, 'crypto', descriptor);
      }
    }
  });

  it('delivers initial model events to factory subscriptions before initialize', async () => {
    const bench = workbench({ initialEvent: true });
    const { runtime } = await start({ mode: 'run', bench });

    expect(runtime.getState().status).toBe('running');
    const view = bench.views[0]!;
    // The subscription was registered by the factory, before the models existed.
    expect(view.events).toEqual([true]);
    // Initial events precede the author initialize hook (RFC 0025 startup barrier).
    expect(view.trace).toEqual(['event:true', 'initialize']);
  });

  it('rebuilds models and presentation on reset', async () => {
    const { runtime, bench } = await start({ mode: 'run' });
    const model = runtime.getModel(INSTANCE_ID);
    await model.methods['setOn']!(true);
    expect(await model.methods['getOn']!(null)).toBe(true);

    await runtime.reset();

    expect(bench.views[0]!.disposed).toBe(true);
    expect(bench.views).toHaveLength(2);
    expect(bench.views[1]!.context.model).toBeDefined();
    expect(await runtime.getModel(INSTANCE_ID).methods['getOn']!(null)).toBe(false);
    expect(runtime.getState().status).toBe('running');
  });
  it('contains a broken presentation as a diagnostic', async () => {
    const diagnostics: Array<{ code: string; instanceId?: string }> = [];
    const bench = workbench();
    bench.failNextView = true;
    const { document, registry } = await fixture();
    const runtime = await createFusedRuntime({
      document,
      registry,
      step: STEP,
      mode: 'edit',
      workers: bench.workers,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    cleanups.push(() => runtime.dispose());

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'runtime/presentation-failed', instanceId: INSTANCE_ID }),
    );
    expect(bench.views).toHaveLength(0);
    expect(runtime.display.instances).toHaveLength(1);
    expect(
      await runtime.display.render(INSTANCE_ID, { width: 8, height: 8, scale: 1 }),
    ).toBeUndefined();
  });

  it('releases both workers once and rejects late calls', async () => {
    const { runtime, bench } = await start({ mode: 'run' });
    const model: IFusedModelClient = runtime.getModel(INSTANCE_ID);

    await runtime.dispose();
    await runtime.dispose();

    expect(bench.terminated).toEqual({ simulation: 1, display: 1 });
    expect(bench.views[0]!.disposed).toBe(true);
    await expect(runtime.step()).rejects.toMatchObject({
      code: 'runtime/unavailable-state',
    });
    await expect(model.methods['getOn']!(null)).rejects.toMatchObject({
      code: 'model/disconnected',
    });
  });
});
