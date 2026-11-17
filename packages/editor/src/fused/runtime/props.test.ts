import { toTimePs } from '@mica-js/core';
import type {
  DeviceRegistry,
  FusedDocument,
  PropertyValue,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type { MemoryProgram, ProgramFiles, ProgramSources } from '@mica-js/sdk/fused';
import { afterEach, describe, expect, it } from 'vitest';
import { startFusedDisplayGuest } from './display/guest';
import { createFusedRuntime } from './host/runtime';
import type { IFusedRuntime, IFusedWorker, IFusedWorkerFactories } from './host/types';
import type {
  FusedPresentationProps,
  FusedResolvedPresentationProps,
  IFusedFirmwareSnapshot,
} from './protocol';
import { startFusedSimulationGuest } from './simulation/guest';

const DEVICE = 'test:asset';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STEP = toTimePs(1, 'ms');

const BODY_BYTES = [1, 2, 3, 4];
const PROGRAM_BYTES = [0xaa, 0xbb];
const PROJECT_BYTES = [0x10, 0x20, 0x30];

const VIEW_CODE = 'view-entry';
const MODEL_CODE = 'model-entry';

const ASSET_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'test',
  name: 'asset',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Asset device',
  properties: {
    label: { type: 'string', default: 'asset' },
    body: { type: 'image', default: { mode: 'package', src: 'assets/body.png' } },
    program: {
      type: 'firmware',
      default: { mode: 'package', src: 'firmware.bin' },
      addressSpaces: { flash: { start: 0, size: 4096 } },
      addressSpace: 'flash',
      loadAddress: 0,
    },
  },
  pins: {},
  view2d: {
    geometry: {
      sizing: 'flexible',
      bounds: { x: -1, y: -1, width: 8, height: 8 },
      bodyBounds: { x: 0, y: 0, width: 6, height: 6 },
      pins: {},
    },
    entry: 'view.js',
  },
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** JSON Canonicalization Scheme subset: sorted keys, no extra whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest('SHA-256', copy);
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

interface Fixture {
  readonly document: FusedDocument;
  readonly registry: DeviceRegistry;
}

async function fixture(
  overrides: Readonly<Record<string, Readonly<Record<string, PropertyValue>>>> = {},
  manifest: UnifiedDeviceManifest = ASSET_MANIFEST,
): Promise<Fixture> {
  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    'view.js': new TextEncoder().encode(VIEW_CODE),
    'model.js': new TextEncoder().encode(MODEL_CODE),
    'assets/body.png': new Uint8Array(BODY_BYTES),
    'firmware.bin': new Uint8Array(PROGRAM_BYTES),
  };
  const table: Record<string, { size: number; integrity: string }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    table[path] = { size: bytes.length, integrity: await digest(bytes) };
  }
  const integrity = await digest(
    new TextEncoder().encode(
      canonicalJson({ id: DEVICE, version: ASSET_MANIFEST.version, files: table }),
    ),
  );
  const registry: DeviceRegistry = {
    async open(lock) {
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
  return {
    registry,
    document: {
      version: 2,
      dependencies: { [DEVICE]: { version: ASSET_MANIFEST.version, integrity } },
      instances: [
        {
          id: INSTANCE_ID,
          device: DEVICE,
          placement: { x: 0, y: 0, rotation: 0 },
          properties: overrides[INSTANCE_ID] ?? {},
        },
        {
          id: OTHER_ID,
          device: DEVICE,
          placement: { x: 10, y: 0, rotation: 0 },
          properties: overrides[OTHER_ID] ?? {},
        },
      ],
      nodes: [],
      wires: [],
      labels: [],
      references: [],
    },
  };
}

interface CapturedView {
  readonly mode: 'edit' | 'run';
  readonly props: FusedResolvedPresentationProps;
}

function isMessagePort(value: unknown): value is MessagePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { postMessage?: unknown }).postMessage === 'function' &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
  );
}

