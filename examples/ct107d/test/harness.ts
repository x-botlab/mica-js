import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { DeviceLibraryEntry } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { validateMetadata } from '@mica-js/sdk/metadata';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 板级夹具：现场编译某个器件的 `model.ddl`，直接装载 `src/` 里的适配器，再按用例声明的
 * 网络与辅助器件组成真实 `@mica-js/simulator` 板。
 *
 * 被测器件不被 mock：电气求解、通道、话题与执行引擎都走真实运行时。辅助器件只有三种，
 * 都与被测器件无关，就地声明：
 *
 * - `resistors`：线性电阻（上拉、下拉、串联），实例 `pin a` / `pin b`。
 * - `probes`：引脚电平探针，实例 `pin y`，把采样电平发到 `level` 输出通道（1/0/2）。
 * - `sources`：数字驱动源，实例 `pin y`（接被测网络）、`pin vcc`、`pin gnd`，输入通道
 *   `level` 取 1 驱动高、0 驱动低、其他值释放。
 *
 * 每块板固定把被测器件实例命名为 `dut`；输入通道用 `send(实例, 通道, 负载)` 驱动，
 * 探针读数用 `probe(实例)` 读取。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const DEVICE_ROOT = join(PACKAGE_DIR, 'src', 'devices');

export interface Message {
  readonly value: unknown;
}

export interface Adapter {
  sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }): void;
  dispose(): void;
}

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: unknown) => Adapter;
}

const modules = new Map<string, Promise<DeviceModule>>();

/** 装载 `src/devices/<id>/`：编译 DDL 并导入适配器，按 id 缓存。 */
export function loadSourceDevice(id: string): Promise<DeviceModule> {
  const cached = modules.get(id);

  if (cached !== undefined) return cached;

  const directory = join(DEVICE_ROOT, id);
  const loaded = (async (): Promise<DeviceModule> => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(directory, 'model.ddl'), 'utf8'), {
        uri: `mica:devices/${id}/model.ddl`,
      }),
      import(pathToFileURL(join(directory, 'index.ts')).href) as Promise<{
        default: (context: unknown) => Adapter;
      }>,
    ]);

    return { model, create: adapter.default };
  })();

  modules.set(id, loaded);

  return loaded;
}

