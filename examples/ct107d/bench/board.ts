import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSchematic } from '@mica-js/document/schematic';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceLibraryEntry } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import type { DeviceIR } from '@mica-js/sdk/model';
import type { DeviceContext } from '@mica-js/simulator/device';

/**
 * Test-only discrete oracle: assemble the historical 54-device board plus the J5
 * selector (55 instances) from
 * `ct107d.sch` and `examples/devices/dist/<id>/model.js`.
 *
 * This fixture is intentionally not used by the fused performance benchmark. It keeps
 * the legacy projection so correctness tests can compare the fused device against the
 * independent device graph; it is not a runtime for the fused device package.
 */

const PROJECT = join(import.meta.dirname, '..');
const DEVICE_ROOT = join(PROJECT, '..', 'devices');

interface Manifest {
  readonly name: string;
  readonly displayName: string;
  readonly properties?: Readonly<
    Record<
      string,
      { readonly type?: string; readonly addressSpace?: string; readonly loadAddress?: number }
    >
  >;
  readonly pins?: Readonly<Record<string, unknown>>;
  readonly model?: {
    readonly events?: Readonly<Record<string, unknown>>;
    readonly methods?: Readonly<Record<string, { readonly params?: { readonly type?: string } }>>;
  };
  readonly view2d?: {
    readonly geometry?:
      | string
      | {
          readonly pins?: Readonly<Record<string, { readonly outward?: { x: number; y: number } }>>;
        };
  };
}

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
  readonly firmware?: {
    readonly name: string;
    readonly addressSpace: string;
    readonly loadAddress: number;
  };
}

/**
 * 产物清单：原理图 + 固件 + 按实例 ID 排序后的模型/适配器/器件定义聚合哈希。
 *
 * 基准夹具实际读取的是 `examples/devices/dist/<id>/{package.json,model.js}`。
 * 浏览器侧核对的也是同一批构建产物；两边不比较源码哈希。
 * 这里用 `source: 'dist'` 明确口径。
 */