function worker(start: (port: MessagePort, ports: readonly MessagePort[]) => void): IFusedWorker {
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

function workbench(views: CapturedView[]): IFusedWorkerFactories {
  return {
    createSimulationWorker() {
      return worker((port, ports) => {
        const guest = startFusedSimulationGuest(port, {
          ports,
          importModule: async () => ({ model: MODEL_IR, create: () => emptyModel() }),
        });
        cleanups.push(() => guest.dispose());
      });
    },
    createDisplayWorker() {
      return worker((port, ports) => {
        const guest = startFusedDisplayGuest(port, {
          ports,
          importModule: async () => ({
            default: (context: {
              readonly mode: 'edit' | 'run';
              props: FusedResolvedPresentationProps;
            }) => {
              views.push({ mode: context.mode, props: context.props });
              return { renderOverlay() {} };
            },
          }),
          createSurface: (width, height) => ({
            width,
            height,
            getContext: () => contextStub as unknown as OffscreenCanvasRenderingContext2D,
            transferToImageBitmap: () => ({ width, height }) as unknown as ImageBitmap,
          }),
        });
        cleanups.push(() => guest.dispose());
      });
    },
  };
}

const contextStub = {
  save() {},
  restore() {},
  clearRect() {},
  setTransform() {},
};

const MODEL_IR = { kind: 'device', name: 'Asset', declarations: [] };

function emptyModel(): unknown {
  return { methods: {}, sync() {}, dispose() {} };
}

function firmwareSnapshot(props: FusedPresentationProps, name: string): IFusedFirmwareSnapshot {
  const value = props[name];
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) {
    throw new Error(`property "${name}" is not a firmware snapshot`);
  }
  if (value.kind !== 'firmware') throw new Error(`property "${name}" is not a firmware snapshot`);
  return value;
}

function bytesOf(
  props: FusedPresentationProps | FusedResolvedPresentationProps,
  name: string,
): number[] {
  const value = props[name];
  if (!(value instanceof Uint8Array)) throw new Error(`property "${name}" is not a byte snapshot`);
  return [...value];
}

async function start(
  mode: 'edit' | 'run',
  options: {
    readonly overrides?: Readonly<Record<string, Readonly<Record<string, PropertyValue>>>>;
    readonly programs?: ProgramSources;
    readonly manifest?: UnifiedDeviceManifest;
    readonly diagnostics?: Array<{ code: string; message: string; instanceId?: string }>;
    readonly views?: CapturedView[];
  } = {},
): Promise<IFusedRuntime> {
  const { document, registry } = await fixture(options.overrides, options.manifest);
  const diagnostics = options.diagnostics ?? [];
  const runtime = await createFusedRuntime({
    document,
    registry,
    step: STEP,
    mode,
    workers: workbench(options.views ?? []),
    ...(options.programs === undefined ? {} : { programs: options.programs }),
    onDiagnostic: (entry) => diagnostics.push(entry),
  }).catch((cause) => {
    throw new Error(`${String(cause)}: ${diagnostics.map((entry) => entry.message).join('; ')}`);
  });
  cleanups.push(() => runtime.dispose());
  return runtime;
}