/** 读取并校验 `src/devices/<id>/device.json`。 */
export function readMetadata(id: string): Record<string, unknown> {
  const metadata = JSON.parse(readFileSync(join(DEVICE_ROOT, id, 'device.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  validateMetadata(metadata, 'device', id);

  return metadata;
}

const resistorModels = new Map<number, Promise<DeviceIR>>();

/** 测试电阻：线性无源器件，用于上拉、下拉与串联。 */
export function resistorModel(resistance: number): Promise<DeviceIR> {
  const cached = resistorModels.get(resistance);

  if (cached !== undefined) return cached;

  const model = compileDDL(
    `device TestResistor(resistance: number default ${resistance}) {
       assert resistance >= 0.001 && resistance <= 1_000_000_000;
       pin a = [resistor(to: b, resistance: resistance)];
       pin b;
     }`,
  );

  resistorModels.set(resistance, model);

  return model;
}

let probe: Promise<DeviceIR> | undefined;

/** 探针：把引脚采样电平发到 `level` 输出通道（1 高、0 低、2 未知）。 */
export function probeModel(): Promise<DeviceIR> {
  probe ??= compileDDL(
    `device TestProbe {
       pin y(low: 1.5, high: 3.5);
       output channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
       pure fn code(sampled: Logic) -> number {
         if sampled == Logic.high {
           return 1;
         } else if sampled == Logic.low {
           return 0;
         }
         return 2;
       }
       derived current: number = code(y.sample.level);
       process start {
         level.send(current);
       }
       process changed on current {
         level.send(current);
       }
     }`,
  );

  return probe;
}

let driver: Promise<DeviceIR> | undefined;

/** 数字源：`level` 通道取 1 时把 `y` 拉到 vcc，0 时拉到 gnd，其他值释放。 */
export function sourceModel(): Promise<DeviceIR> {
  driver ??= compileDDL(
    `device TestSource(outputResistance: number default 25) {
       pin y;
       pin vcc;
       pin gnd;
       input channel level: number(capacity: 8, overflow: Overflow.drop_oldest);
       state wanted: number = 2;
       fn apply() {
         if wanted == 1 {
           y.intent <- [resistor(to: vcc, resistance: outputResistance)];
         } else if wanted == 0 {
           y.intent <- [resistor(to: gnd, resistance: outputResistance)];
         } else {
           y.intent <- [];
         }
       }
       process start {
         apply();
         loop {
           wanted = await level.receive();
           apply();
         }
       }
     }`,
  );

  return driver;
}

export interface PinRef {
  readonly instance: string;
  readonly pin: string;
}

export interface NetDescription {
  readonly id: string;
  /** 省略表示普通节点；给出数值表示接到该理想电压源。 */
  readonly voltage?: number;
  readonly pins: readonly PinRef[];
}

export interface ResistorInstance {
  readonly id: string;
  readonly resistance: number;
}

export interface BoardOptions {
  /** 器件属性覆盖。 */
  readonly props?: Readonly<Record<string, unknown>>;
  /** 额外电阻实例；`pin a`/`pin b` 由用例自己接网络。 */
  readonly resistors?: readonly ResistorInstance[];
  /** 探针实例 id；每个探针有 `y` 引脚并发布 `level`。 */
  readonly probes?: readonly string[];
  /** 数字源实例 id；每个源有 `y`/`vcc`/`gnd` 引脚与 `level` 输入通道。 */
  readonly sources?: readonly string[];
  readonly nets: readonly NetDescription[];
}

export interface TestBoard {
  /** 被测器件适配器发布到话题的最后一条负载。 */
  readonly topics: Readonly<Record<string, unknown>>;
  /** 被测器件的话题发布历史。 */
  readonly history: Readonly<Record<string, readonly unknown[]>>;
  /** 被测器件输出通道批次里的最后一条负载（不依赖适配器是否转发到话题）。 */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** 探针读数：1 高、0 低、2 未知。 */
  probe(id: string): number;
  /** 向 `instance` 的输入通道发送一条负载。 */
  send(instance: string, channel: string, value: unknown): void;
  /** 从当前时刻推进 `durationPs` 皮秒。 */
  run(durationPs: number): void;
  /** 推进到绝对时间。 */
  runUntil(timePs: number): void;
  readonly time: number;
  /** `onDidError` 收到的模型错误消息。 */
  readonly faults: readonly string[];
  dispose(): void;
}

type Context = {
  readonly inputs: Record<string, { send(value: unknown): void }>;
  readonly topics: { publish(topic: string, payload: unknown): void };
};

/** 板上的一颗被测器件：`id` 是实例名，`type` 是 `src/devices/` 下的目录名。 */
export interface DeviceInstance {
  readonly id: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface SingleBoardOptions extends BoardOptions {
  readonly props?: Readonly<Record<string, unknown>>;
}

/**
 * 建立一块多器件板：每颗器件的实例名必须唯一；实例名 `dut` 的输出按通道名归档，
 * 其余实例按 `<实例>.<通道>` 归档。
 */
export async function createBoardWith(
  devices: readonly DeviceInstance[],
  options: BoardOptions,
): Promise<TestBoard> {
  const topics: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};
  const outputs: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, { send(value: unknown): void }>> = {};
  const levels: Record<string, number> = {};
  const faults: string[] = [];

  /** 每个实例一个工厂：输入通道按实例归档，输出批次按实例与通道归档。 */
  const instrument = (
    instanceId: string,
    factory: (context: Context) => Adapter,
  ): ((context: Context) => Adapter) => {
    return (context) => {
      inputs[instanceId] = { ...context.inputs };

      const adapter = factory({
        ...context,
        topics: {
          publish(topic: string, payload: unknown) {
            topics[topic] = payload;
            (history[topic] ??= []).push(payload);
            context.topics.publish(topic, payload);
          },
        },
      });

      return {
        sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
          adapter.sync(batch);

          for (const [name, messages] of Object.entries(batch.outputs)) {
            const latest = messages[messages.length - 1];

            if (latest === undefined) continue;
            if (name === 'level' && instanceId !== 'dut')
              levels[instanceId] = latest.value as number;
            else if (instanceId === 'dut') outputs[name] = latest.value;
            else outputs[`${instanceId}.${name}`] = latest.value;
          }
        },
        dispose: () => adapter.dispose(),
      };
    };
  };

  const entries: DeviceLibraryEntry[] = [];
  const instances: { id: string; type: string; props?: Readonly<Record<string, unknown>> }[] = [];
  const idle = () => ({ sync() {}, dispose() {} });
  const used = new Set<string>();

  for (const instance of devices) {
    if (used.has(instance.id)) throw new Error(`实例名重复：${instance.id}`);
    used.add(instance.id);

    const device = await loadSourceDevice(instance.type);

    entries.push({
      id: instance.id,
      model: device.model,
      create: instrument(instance.id, device.create) as unknown as DeviceLibraryEntry['create'],
    });
    instances.push({ id: instance.id, type: instance.id, props: instance.props ?? {} });
  }

  for (const resistor of options.resistors ?? []) {
    entries.push({
      id: resistor.id,
      model: await resistorModel(resistor.resistance),
      create: (() => idle()) as unknown as DeviceLibraryEntry['create'],
    });
    instances.push({ id: resistor.id, type: resistor.id });
  }

  if ((options.probes ?? []).length > 0) {
    const model = await probeModel();

    for (const probe of options.probes ?? []) {
      entries.push({
        id: probe,
        model,
        create: instrument(probe, () => idle()) as unknown as DeviceLibraryEntry['create'],
      });
      instances.push({ id: probe, type: probe });
    }
  }

  if ((options.sources ?? []).length > 0) {
    const model = await sourceModel();

    for (const source of options.sources ?? []) {
      entries.push({
        id: source,
        model,
        create: instrument(source, () => idle()) as unknown as DeviceLibraryEntry['create'],
      });
      instances.push({ id: source, type: source });
    }
  }

  const library = createDeviceLibrary(entries);
  const board = createBoard(library, {
    instances: instances as never,
    nets: options.nets.map((net) => ({ ...net })),
  });
  const subscription = board.onDidError((event) => faults.push(event.message));

  return {
    topics,
    history,
    outputs,
    probe(probeId) {
      const level = levels[probeId];

      if (level === undefined) throw new Error(`探针还没有读数：${probeId}`);

      return level;
    },
    send(instance, channel, value) {
      const target = inputs[instance]?.[channel];

      if (target === undefined) throw new Error(`未知输入通道：${instance}.${channel}`);
      target.send(value);
    },
    run: (durationPs) => board.runUntil(board.time + durationPs),
    runUntil: (timePs) => board.runUntil(timePs),
    get time() {
      return board.time;
    },
    faults,
    dispose() {
      subscription.dispose();
      board.dispose();
    },
  };
}

/** 单器件板的便捷入口：实例固定叫 `dut`。 */
export function createTestBoard(id: string, options: SingleBoardOptions): Promise<TestBoard> {
  return createBoardWith(
    [
      {
        id: 'dut',
        type: id,
        ...(options.props === undefined ? {} : { props: options.props }),
      },
    ],
    options,
  );
}

/** 常用时间换算。 */
export const US = 1_000_000;
export const MS = 1_000_000_000;
