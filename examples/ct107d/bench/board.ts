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

/**
 * 整板基准夹具：按 `ct107d.sch` 的网表装配 44 颗器件，器件行为来自 `src/devices/`。
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

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => Adapter;
}

const modules = new Map<string, Promise<DeviceModule>>();

function loadDevice(id: string): Promise<DeviceModule> {
  const cached = modules.get(id);

  if (cached !== undefined) return cached;

  const directory = join(DEVICE_ROOT, id);
  const loaded = (async (): Promise<DeviceModule> => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(directory, 'model.ddl'), 'utf8'), {
        uri: `mica:devices/${id}/model.ddl`,
      }),
      import(pathToFileURL(join(directory, 'index.ts')).href) as Promise<{
        default: (context: never) => Adapter;
      }>,
    ]);

    return { model, create: adapter.default };
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
      // 电源轨换成理想电压源；`P42/WR` 按 J13 的 2-3 位置接 0 V（模型没有 P4 端口）。
      ...(net.name === 'VCC'
        ? { voltage: 5 }
        : net.name === 'GND' || net.name === 'P42/WR'
          ? { voltage: 0 }
          : {}),
    }));

    return { components, nets };
  })();

  return described;
}

/** 建一块整板 CT107D：44 颗器件 + 原理图网表。 */
export async function createCt107dBoard(options: BoardOptions): Promise<BenchBoard> {
  const { components, nets } = await describeBoard();
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

  const board = createBoard(createDeviceLibrary(entries), {
    instances: instances as never,
    nets: nets as never,
  });
  const subscription = board.onDidError((event) => faults.push(event.message));
  const mcu = components.find((component) => 'firmware' in component.props);
  const clockFrequency = Number(options.props?.clockFrequency ?? mcu?.props.clockFrequency ?? 0);

  return {
    board,
    faults,
    devices: components.length,
    nets: nets.length,
    clockFrequency,
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}
