import { toTimePs } from '@mica-js/core';
import type {
  DeviceRegistry,
  FusedDocument,
  PropertyValue,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type { FirmwareProjectSource } from '@mica-js/sdk/fused';
import { afterEach, describe, expect, it } from 'vitest';
import { startFusedDisplayGuest } from './display/guest';
import { createFusedRuntime } from './host/runtime';
import type { IFusedRuntime, IFusedWorker, IFusedWorkerFactories } from './host/types';
import type { FusedPresentationProps, IFusedFirmwareSnapshot } from './protocol';
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
): Promise<Fixture> {
  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(ASSET_MANIFEST, null, 2)),
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
  readonly props: FusedPresentationProps;
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
              props: FusedPresentationProps;
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

function bytesOf(props: FusedPresentationProps, name: string): number[] {
  const value = props[name];
  if (!(value instanceof Uint8Array)) throw new Error(`property "${name}" is not a byte snapshot`);
  return [...value];
}

async function start(
  mode: 'edit' | 'run',
  options: {
    readonly overrides?: Readonly<Record<string, Readonly<Record<string, PropertyValue>>>>;
    readonly projects?: FirmwareProjectSource;
    readonly diagnostics?: Array<{ code: string; message: string; instanceId?: string }>;
    readonly views?: CapturedView[];
  } = {},
): Promise<IFusedRuntime> {
  const { document, registry } = await fixture(options.overrides);
  const runtime = await createFusedRuntime({
    document,
    registry,
    step: STEP,
    mode,
    workers: workbench(options.views ?? []),
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    ...(options.diagnostics === undefined
      ? {}
      : { onDiagnostic: (entry) => options.diagnostics!.push(entry) }),
  });
  cleanups.push(() => runtime.dispose());
  return runtime;
}

describe('fused presentation props', () => {
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
    expect([...firmwareSnapshot(view.props, 'program').segments[0]!.bytes]).toEqual(PROGRAM_BYTES);

    // The RPC transfer hands the guest buffers over; the host snapshot stays readable.
    await runtime.prepareDisplay({ mode: 'edit' });
    const again = runtime.display.instances[0]!.props;
    expect(bytesOf(again, 'body')).toEqual(BODY_BYTES);
    expect((again['body'] as Uint8Array).byteLength).toBe(BODY_BYTES.length);
  });

  it('resolves a host firmware project once and keeps its artifact snapshot', async () => {
    let resolved = 0;
    const projects: FirmwareProjectSource = {
      async list() {
        return [{ id: 'board', title: 'Board' }];
      },
      async resolve(projectId) {
        resolved += 1;
        expect(projectId).toBe('board');
        return { format: 'bin', data: new Uint8Array(PROJECT_BYTES) };
      },
    };
    const runtime = await start('edit', {
      projects,
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
