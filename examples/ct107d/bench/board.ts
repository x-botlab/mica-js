import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deriveSchematicTopology,
  deviceMetadataSymbol,
  parseDeviceMetadata,
  parseSchematic,
} from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceLibraryEntry } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import type { DeviceContext } from '@mica-js/simulator/device';

/**
 * 整板基准夹具：按 `ct107d.sch` 的网表装配 51 颗器件，器件行为来自 `src/devices/`。
 *
 * 与 `verify-schematic.mjs` 的差异只有一处：那里装的是 `dist/devices/<id>/device.js`，
 * 这里像 `test/harness.ts` 一样现场编译 `model.ddl` 并直接装载 `src/devices/<id>/index.ts`。
 * 基准因此不依赖 `mica build`，也不会被并行构建打断。
 */

const PROJECT = join(import.meta.dirname, '..');
const DEVICE_ROOT = join(PROJECT, 'src', 'devices');

export interface Adapter {
  sync(batch: { readonly outputs: Readonly<Record<string, readonly unknown[]>> }): void;
  dispose(): void;
}

/** 单个器件类型的三份产物哈希；聚合值用于比较浏览器侧装载的同一版本。 */
interface DeviceFingerprints {
  readonly model: string;
  readonly code: string;
  readonly definition: string;
}

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: DeviceContext) => Adapter;
  readonly fingerprints: DeviceFingerprints;
}

/**
 * 产物清单：原理图 + 固件 + 按实例 ID 排序后的模型/适配器/器件定义聚合哈希。
 *
 * 基准夹具实际读取的是 `src/devices/<id>/{model.ddl,index.ts,device.json}`，
 * 由 vitest 现场转译并编译 DDL；**不是** `dist/`。浏览器侧核对的是构建后的
 * `dist/devices/<id>/{device.js,device.json}`，两边格式不同，不能直接比较原始哈希。
 * 这里用 `source: 'src'` 明确口径；跨侧比较时请先确认同一构建输入。
 */
export interface BoardFingerprints {
  /** 哈希来源：基准固定为 `src`（源码 + 现场编译的 DDL）。 */
  readonly source: 'src';
  readonly schematic: string;
  readonly firmware: string;
  readonly models: string;
  readonly code: string;
  readonly definitions: string;
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** 聚合哈希包含器件 ID，避免两个器件对调实现后整体哈希不变。 */
function aggregate(entries: readonly (readonly [string, string])[]): string {
  return sha256(
    [...entries]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, hash]) => `${id}\0${hash}\n`)
      .join(''),
  );
}

const modules = new Map<string, Promise<DeviceModule>>();

function loadDevice(id: string): Promise<DeviceModule> {
  const cached = modules.get(id);

  if (cached !== undefined) return cached;

  const directory = join(DEVICE_ROOT, id);
  const loaded = (async (): Promise<DeviceModule> => {
    const [modelSource, codeSource, definitionSource] = await Promise.all([
      Promise.resolve(readFileSync(join(directory, 'model.ddl'))),
      Promise.resolve(readFileSync(join(directory, 'index.ts'))),
      Promise.resolve(readFileSync(join(directory, 'device.json'))),
    ]);
    const [model, adapter] = await Promise.all([
      compileDDL(modelSource.toString('utf8'), { uri: `mica:devices/${id}/model.ddl` }),
      import(pathToFileURL(join(directory, 'index.ts')).href) as Promise<{
        default: (context: DeviceContext) => Adapter;
      }>,
    ]);

    return {
      model,
      create: adapter.default,
      fingerprints: {
        model: sha256(modelSource),
        code: sha256(codeSource),
        definition: sha256(definitionSource),
      },
    };
  })();

  modules.set(id, loaded);

  return loaded;
}

const referenceId = (reference: string): string => reference.replace(/^xbotlab:/, '');

/** MCU 的 `firmware` 在原理图里是资源引用，整板装配需要真实字节。 */
export function demoFirmware(): Uint8Array {
  return new Uint8Array(readFileSync(join(PROJECT, 'assets', 'ct107d-demo.bin')));
}

export interface BoardOptions {
  /** 覆盖原理图里 MCU 的固件（资源引用换成字节）。 */
  readonly firmware: Uint8Array;
  /** 覆盖 MCU 的其它属性，例如 `clockFrequency`。 */
  readonly props?: Readonly<Record<string, unknown>>;
  /** 执行后端；`precise` 拒绝直接程序，用作差分对照。 */
  readonly execution?: 'throughput' | 'precise';
}

export interface BenchBoard {
  readonly board: {
    readonly time: number;
    readonly topics: {
      onDidReceive(listener: (message: { topic: string; payload: unknown }) => unknown): {
        dispose(): void;
      };
    };
    runUntil(target: number): void;
    dispose(): void;
  };
  /** 装配期与运行期的模型错误。 */
  readonly faults: readonly string[];
  readonly devices: number;
  readonly nets: number;
  /** 原理图里 MCU 的时钟频率（可被 `props` 覆盖）。 */
  readonly clockFrequency: number;
  /** 器件实例 ID → 板面位号（`U7`、`DS1` …）；位号只做人读标签，可能重复。 */
  readonly designators: ReadonlyMap<string, string>;
  /** 器件实例 ID → 器件类型（`74hc573`、`seg4` …）。 */
  readonly deviceTypes: ReadonlyMap<string, string>;
  /**
   * 当前正在发布话题的器件实例 ID。话题桥本身只带端口名，唯一键必须是
   * 「实例 ID + 端口」；位号只是人读标签，不能代替实例 ID。
   * 仅在设备适配器 `sync` / 模型 `publish` 期间有效（调用方需在话题回调内读取）。
   */
  readonly topicOrigin: () => string | undefined;
  /** 原理图、固件与所有器件产物的哈希清单；`source` 标明取自 `src` 而非 `dist`。 */
  readonly fingerprints: BoardFingerprints;
  dispose(): void;
}

