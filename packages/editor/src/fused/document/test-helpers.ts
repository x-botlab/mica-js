/**
 * Fixtures for the fused document session tests: in-memory files, locked packages and a mutable
 * access policy. Nothing here is shipped code; the module is not a test file so it can be shared.
 */
import { createHash } from 'node:crypto';
import { parseFusedDocument } from '@mica-js/document/fused';
import { Emitter } from '@mica-js/core/lifecycle';
import type { Event } from '@mica-js/core/lifecycle';
import type {
  DeviceLock,
  DeviceRegistry,
  FusedDocument,
  Geometry2D,
  PackageFiles,
  UnifiedDeviceManifest,
} from '@mica-js/document/fused';
import type {
  AccessDecision,
  IDeviceProvider,
  IDocumentAccess,
  IDocumentAccessContext,
  IDeviceAdditionContext,
  IWorkbenchAccessProvider,
} from '../providers';
import type { IFusedDocumentSessionOptions } from './session';

export const LED = 'demo:led';
export const SWITCH = 'demo:switch';
export const LABEL = 'demo:label';
export const FLEX = 'demo:flex';

export const URI = 'workspace://root/board.sch';

type Pins = Geometry2D['pins'];

function geometry(pins: Pins, sizing: Geometry2D['sizing'] = 'physical'): Geometry2D {
  return {
    sizing,
    bounds: { x: -6, y: -4, width: 12, height: 8 },
    bodyBounds: { x: -5, y: -3, width: 10, height: 6 },
    bodyImage: 'art/body.png',
    pins,
  };
}

const BODY_FILES = { 'art/body.png': 'png-bytes' } as const;

export const LED_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'led',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Demo LED',
  designatorPrefix: 'D',
  pins: { anode: {}, cathode: {} },
  properties: { forwardResistance: { type: 'number', default: 500, exclusiveMin: 0 } },
  model: { entry: 'model.js' },
  view: { panel: { title: 'Panel', entry: 'ui/panel.html' } },
  view2d: {
    geometry: geometry({
      anode: { position: { x: -6, y: 0 }, outward: { x: -1, y: 0 } },
      cathode: { position: { x: 6, y: 0 }, outward: { x: 1, y: 0 } },
    }),
  },
};

export const SWITCH_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'switch',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Demo switch',
  designatorPrefix: 'S',
  pins: { a: {}, b: {} },
  model: { entry: 'model.js' },
  view2d: {
    geometry: geometry({
      a: { position: { x: -6, y: 0 }, outward: { x: -1, y: 0 } },
      b: { position: { x: 6, y: 0 }, outward: { x: 1, y: 0 } },
    }),
  },
};

export const LABEL_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'label',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Demo label',
  view2d: {
    geometry: {
      sizing: 'flexible',
      bounds: { x: 0, y: 0, width: 10, height: 4 },
      bodyBounds: { x: 0, y: 0, width: 10, height: 4 },
      pins: {},
    },
  },
};

export const FLEX_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'flex',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Demo flex',
  designatorPrefix: 'X',
  pins: {},
  view2d: {
    geometry: {
      sizing: 'flexible',
      bounds: { x: 0, y: 0, width: 10, height: 4 },
      bodyBounds: { x: 0, y: 0, width: 10, height: 4 },
      pins: {},
    },
  },
};

export const LED_V2_MANIFEST: UnifiedDeviceManifest = { ...LED_MANIFEST, version: '2.0.0' };

/** Flexible display object whose geometry lives in a declared package file. */
export const FILE_GEOMETRY_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'drawing',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Demo drawing',
  view2d: { geometry: 'art/geometry.json' },
};

export const FILE_GEOMETRY = JSON.stringify({
  sizing: 'flexible',
  bounds: { x: 0, y: 0, width: 8, height: 8 },
  bodyBounds: { x: 0, y: 0, width: 8, height: 8 },
  pins: {},
});

/** Declares a body image the release does not list. */
export const MISSING_IMAGE_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'broken',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Broken body',
  view2d: {
    geometry: {
      sizing: 'flexible',
      bounds: { x: 0, y: 0, width: 8, height: 8 },
      bodyBounds: { x: 0, y: 0, width: 8, height: 8 },
      bodyImage: 'art/missing.png',
      pins: {},
    },
  },
};

/** Declares no 2D geometry at all, so it cannot be placed. */
export const NO_GEOMETRY_MANIFEST: UnifiedDeviceManifest = {
  publisher: 'demo',
  name: 'headless',
  version: '1.0.0',
  engines: { mica: '^1.0.0' },
  displayName: 'Headless only',
};

const PANEL_FILES = { 'ui/panel.html': '<!doctype html><p>panel</p>' } as const;

export interface ITestPackage {
  readonly manifest: UnifiedDeviceManifest;
  readonly files?: Readonly<Record<string, string>>;
}