export interface BoardFingerprints {
  /** 哈希来源：基准固定为 `dist`（构建后的统一器件包）。 */
  readonly source: 'dist';
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

const eventTopic = (name: string): string => name.slice(5, 6).toLowerCase() + name.slice(6);

function legacyEvents(manifest: Manifest): Record<string, string> {
  // A unified device can expose an input method and an output event under the same legacy
  // topic (`push-button` has `press` for both). Bridging the event back into the input
  // creates a self-feeding queue, so colliding events use their output state topic.
  const aliases: Record<string, Record<string, string>> = {
    'push-button': { onDidPress: 'pressed' },
  };
  const inputs = new Set(Object.keys(legacyInputs(manifest)));
  const table = aliases[manifest.name] ?? {};
  return Object.fromEntries(
    Object.keys(manifest.model?.events ?? {}).map((name) => {
      const topic = table[name] ?? eventTopic(name);

      return [name, inputs.has(topic) ? `${topic}State` : topic];
    }),
  );
}

function legacyInputs(manifest: Manifest): Record<string, string> {
  const aliases: Record<string, Record<string, string>> = {
    jumper: { control: 'setClosed' },
    'jumper-2x3': { control2: 'selectVs1838' },
  };
  const table = aliases[manifest.name] ?? {};
  const result: Record<string, string> = {};
  for (const [name, method] of Object.entries(manifest.model?.methods ?? {})) {
    if (method.params === undefined || method.params.type === 'null') continue;
    const port = Object.entries(table).find(([, target]) => target === name)?.[0] ?? name;
    result[port] = name;
  }
  return result;
}

function loadDevice(id: string): Promise<DeviceModule> {
  const cached = modules.get(id);

  if (cached !== undefined) return cached;

  const directory = join(DEVICE_ROOT, 'dist', id);
  const loaded = (async (): Promise<DeviceModule> => {
    const [manifestSource, codeSource] = await Promise.all([
      Promise.resolve(readFileSync(join(directory, 'package.json'))),
      Promise.resolve(readFileSync(join(directory, 'model.js'))),
    ]);
    const manifest = JSON.parse(manifestSource.toString('utf8')) as Manifest;
    const module = (await import(pathToFileURL(join(directory, 'model.js')).href)) as {
      readonly model: DeviceIR;
      readonly create: (context: DeviceContext) => Adapter;
    };
    const firmware = Object.entries(manifest.properties ?? {}).filter(
      ([, property]) => property.type === 'firmware',
    );
    const create = adaptModelFactory(module.create as never, {
      events: legacyEvents(manifest),
      inputs: legacyInputs(manifest),
      ...(firmware.length === 0
        ? {}
        : {
            props: (context: DeviceContext) => {
              const props = { ...context.props } as Record<string, unknown>;
              for (const [name, property] of firmware) {
                const value = props[name];
                if (!(value instanceof Uint8Array)) continue;
                props[name] = firmwareImage([
                  {
                    addressSpace: property.addressSpace!,
                    address: property.loadAddress!,
                    data: value,
                  },
                ]);
              }
              return props;
            },
          }),
    });
    const legacyCreate =
      manifest.name === 'seg4'
        ? (context: DeviceContext) =>
            create({
              ...context,
              topics: {
                ...context.topics,
                publish(topic, payload) {
                  if (
                    topic !== 'displayChange' ||
                    payload === null ||
                    typeof payload !== 'object'
                  ) {
                    context.topics.publish(topic, payload);
                    return;
                  }
                  const values = payload as Record<string, unknown>;
                  for (const digit of ['digit1', 'digit2', 'digit3', 'digit4'])
                    if (typeof values[digit] === 'number')
                      context.topics.publish(digit, values[digit]);
                },
              },
            })
        : create;

    return {
      model: module.model,
      create: legacyCreate as (context: DeviceContext) => Adapter,
      fingerprints: {
        model: sha256(codeSource),
        code: sha256(codeSource),
        definition: sha256(manifestSource),
      },
      ...(firmware.length === 0
        ? {}
        : {
            firmware: {
              name: firmware[0]![0],
              addressSpace: firmware[0]![1].addressSpace!,
              loadAddress: firmware[0]![1].loadAddress!,
            },
          }),
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
    readonly status: string;
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
  /** 原理图、固件与所有器件产物的哈希清单；`source` 标明取自 `dist`（统一器件包）。 */
  readonly fingerprints: BoardFingerprints;
  /** 测试专用：按位号向某个器件的输入通道注入值。 */
  sendInput(designator: string, channel: string, value: unknown): boolean;
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

/** 解析原理图实例与生成好的净网表；仿真夹具不依赖器件符号或编辑器元数据。 */
function describeBoard(): Promise<Description> {
  if (described !== undefined) return described;

  described = (async (): Promise<Description> => {
    const schematic = parseSchematic(readFileSync(join(PROJECT, 'ct107d.sch'), 'utf8'));
    const netlist = JSON.parse(
      readFileSync(join(PROJECT, 'ct107d.netlist.json'), 'utf8'),
    ) as Record<string, readonly string[]>;
    const symbols = schematic.sheet.symbols.filter(
      (symbol) => symbol.designator && symbol.device.startsWith('xbotlab:'),
    );
    const byDesignator = new Map<string, (typeof symbols)[number]>();
    for (const symbol of symbols) byDesignator.set(symbol.designator!, symbol);

    const components = symbols.map((symbol) => ({
      id: symbol.id,
      device: referenceId(symbol.device),
      props: (symbol.properties ?? {}) as Readonly<Record<string, unknown>>,
    }));
    const nets = Object.entries(netlist).map(([name, members], index) => ({
      id: `net:${index}`,
      pins: members.map((member) => {
        const separator = member.lastIndexOf('.');
        const designator = member.slice(0, separator);
        const pin = member.slice(separator + 1);
        const symbol = byDesignator.get(designator);
        if (symbol === undefined)
          throw new Error(`netlist ${name}: unknown designator ${JSON.stringify(designator)}`);
        return { instance: symbol.id, pin };
      }),
      ...(name === 'VCC' ? { voltage: 5 } : name === 'GND' ? { voltage: 0 } : {}),
    }));

    const designators = new Map<string, string>();
    const deviceTypes = new Map<string, string>();
    for (const symbol of symbols) {
      designators.set(symbol.id, symbol.designator!);
      deviceTypes.set(symbol.id, referenceId(symbol.device));
    }

    return { components, nets, designators, deviceTypes };
  })();

  return described;
}

/** 建一块整板 CT107D：54 颗历史器件 + J5 选择器（55 颗）+ 原理图网表。 */
export async function createCt107dBoard(options: BoardOptions): Promise<BenchBoard> {
  const { components, nets, designators, deviceTypes } = await describeBoard();
  const faults: string[] = [];
  const entries: DeviceLibraryEntry[] = [];
  /** Instance ID → input channels, captured at factory time for test-only injection. */
  const inputsByInstance = new Map<
    string,
    Readonly<Record<string, { send(value: unknown): void }>>
  >();

  for (const component of components) {
    const device = await loadDevice(component.device);
    const baseCreate =
      device.firmware === undefined
        ? device.create
        : (context: DeviceContext) =>
            device.create({
              ...context,
              props: {
                ...context.props,
                [device.firmware!.name]: firmwareImage([
                  {
                    addressSpace: device.firmware!.addressSpace,
                    address: device.firmware!.loadAddress,
                    data: options.firmware,
                  },
                ]),
              },
            });
    const create = (context: DeviceContext) => {
      inputsByInstance.set(
        component.id,
        (context as unknown as { inputs: Readonly<Record<string, { send(value: unknown): void }>> })
          .inputs,
      );
      return baseCreate(context);
    };

    entries.push({
      id: component.id,
      model: device.model,
      create: create as unknown as DeviceLibraryEntry['create'],
    });
  }

  const instances = components.map((component) => {
    const props = { ...component.props };

    if (!('firmware' in props)) return { id: component.id, type: component.id, props };

    // 旧原理图把 firmware 保存为资源引用；运行时通过上面的工厂包装注入 FirmwareImage，
    // 不再把裸字节放进旧板会校验的实例属性。
    delete props.firmware;

    return {
      id: component.id,
      type: component.id,
      props: { ...props, ...options.props },
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
    source: 'dist',
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
    sendInput(designator, channel, value) {
      const component = components.find(
        (candidate) => designators.get(candidate.id) === designator,
      );
      const input =
        component === undefined ? undefined : inputsByInstance.get(component.id)?.[channel];
      if (input === undefined) return false;
      input.send(value);
      return true;
    },
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}