interface Component {
  readonly id: string;
  readonly device: string;
  readonly props: Readonly<Record<string, unknown>>;
}

interface Net {
  readonly id: string;
  readonly pins: readonly unknown[];
  readonly voltage?: number;
}

interface Description {
  readonly components: readonly Component[];
  readonly nets: readonly Net[];
  readonly designators: ReadonlyMap<string, string>;
  readonly deviceTypes: ReadonlyMap<string, string>;
}

let described: Promise<Description> | undefined;

/** 解析原理图并折出网表；只按器件 id 读取 `device.json`，不依赖构建产物。 */
function describeBoard(): Promise<Description> {
  if (described !== undefined) return described;

  described = (async (): Promise<Description> => {
    const schematic = parseSchematic(readFileSync(join(PROJECT, 'ct107d.sch'), 'utf8'));
    const definitions = new Map<string, ReturnType<typeof parseDeviceMetadata>>();

    for (const symbol of schematic.sheet.symbols) {
      if (!symbol.device.startsWith('xbotlab:')) continue;

      const id = referenceId(symbol.device);

      if (definitions.has(id)) continue;
      definitions.set(
        id,
        parseDeviceMetadata(JSON.parse(readFileSync(join(DEVICE_ROOT, id, 'device.json'), 'utf8'))),
      );
    }

    const topology = deriveSchematicTopology(schematic, {
      devices: {
        getDeviceName: (reference) => definitions.get(referenceId(reference.raw))?.displayName,
        getDeviceSymbol: (reference) => {
          const definition = definitions.get(referenceId(reference.raw));

          return definition === undefined ? undefined : deviceMetadataSymbol(definition);
        },
      },
    });

    const components = schematic.sheet.symbols
      .filter((symbol) => symbol.designator)
      .map((symbol) => ({
        id: symbol.id,
        device: referenceId(symbol.device),
        props: (symbol.properties ?? {}) as Readonly<Record<string, unknown>>,
      }));

    const nets = topology.nets.map((net, index) => ({
      id: `net:${index}`,
      pins: net.members
        .filter((member) => member.kind === 'pin')
        .map((member) => ({ instance: member.symbolId, pin: member.pinId })),
      // 电源轨换成理想电压源；`P42/WR` 由原理图里的 J13（WR 选择跳线）接到 GND。
      ...(net.name === 'VCC' ? { voltage: 5 } : net.name === 'GND' ? { voltage: 0 } : {}),
    }));

    // 板面话题在 `createBoard` 这条运行时路径上只带端口名（`latch`、`digit1` …）。
    // 位号只作为人读标签；话题唯一键由实例 ID + 端口组成，避免同名位号互相覆盖。
    const designators = new Map<string, string>();
    const deviceTypes = new Map<string, string>();

    for (const symbol of schematic.sheet.symbols) {
      if (!symbol.designator) continue;

      designators.set(symbol.id, symbol.designator);
      deviceTypes.set(symbol.id, referenceId(symbol.device));
    }

    return { components, nets, designators, deviceTypes };
  })();

  return described;
}

/** 建一块整板 CT107D：51 颗器件 + 原理图网表。 */
export async function createCt107dBoard(options: BoardOptions): Promise<BenchBoard> {
  const { components, nets, designators, deviceTypes } = await describeBoard();
  const faults: string[] = [];
  const entries: DeviceLibraryEntry[] = [];

  for (const component of components) {
    const device = await loadDevice(component.device);

    entries.push({
      id: component.id,
      model: device.model,
      create: device.create as unknown as DeviceLibraryEntry['create'],
    });
  }

  const instances = components.map((component) => {
    const props = { ...component.props };

    if (!('firmware' in props)) return { id: component.id, type: component.id, props };

    // 原理图里 `firmware` 是 `{ src, mode }` 资源引用，装配侧换成真实字节。
    delete props.firmware;

    return {
      id: component.id,
      type: component.id,
      props: { ...props, ...options.props, firmware: options.firmware } as never,
    };
  });

  const library = createDeviceLibrary(entries);
  const description = {
    instances: instances as never,
    nets: nets as never,
  };
  const board =
    options.execution === undefined
      ? createBoard(library, description)
      : createBoard(library, description, { execution: options.execution });
  const subscription = board.onDidError((event) => faults.push(event.message));
  const mcu = components.find((component) => 'firmware' in component.props);
  const clockFrequency = Number(options.props?.clockFrequency ?? mcu?.props.clockFrequency ?? 0);
  const runtime = board as unknown as { readonly current?: { readonly id: string } };

  // 话题归属只读 `Instance.id`；位号映射可能重复，仅用于人读展示。
  const fingerprintEntries = await Promise.all(
    components.map(async (component) => {
      const device = await loadDevice(component.device);

      return [component.id, device.fingerprints] as const;
    }),
  );
  const fingerprints: BoardFingerprints = {
    source: 'src',
    schematic: sha256(readFileSync(join(PROJECT, 'ct107d.sch'))),
    firmware: sha256(options.firmware),
    models: aggregate(fingerprintEntries.map(([id, item]) => [id, item.model] as const)),
    code: aggregate(fingerprintEntries.map(([id, item]) => [id, item.code] as const)),
    definitions: aggregate(fingerprintEntries.map(([id, item]) => [id, item.definition] as const)),
  };

  return {
    board,
    faults,
    devices: components.length,
    nets: nets.length,
    clockFrequency,
    designators,
    deviceTypes,
    topicOrigin() {
      return runtime.current?.id;
    },
    fingerprints,
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}