export interface ITestPackages {
  readonly registry: IDeviceProvider;
  /** Lock of one registered release, with the JCS release identity of RFC 0020. */
  lock(manifest: UnifiedDeviceManifest): DeviceLock;
  readonly counters: { opens: number; reads: number };
}

function packageBytes(
  manifest: UnifiedDeviceManifest,
  files: Readonly<Record<string, string>> = {},
): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  for (const [path, content] of Object.entries(files)) {
    entries[path] = new TextEncoder().encode(content);
  }
  return entries;
}

function fileTable(
  files: Readonly<Record<string, Uint8Array>>,
): Record<string, { size: number; integrity: string }> {
  const table: Record<string, { size: number; integrity: string }> = {};
  for (const [path, bytes] of Object.entries(files)) {
    table[path] = {
      size: bytes.length,
      integrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  }
  return table;
}

export function canonicalJson(value: unknown): string {
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
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function createPackages(entries: readonly ITestPackage[]): ITestPackages {
  const counters = { opens: 0, reads: 0 };
  const stored = new Map<string, Record<string, Uint8Array>>();
  const locks = new Map<string, DeviceLock>();
  for (const entry of entries) {
    const manifest = entry.manifest;
    const id = `${manifest.publisher}:${manifest.name}`;
    const key = `${id}@${manifest.version}`;
    const files = packageBytes(manifest, entry.files ?? {});
    stored.set(key, files);
    locks.set(
      key,
      Object.freeze({
        id,
        version: manifest.version,
        integrity: sha256(
          canonicalJson({ id, version: manifest.version, files: fileTable(files) }),
        ),
      }),
    );
  }
  const registry: DeviceRegistry = {
    async open(lock): Promise<PackageFiles> {
      counters.opens += 1;
      const files = stored.get(`${lock.id}@${lock.version}`);
      if (files === undefined) {
        throw new Error(`unknown release ${lock.id}@${lock.version}`);
      }
      return {
        lock,
        files: fileTable(files),
        read: async (path: string) => {
          counters.reads += 1;
          const bytes = files[path];
          if (bytes === undefined) {
            throw new Error(`unknown file ${path}`);
          }
          return bytes.slice();
        },
      };
    },
  };
  return {
    registry,
    counters,
    lock(manifest: UnifiedDeviceManifest): DeviceLock {
      const id = `${manifest.publisher}:${manifest.name}`;
      const lock = locks.get(`${id}@${manifest.version}`);
      if (lock === undefined) {
        throw new Error(`release ${id}@${manifest.version} is not registered`);
      }
      return lock;
    },
  };
}

/** Default fixture: LED, switch, flexible label, a second LED release and the panel entry. */
export function defaultPackages(): ITestPackages {
  return createPackages([
    { manifest: LED_MANIFEST, files: { ...BODY_FILES, ...PANEL_FILES } },
    { manifest: LED_V2_MANIFEST, files: BODY_FILES },
    { manifest: SWITCH_MANIFEST, files: BODY_FILES },
    { manifest: LABEL_MANIFEST },
    { manifest: FLEX_MANIFEST },
    { manifest: FILE_GEOMETRY_MANIFEST, files: { 'art/geometry.json': FILE_GEOMETRY } },
    { manifest: MISSING_IMAGE_MANIFEST },
    { manifest: NO_GEOMETRY_MANIFEST },
  ]);
}

/** In-memory host files; `writeGate` delays the next saves so races can be observed. */
export class MemoryFiles {
  readonly contents = new Map<string, Uint8Array>();
  readonly writes: { readonly uri: string; readonly text: string }[] = [];
  writeGate: Promise<void> | undefined;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [uri, text] of Object.entries(initial)) {
      this.contents.set(uri, new TextEncoder().encode(text));
    }
  }

  async read(uri: string): Promise<Uint8Array> {
    const bytes = this.contents.get(uri);
    if (bytes === undefined) {
      throw new Error(`File not found: ${uri}`);
    }
    return bytes.slice();
  }

  async write(uri: string, data: Uint8Array): Promise<void> {
    const gate = this.writeGate;
    if (gate !== undefined) {
      this.writeGate = undefined;
      await gate;
    }
    const text = new TextDecoder().decode(data);
    this.contents.set(uri, data.slice());
    this.writes.push({ uri, text });
  }

  text(uri: string): string | undefined {
    const bytes = this.contents.get(uri);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
}

export interface ITestAccessOptions {
  readonly edit?: AccessDecision;
  readonly run?: AccessDecision;
  readonly add?: AccessDecision;
}

/** Mutable access policy that records every evaluation. */
export class TestAccessProvider implements IWorkbenchAccessProvider {
  readonly #changes = new Emitter<void>();
  readonly onDidChange: Event<void> = this.#changes.event;
  readonly evaluations: IDocumentAccessContext[] = [];
  readonly additions: IDeviceAdditionContext[] = [];
  #edit: AccessDecision;
  #run: AccessDecision;
  #add: AccessDecision;
  evaluate: ((context: IDocumentAccessContext) => Promise<IDocumentAccess>) | undefined;
  canAdd: ((context: IDeviceAdditionContext) => Promise<AccessDecision>) | undefined;

  constructor(options: ITestAccessOptions = {}) {
    this.#edit = options.edit ?? ALLOW;
    this.#run = options.run ?? ALLOW;
    this.#add = options.add ?? ALLOW;
  }

  async evaluateDocument(context: IDocumentAccessContext): Promise<IDocumentAccess> {
    this.evaluations.push(context);
    if (this.evaluate !== undefined) {
      return this.evaluate(context);
    }
    return { edit: this.#edit, run: this.#run };
  }

  async canAddDevice(context: IDeviceAdditionContext): Promise<AccessDecision> {
    this.additions.push(context);
    if (this.canAdd !== undefined) {
      return this.canAdd(context);
    }
    return this.#add;
  }

  /** Decisions currently in force, without evaluating anything. */
  current(): IDocumentAccess {
    return { edit: this.#edit, run: this.#run };
  }

  /** Changes the decisions without notifying the session, to model an in-flight policy change. */
  setSilent(decisions: { readonly edit?: AccessDecision; readonly run?: AccessDecision }): void {
    this.#edit = decisions.edit ?? this.#edit;
    this.#run = decisions.run ?? this.#run;
  }

  set(decisions: { readonly edit?: AccessDecision; readonly run?: AccessDecision }): void {
    this.#edit = decisions.edit ?? this.#edit;
    this.#run = decisions.run ?? this.#run;
    this.#changes.fire();
  }

  setAdd(decision: AccessDecision): void {
    this.#add = decision;
    this.#changes.fire();
  }

  dispose(): void {
    this.#changes.dispose();
  }
}

export const ALLOW: AccessDecision = Object.freeze({ allowed: true });
export function denied(code: string, message = code): AccessDecision {
  return { allowed: false, code, message };
}

export function emptyDocument(): FusedDocument {
  return {
    version: 2,
    dependencies: {},
    instances: [],
    nodes: [],
    wires: [],
    labels: [],
    references: [],
  };
}

export interface IBenchOptions {
  readonly document?: FusedDocument;
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly historyLimit?: number;
  readonly packages?: ITestPackages;
  readonly access?: TestAccessProvider;
  readonly createId?: () => string;
}

export interface IBench {
  readonly uri: string;
  readonly files: MemoryFiles;
  readonly packages: ITestPackages;
  readonly access: TestAccessProvider;
  options(): IFusedDocumentSessionOptions;
  /** Rewrites the stored document text without touching the open session. */
  store(document: FusedDocument): void;
}

export function createBench(options: IBenchOptions = {}): IBench {
  const files = new MemoryFiles(options.extraFiles ?? {});
  const packages = options.packages ?? defaultPackages();
  const access = options.access ?? new TestAccessProvider();
  const document = options.document ?? emptyDocument();
  files.contents.set(URI, new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`));
  return {
    uri: URI,
    files,
    packages,
    access,
    options: () => ({
      document: parseFusedDocument(files.text(URI)),
      saveDocument: async (value) =>
        files.write(URI, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)),
      devices: packages.registry,
      access,
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
    }),
    store(next) {
      files.contents.set(URI, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`));
    },
  };
}