describe('fused presentation props', () => {
  it('passes targeted program sources over RPC and reconstructs independent filesystem snapshots', async () => {
    const views: CapturedView[] = [];
    const calls: unknown[] = [];
    const original = new Uint8Array([65, 66]);
    const manifest: UnifiedDeviceManifest = {
      ...ASSET_MANIFEST,
      properties: {
        scripts: { type: 'program', loader: 'filesystem' },
      },
    };
    const runtime = await start('edit', {
      manifest,
      views,
      overrides: {
        [INSTANCE_ID]: { scripts: { mode: 'project', projectId: 'scripts' } },
        [OTHER_ID]: { scripts: { mode: 'project', projectId: 'code' } },
      },
      programs: {
        projects: {
          select: async () => undefined,
          resolve: async (id, target) => {
            calls.push([id, target]);
            return {
              kind: 'filesystem',
              files:
                id === 'scripts'
                  ? [{ path: 'main.py', data: original }]
                  : [{ path: 'boot.py', data: new Uint8Array() }],
            };
          },
        },
      },
    });
    expect(calls).toEqual([
      ['scripts', { deviceId: DEVICE, property: 'scripts', loader: 'filesystem' }],
      ['code', { deviceId: DEVICE, property: 'scripts', loader: 'filesystem' }],
    ]);
    expect(runtime.display.instances).toHaveLength(2);
    const files = views[0]!.props['scripts'] as ProgramFiles;
    expect(files.paths).toEqual(['main.py']);
    original.fill(0);
    const copy = files.read('main.py').slice();
    copy.fill(0);
    expect([...files.read('main.py')]).toEqual([65, 66]);
    expect((views[1]!.props['scripts'] as ProgramFiles).read('boot.py').length).toBe(0);
    expect(() => files.read('absent')).toThrow();
  });

  it('decodes memory program defaults and reconstructs read-only segments for presentations', async () => {
    const views: CapturedView[] = [];
    await start('edit', {
      views,
      manifest: {
        ...ASSET_MANIFEST,
        properties: {
          program: {
            type: 'program',
            loader: 'memory',
            formats: ['bin'],
            addressSpaces: { flash: { start: 256, size: 1024 } },
            defaults: { addressSpace: 'flash', loadAddress: 256 },
            default: { mode: 'package', src: 'firmware.bin' },
          },
        },
      },
    });
    const program = views[0]!.props['program'] as MemoryProgram;
    expect(program.segments[0]!.address).toBe(256);
    expect([...program.segments[0]!.data]).toEqual(PROGRAM_BYTES);
  });

  it('exposes image and firmware snapshots instead of dropping them', async () => {
    const views: CapturedView[] = [];
    const runtime = await start('edit', { views });
    const instances = runtime.display.instances;
    expect(instances.map((entry) => entry.instanceId)).toEqual([INSTANCE_ID, OTHER_ID]);

    const props = instances[0]!.props;
    expect(props['label']).toBe('asset');
    expect(bytesOf(props, 'body')).toEqual(BODY_BYTES);
    const program = firmwareSnapshot(props, 'program');
    expect(program.segments).toHaveLength(1);
    expect(program.segments[0]!.addressSpace).toBe('flash');
    expect(program.segments[0]!.address).toBe(0);
    expect([...program.segments[0]!.bytes]).toEqual(PROGRAM_BYTES);

    // The presentation worker received the same snapshot, not a stripped copy.
    const view = views.find((entry) => entry.mode === 'edit')!;
    expect(bytesOf(view.props, 'body')).toEqual(BODY_BYTES);
    expect([...(view.props['program'] as MemoryProgram).segments[0]!.data]).toEqual(PROGRAM_BYTES);

    // The RPC transfer hands the guest buffers over; the host snapshot stays readable.
    await runtime.prepareDisplay({ mode: 'edit' });
    const again = runtime.display.instances[0]!.props;
    expect(bytesOf(again, 'body')).toEqual(BODY_BYTES);
    expect((again['body'] as Uint8Array).byteLength).toBe(BODY_BYTES.length);
  });

  it('resolves a host firmware project once and keeps its artifact snapshot', async () => {
    let resolved = 0;
    const projects: NonNullable<ProgramSources['projects']> = {
      async select() {
        return { id: 'board', title: 'Board' };
      },
      async resolve(projectId) {
        resolved += 1;
        expect(projectId).toBe('board');
        return { kind: 'memory', format: 'bin', data: new Uint8Array(PROJECT_BYTES) };
      },
    };
    const runtime = await start('edit', {
      manifest: {
        ...ASSET_MANIFEST,
        properties: {
          program: {
            type: 'program',
            loader: 'memory',
            formats: ['bin'],
            addressSpaces: { flash: { start: 0, size: 4096 } },
            defaults: { addressSpace: 'flash', loadAddress: 0 },
          },
        },
      },
      programs: { projects },
      overrides: { [INSTANCE_ID]: { program: { mode: 'project', projectId: 'board' } } },
    });

    const program = firmwareSnapshot(runtime.display.instances[0]!.props, 'program');
    expect([...program.segments[0]!.bytes]).toEqual(PROJECT_BYTES);
    expect(resolved).toBe(1);

    await runtime.prepareDisplay({ mode: 'edit' });
    expect(resolved).toBe(1);
  });

  it('rejects the presentation that cannot resolve a property', async () => {
    const diagnostics: Array<{ code: string; message: string; instanceId?: string }> = [];
    const runtime = await start('edit', {
      diagnostics,
      overrides: { [INSTANCE_ID]: { program: { mode: 'project', projectId: 'board' } } },
    });

    const failure = diagnostics.find((entry) => entry.code === 'runtime/presentation-failed');
    expect(failure).toBeDefined();
    expect(failure!.instanceId).toBe(INSTANCE_ID);
    expect(failure!.message).toContain('program');
    expect(failure!.message).toContain('firmware');

    // The unusable presentation is rejected; the other instance keeps its view.
    expect(runtime.display.instances.map((entry) => entry.instanceId)).toEqual([OTHER_ID]);
    expect(
      await runtime.display.render(INSTANCE_ID, { width: 8, height: 8, scale: 1 }),
    ).toBeUndefined();
    expect(await runtime.display.render(OTHER_ID, { width: 8, height: 8, scale: 1 })).toBeDefined();
  });
});
