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

const ASSET_ROOT = 'runtime-demo';
const COMPONENT_ROOT = 'components';

interface IDemoAsset {
  readonly metadata: string;
  readonly code: string;
}

function componentAssets(
  category: 'devices' | 'widgets',
  ids: readonly string[],
): Readonly<Record<string, IDemoAsset>> {
  const kind = category === 'devices' ? 'device' : 'widget';
  return Object.fromEntries(
    ids.map((id) => [
      `demo:${id}`,
      {
        metadata: `${COMPONENT_ROOT}/${category}/${id}/${kind}.json`,
        code: `${COMPONENT_ROOT}/${category}/${id}/${kind}.js`,
      },
    ]),
  );
}

const DEVICE_ASSETS = componentAssets('devices', ['resistor', 'push-button', 'led', 'voltmeter']);
const WIDGET_ASSETS = componentAssets('widgets', ['button', 'led-indicator', 'voltmeter']);

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
    validateMetadata(definition, 'device', id.slice('demo:'.length));
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
    validateMetadata(definition, 'widget', id.slice('demo:'.length));
    return { definition, code };
  },
};

/** Reads current host snapshots when switching between document editors. */
export function createDemoFileSystem(
  snapshots: () => readonly DemoSnapshot[],
): IFileSystemProvider {
  return {
    async read(uri) {
      const snapshot = snapshots().find(
        (entry) => uri === assetUri(`${ASSET_ROOT}/${demoFileName(entry)}`),
      );
      return snapshot === undefined
        ? demoFileSystem.read(uri)
        : new TextEncoder().encode(serializeDemoSnapshot(snapshot));
    },
  };
}

export interface IDemoLoadedDocument {
  readonly uri: string;
  readonly snapshot: DemoSnapshot;
}

export type DemoSnapshot =
  | { readonly kind: 'canvas'; readonly document: CanvasDocument }
  | { readonly kind: 'schematic'; readonly document: SchematicDocument };

/** Reads and parses the initial snapshot the app keeps for its own download action. */
export async function loadDemoDocument(
  kind: DemoDocumentKind,
  fileSystem: IFileSystemProvider = demoFileSystem,
): Promise<IDemoLoadedDocument> {
  const path = kind === 'canvas' ? `${ASSET_ROOT}/example.cnv` : `${ASSET_ROOT}/example.sch`;
  const uri = assetUri(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await fileSystem.read(uri));
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