/** Document with two connected instances, a label and a voltage reference. */
export function connectedDocument(packages: ITestPackages): FusedDocument {
  const led = packages.lock(LED_MANIFEST);
  const sw = packages.lock(SWITCH_MANIFEST);
  return {
    version: 2,
    dependencies: {
      [led.id]: { version: led.version, integrity: led.integrity },
      [sw.id]: { version: sw.version, integrity: sw.integrity },
    },
    instances: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        device: LED,
        designator: 'D1',
        placement: { x: 20, y: 10, rotation: 0 },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        device: SWITCH,
        designator: 'S1',
        placement: { x: 50, y: 10, rotation: 0 },
      },
    ],
    nodes: [],
    wires: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        from: {
          kind: 'pin',
          instance: '11111111-1111-4111-8111-111111111111',
          pin: 'anode',
        },
        to: { kind: 'pin', instance: '22222222-2222-4222-8222-222222222222', pin: 'a' },
        bends: [{ x: 35, y: 10 }],
      },
    ],
    labels: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        target: {
          kind: 'pin',
          instance: '11111111-1111-4111-8111-111111111111',
          pin: 'anode',
        },
        name: 'VCC',
      },
    ],
    references: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        target: {
          kind: 'pin',
          instance: '22222222-2222-4222-8222-222222222222',
          pin: 'b',
        },
        voltage: 0,
        symbol: 'ground',
      },
    ],
  };
}
