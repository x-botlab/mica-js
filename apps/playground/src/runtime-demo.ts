import { parseCanvas, serializeCanvas, type CanvasDocument } from '@mica-js/document/canvas';
import {
  parseSchematic,
  serializeSchematic,
  type SchematicDocument,
} from '@mica-js/document/schematic';
import type {
  IDeviceLibrary,
  IFileSystemProvider,
  IWidgetDescription,
  IWidgetLibrary,
} from '@mica-js/editor';
import { validateMetadata, type DeviceMetadata } from '@mica-js/sdk/metadata';

export type DemoDocumentKind = 'schematic' | 'canvas';

/** Full IDs shared by the fixtures and the libraries; documents only ever name these IDs. */
export const DEMO_ECHO_DEVICE = 'demo:echo';
export const DEMO_BUTTON_WIDGET = 'demo:button';
export const DEMO_INDICATOR_WIDGET = 'demo:indicator';

const ASSET_ROOT = 'runtime-demo';

interface IDemoAsset {
  readonly metadata: string;
  readonly code: string;
}

const DEVICE_ASSETS: Readonly<Record<string, IDemoAsset>> = {
  [DEMO_ECHO_DEVICE]: { metadata: `${ASSET_ROOT}/device.json`, code: `${ASSET_ROOT}/device.js` },
};

const WIDGET_ASSETS: Readonly<Record<string, IDemoAsset>> = {
  [DEMO_BUTTON_WIDGET]: { metadata: `${ASSET_ROOT}/button.json`, code: `${ASSET_ROOT}/button.js` },
  [DEMO_INDICATOR_WIDGET]: {
    metadata: `${ASSET_ROOT}/indicator.json`,
    code: `${ASSET_ROOT}/indicator.js`,
  },
};

function assetUri(path: string): string {
  return new URL(path, globalThis.document.baseURI).href;
}

/** Fetch-backed read-only file system; the editor never receives a write capability. */
export const demoFileSystem: IFileSystemProvider = {
  async read(uri) {
    const response = await fetch(uri);
    if (!response.ok) {
      const path = new URL(uri).pathname;
      throw new Error(`读取 ${path} 失败（HTTP ${response.status}）`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

async function readText(path: string): Promise<string> {
  const bytes = await demoFileSystem.read(assetUri(path));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readDefinition<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

/** Metadata plus self-contained ESM source, resolved by full ID without touching the code. */
export const demoDeviceLibrary: IDeviceLibrary = {
  async resolve(id) {
    const asset = DEVICE_ASSETS[id];
    if (asset === undefined) return undefined;
    const [definition, code] = await Promise.all([
      readDefinition<unknown>(asset.metadata),
      readText(asset.code),
    ]);
    validateMetadata(definition, 'device', 'echo');
    return { definition: definition as DeviceMetadata, code };
  },
};

export const demoWidgetLibrary: IWidgetLibrary = {
  async resolve(id) {
    const asset = WIDGET_ASSETS[id];
    if (asset === undefined) return undefined;
    const [definition, code] = await Promise.all([
      readDefinition<IWidgetDescription['definition']>(asset.metadata),
      readText(asset.code),
    ]);
    return { definition, code };
  },
};

export interface IDemoLoadedDocument {
  readonly uri: string;
  readonly snapshot: DemoSnapshot;
}

export type DemoSnapshot =
  | { readonly kind: 'canvas'; readonly document: CanvasDocument }
  | { readonly kind: 'schematic'; readonly document: SchematicDocument };

/** Reads and parses the initial snapshot the app keeps for its own download action. */
export async function loadDemoDocument(kind: DemoDocumentKind): Promise<IDemoLoadedDocument> {
  const path = kind === 'canvas' ? `${ASSET_ROOT}/example.cnv` : `${ASSET_ROOT}/example.sch`;
  const uri = assetUri(path);
  const text = await readText(path);
  return kind === 'canvas'
    ? { uri, snapshot: { kind, document: parseCanvas(text) } }
    : { uri, snapshot: { kind, document: parseSchematic(text) } };
}

export function serializeDemoSnapshot(snapshot: DemoSnapshot): string {
  return snapshot.kind === 'canvas'
    ? serializeCanvas(snapshot.document)
    : serializeSchematic(snapshot.document);
}

export function demoFileName(snapshot: DemoSnapshot): string {
  return snapshot.kind === 'canvas' ? 'example.cnv' : 'example.sch';
}
