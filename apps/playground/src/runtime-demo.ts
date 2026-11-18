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

/** 主页面文档选择器的一项；`path` 相对站点根，由宿主按自身规则解析。 */
export interface IDemoDocument {
  readonly id: string;
  readonly kind: DemoDocumentKind;
  readonly label: string;
  readonly path: string;
  /** 仿真步长与目标帧间隔（ms）；按文档需要配置。 */
  readonly stepMs?: number;
  readonly execution?: 'throughput' | 'precise';
}

export const DEMO_DOCUMENTS: readonly IDemoDocument[] = [
  {
    id: 'example-canvas',
    kind: 'canvas',
    label: '画布 · example.cnv',
    path: 'runtime-demo/example.cnv',
  },
  {
    id: 'example-schematic',
    kind: 'schematic',
    label: '原理图 · example.sch',
    path: 'runtime-demo/example.sch',
  },
];

export function demoDocument(id: string): IDemoDocument {
  return DEMO_DOCUMENTS.find((candidate) => candidate.id === id) ?? DEMO_DOCUMENTS[0]!;
}

const COMPONENT_ROOT = 'components';
/**
 * The old CT107D v1 widget canvas was removed from this playground. It depended on legacy
 * `device.json/device.js` assets that the unified device packages do not provide; the
 * formal CT107D host is `examples/ct107d` (`pnpm run workbench:dev`), not this app.
 */

interface IDemoAsset {
  readonly metadata: string;
  readonly code: string;
}

function componentAssets(
  category: 'devices' | 'widgets',
  ids: readonly string[],
  prefix = 'demo',
  root = COMPONENT_ROOT,
): Readonly<Record<string, IDemoAsset>> {
  const kind = category === 'devices' ? 'device' : 'widget';
  return Object.fromEntries(
    ids.map((id) => [
      `${prefix}:${id}`,
      {
        metadata: `${root}/${category}/${id}/${kind}.json`,
        code: `${root}/${category}/${id}/${kind}.js`,
      },
    ]),
  );
}

const DEVICE_ASSETS = {
  ...componentAssets('devices', ['resistor', 'push-button', 'led', 'voltmeter']),
};

const WIDGET_ASSETS = {
  ...componentAssets('widgets', ['button', 'led-indicator', 'voltmeter']),
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

const resolvedDevices = new Set<string>();
const deviceResolvedListeners = new Set<(count: number) => void>();

/**
 * 订阅「器件包已解析」的真实读数，供准备状态显示读库进度；返回退订函数。
 *
 * 计数按包去重：同一包被多个文档或 StrictMode 的二次挂载重复解析时不会虚增。
 */
export function onDemoDeviceResolved(listener: (count: number) => void): () => void {
  deviceResolvedListeners.add(listener);
  return () => {
    deviceResolvedListeners.delete(listener);
  };
}

/** 打开新文档时重开读取窗口，下一次读取从 0 开始计数。 */
export function resetDemoDeviceReads(): void {
  resolvedDevices.clear();
}

function noteDeviceResolved(id: string): void {
  if (resolvedDevices.has(id)) return;
  resolvedDevices.add(id);
  for (const listener of deviceResolvedListeners) listener(resolvedDevices.size);
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
    validateMetadata(definition, 'device', id.slice(id.indexOf(':') + 1));
    noteDeviceResolved(id);
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
    validateMetadata(definition, 'widget', id.slice(id.indexOf(':') + 1));
    return { definition, code };
  },
};

/** Reads current host snapshots when switching between document editors. */
export function createDemoFileSystem(
  snapshots: () => readonly IDemoLoadedDocument[],
): IFileSystemProvider {
  return {
    async read(uri) {
      const snapshot = snapshots().find((entry) => uri === entry.uri);
      return snapshot === undefined
        ? demoFileSystem.read(uri)
        : new TextEncoder().encode(serializeDemoSnapshot(snapshot.snapshot));
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
  id: string,
  fileSystem: IFileSystemProvider = demoFileSystem,
): Promise<IDemoLoadedDocument> {
  const descriptor = demoDocument(id);
  const uri = assetUri(descriptor.path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await fileSystem.read(uri));
  return descriptor.kind === 'canvas'
    ? { uri, snapshot: { kind: 'canvas', document: parseCanvas(text) } }
    : { uri, snapshot: { kind: 'schematic', document: parseSchematic(text) } };
}

export function serializeDemoSnapshot(snapshot: DemoSnapshot): string {
  return snapshot.kind === 'canvas'
    ? serializeCanvas(snapshot.document)
    : serializeSchematic(snapshot.document);
}

/** 下载文件名取文档自身的文件名，与选择器里的标签一致。 */
export function demoFileName(id: string): string {
  return demoDocument(id).path.split('/').pop() ?? 'example.cnv';
}
