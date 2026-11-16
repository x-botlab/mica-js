import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 板级夹具：现场编译 `model.ddl` 并直接装载 `src/` 里的适配器，再给 12 根引脚各配一个
 * 数字驱动源，构成真实 `@mica-js/simulator` 板。
 *
 * 源与被测器件无关，就地声明：`level` 通道取 1 时把 `y` 拉到 vcc（25 Ω），取 0 时拉到
 * gnd，其他值释放。这样就能用 `send` 模拟多路扫描：先摆好段码，再选中某一位。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'seg4', 'src');

export const PINS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'dp',
  'com1',
  'com2',
  'com3',
  'com4',
] as const;
export type Pin = (typeof PINS)[number];

export interface Message {
  readonly value: unknown;
}

export interface Adapter {
  sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }): void;
  dispose(): void;
}

export interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => Adapter;
}

let moduleCache: Promise<DeviceModule> | undefined;

/** 装载 `<id>/src/`：编译 DDL 并导入统一模型工厂；事件经兼容适配器转到旧话题。 */
export function loadSourceDevice(): Promise<DeviceModule> {
  moduleCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/seg4/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
        create: (context: never) => Adapter;
      }>,
    ]);
    const create = adaptModelFactory(adapter.create as never, {
      events: { onDidDisplayChange: 'display' },
    }) as unknown as (context: never) => Adapter;

    return { model, create };
  })();

  return moduleCache;
}

let sourceCache: Promise<DeviceIR> | undefined;

/** 数字源：`level` 为 1 驱动高、0 驱动低、其他值释放。 */
export function sourceModel(): Promise<DeviceIR> {
  sourceCache ??= compileDDL(
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

  return sourceCache;
}

export interface Circuit {
  /** 被测器件输出通道的最新负载。 */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** 被测器件发布到话题的最新负载。 */
  readonly topics: Readonly<Record<string, unknown>>;
  /** 适配器发布的全部话题历史。 */
  readonly history: Readonly<Record<string, readonly unknown[]>>;
  /** 板级错误。 */
  readonly faults: readonly string[];
  /** 统一模型实例方法；测试用清单形状调用状态查询。 */
  readonly methods: unknown;
  /** 驱动一根引脚：1 高、0 低、2 释放。 */
  set(pin: Pin, level: 0 | 1 | 2): void;
  /** 摆好段码并选中指定位，极性跟随 `commonAnode`。 */
  show(mask: number, active: readonly number[]): void;
  run(durationPs: number): void;
  dispose(): void;
}

export async function circuit(props: Readonly<Record<string, unknown>> = {}): Promise<Circuit> {
  const [device, source] = await Promise.all([loadSourceDevice(), sourceModel()]);
  const outputs: Record<string, unknown> = {};
  const topics: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};
  const inputs: Record<string, Record<string, { send(value: unknown): void }>> = {};
  const faults: string[] = [];
  let methods: unknown;

  const instrument = (context: {
    readonly inputs: Record<string, { send(value: unknown): void }>;
    readonly topics: { publish(topic: string, payload: unknown): void };
  }) => {
    inputs.dut = { ...context.inputs };

    const adapter = device.create({
      ...context,
      topics: {
        publish(topic: string, payload: unknown) {
          topics[topic] = payload;
          (history[topic] ??= []).push(payload);
          context.topics.publish(topic, payload);
        },
      },
    } as never);

    methods = (adapter as typeof adapter & { readonly methods?: unknown }).methods;

    return {
      sync(batch: { readonly outputs: Readonly<Record<string, readonly Message[]>> }) {
        adapter.sync(batch);

        for (const [name, messages] of Object.entries(batch.outputs)) {
          const latest = messages[messages.length - 1];

          if (latest !== undefined) outputs[name] = latest.value;
        }
      },
      dispose: () => adapter.dispose(),
    };
  };

  const entries = [
    { id: 'dut', model: device.model, create: instrument as never },
    ...PINS.map((pin) => ({
      id: `src_${pin}`,
      model: source,
      create: (context: { inputs: Record<string, { send(value: unknown): void }> }) => {
        inputs[`src_${pin}`] = { ...context.inputs };
        return { sync() {}, dispose() {} };
      },
    })),
  ];
  const instances = [
    { id: 'dut', type: 'dut', props },
    ...PINS.map((pin) => ({ id: `src_${pin}`, type: `src_${pin}` })),
  ];
  const nets = [
    { id: 'vcc', pins: PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'vcc' })), voltage: 5 },
    { id: 'gnd', pins: PINS.map((pin) => ({ instance: `src_${pin}`, pin: 'gnd' })), voltage: 0 },
    ...PINS.map((pin) => ({
      id: pin,
      pins: [
        { instance: 'dut', pin },
        { instance: `src_${pin}`, pin: 'y' },
      ],
    })),
  ];
  const board = createBoard(createDeviceLibrary(entries as never), { instances, nets } as never);
  board.onDidError((event) => faults.push(event.message));

  const set = (pin: Pin, level: 0 | 1 | 2): void => {
    const target = inputs[`src_${pin}`]?.level;

    if (target === undefined) throw new Error(`源还没有就绪：${pin}`);
    target.send(level);
  };

  const show = (mask: number, active: readonly number[]): void => {
    const segments = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;
    // 共阴：段高点亮、公共端低选中；共阳：段低点亮、公共端高选中。
    const anode = props.commonAnode === true;

    for (const [index, pin] of segments.entries()) {
      const lit = ((mask >> index) & 1) === 1;
      set(pin, lit === anode ? 0 : 1);
    }
    for (let digit = 0; digit < 4; digit += 1) {
      const selected = active.includes(digit);
      set(`com${digit + 1}` as Pin, selected === anode ? 1 : 0);
    }
  };

  return {
    outputs,
    topics,
    history,
    faults,
    methods,
    set,
    show,
    run: (durationPs) => board.runUntil(board.time + durationPs),
    dispose: () => board.dispose(),
  };
}

/** 推进 1 ms 并返回四位段码。 */
export async function readDigits(
  mask: number,
  active: readonly number[],
  props: Readonly<Record<string, unknown>> = {},
): Promise<number[]> {
  const built = await circuit(props);

  try {
    built.show(mask, active);
    built.run(1_000_000_000);

    return [0, 1, 2, 3].map((index) => built.outputs[`digit${index + 1}`] as number);
  } finally {
    built.dispose();
  }
}
