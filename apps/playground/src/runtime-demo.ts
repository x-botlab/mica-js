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
  /**
   * 仿真步长（ms）。8051 板按指令推进，步长越大每个 UI 帧要跑的指令越多；
   * CT107D 需要更细的步长才能在预览里看到扫描与走马灯。
   */
  readonly stepMs?: number;
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
  {
    id: 'ct107d-canvas',
    kind: 'canvas',
    label: '画布 · ct107d.cnv',
    path: 'components/ct107d/ct107d.cnv',
    stepMs: 2,
  },
];

export function demoDocument(id: string): IDemoDocument {
  return DEMO_DOCUMENTS.find((candidate) => candidate.id === id) ?? DEMO_DOCUMENTS[0]!;
}

const COMPONENT_ROOT = 'components';
/** CT107D 示例包的产物由 `scripts/components.mjs` 复制到这里（目录被仓库忽略）。 */
const CT107D_ROOT = `${COMPONENT_ROOT}/ct107d`;

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

/** CT107D 工程使用自己的包 id `xbotlab`，与示例包 `demo` 并行解析。 */
function ct107dAssets(
  category: 'devices' | 'widgets',
  ids: readonly string[],
): Readonly<Record<string, IDemoAsset>> {
  return componentAssets(category, ids, 'xbotlab', CT107D_ROOT);
}

const DEVICE_ASSETS = {
  ...componentAssets('devices', ['resistor', 'push-button', 'led', 'voltmeter']),
  ...ct107dAssets('devices', [
    '74hc02',
    '74hc138',
    '74hc573',
    '74ls04',
    'at24c02',
    'cx20106a',
    'ds1302',
    'ds18b20',
    'lm386',
    'ne555',
    'pcf8591',
    'push-button',
    'uln2003',
    'vs1838',
    'seg4',
    'blue-led',
    'iap15f2k61s2',
  ]),
};

const WIDGET_ASSETS = {
  ...componentAssets('widgets', ['button', 'led-indicator', 'voltmeter']),
  ...ct107dAssets('widgets', ['button', 'segment', 'image', 'led-indicator']),
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
    validateMetadata(definition, 'device', id.slice(id.indexOf(':') + 1));
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
