import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import create from '../src/devices/blue-led/index.ts';

/**
 * 板级夹具：把 `model.ddl` 现场编译并直接装载 `src/` 里的适配器，再配上一颗测试电阻与
 * 两组固定电位网络，构成「电源 — 电阻 — LED — 地」的最小电路。
 *
 * 与被测器件无关的部分（电阻、电压源）都在这里就地建立，器件实现本身不被 mock：
 * 电气求解、DDL 采样、话题发布都走真实的 `@mica-js/simulator` 板。
 */

const PACKAGE_DIR = join(import.meta.dirname, '..');
const MODEL_PATH = join(PACKAGE_DIR, 'src', 'devices', 'blue-led', 'model.ddl');

/** 测试电阻：与器件包无关的最小线性电阻。 */
const RESISTOR_MODEL = `
device TestResistor(resistance: number default 330) {
  assert isFinite(resistance) && resistance >= 0.001 && resistance <= 1_000_000_000;
  pin a = [resistor(to: b, resistance: resistance)];
  pin b;
}
`;

let ledModelCache: Promise<DeviceIR> | undefined;
let resistorModelCache: Promise<DeviceIR> | undefined;

export function ledModel(): Promise<DeviceIR> {
  ledModelCache ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'));

  return ledModelCache;
}

export function resistorModel(): Promise<DeviceIR> {
  resistorModelCache ??= compileDDL(RESISTOR_MODEL);

  return resistorModelCache;
}

/** 适配器发布到话题的最后一组读数。 */
export interface Readings {
  brightness: number;
  current: number;
  voltage: number;
}

export interface CircuitOptions {
  /** 电源电压（V），默认 5。 */
  readonly supply?: number;
  /** 串联电阻（Ω），默认 330。 */
  readonly series?: number;
  /** 器件属性覆盖。 */
  readonly props?: Readonly<Record<string, number>>;
  /** 把 LED 反接（阳极接地、阴极经电阻接电源）。 */
  readonly reversed?: boolean;
  /** 两端都悬空，不接任何电源网络。 */
  readonly floating?: boolean;
}

export interface Circuit {
  /** 读数对象按批次就地更新，调用方持有引用即可。 */
  readonly readings: Readings;
  /** 适配器发布到话题的最后一组数值。 */
  readonly topics: Readonly<Record<string, number>>;
  /** 推进到指定虚拟时间（皮秒）。 */
  run(untilPs: number): void;
  dispose(): void;
}

export async function circuit(options: CircuitOptions = {}): Promise<Circuit> {
  const supply = options.supply ?? 5;
  const series = options.series ?? 330;
  const readings: Readings = { brightness: Number.NaN, current: Number.NaN, voltage: Number.NaN };
  const topics: Record<string, number> = {};
  const [model, resistor] = await Promise.all([ledModel(), resistorModel()]);

  // 包装工厂：先让真实适配器把话题发出去，再把同一批输出留一份给测试读。
  const createLed = (context: Parameters<typeof create>[0]) => {
    const adapter = create({
      ...context,
      topics: {
        ...context.topics,
        publish(topic: string, payload: unknown) {
          if (typeof payload === 'number') topics[topic] = payload;
          context.topics.publish(topic, payload);
        },
      },
    });

    return {
      sync(batch: Parameters<typeof adapter.sync>[0]) {
        adapter.sync(batch);

        for (const name of ['brightness', 'current', 'voltage'] as const) {
          const messages = batch.outputs[name];
          const latest = messages[messages.length - 1];

          if (latest !== undefined) readings[name] = latest.value;
        }
      },
      dispose: () => adapter.dispose(),
    };
  };

  const library = createDeviceLibrary([
    { id: 'led', model, create: createLed },
    { id: 'resistor', model: resistor, create: () => ({ sync() {}, dispose() {} }) },
  ]);

  const nets =
    options.floating === true
      ? [
          { id: 'anode', pins: [{ instance: 'led', pin: 'anode' }] },
          { id: 'cathode', pins: [{ instance: 'led', pin: 'cathode' }] },
          { id: 'spare', pins: [{ instance: 'resistor', pin: 'a' }] },
        ]
      : options.reversed === true
        ? [
            { id: 'supply', pins: [{ instance: 'resistor', pin: 'a' }], voltage: supply },
            {
              id: 'cathode',
              pins: [
                { instance: 'resistor', pin: 'b' },
                { instance: 'led', pin: 'cathode' },
              ],
            },
            { id: 'ground', pins: [{ instance: 'led', pin: 'anode' }], voltage: 0 },
          ]
        : [
            { id: 'supply', pins: [{ instance: 'resistor', pin: 'a' }], voltage: supply },
            {
              id: 'anode',
              pins: [
                { instance: 'resistor', pin: 'b' },
                { instance: 'led', pin: 'anode' },
              ],
            },
            { id: 'ground', pins: [{ instance: 'led', pin: 'cathode' }], voltage: 0 },
          ];

  const board = createBoard(library, {
    instances: [
      { id: 'led', type: 'led', props: options.props ?? {} },
      { id: 'resistor', type: 'resistor', props: { resistance: series } },
    ],
    nets,
  });

  return {
    readings,
    topics,
    run: (untilPs) => board.runUntil(untilPs),
    dispose: () => board.dispose(),
  };
}

/** 一次推进 1 ms 后返回读数，用于不关心时间的用例。 */
export async function measure(options: CircuitOptions = {}): Promise<Readings> {
  const built = await circuit(options);

  try {
    built.run(1_000_000_000);

    return { ...built.readings };
  } finally {
    built.dispose();
  }
}
