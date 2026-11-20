import { createBoardWith, loadSourceDevice, type TestBoard } from '../harness.ts';

/**
 * 蓝色 LED 的最小电路：电源 — 串联电阻 — LED — 地。
 *
 * 电气求解和 DDL 采样走真实仿真板；读数通过适配器的 `getBrightness` / `getCurrent` /
 * `getVoltage` 查询，`topics` 只用于验证事件确实由工厂发出。
 */

export interface Readings {
  brightness: number;
  current: number;
  voltage: number;
}

export interface CircuitOptions {
  readonly supply?: number;
  readonly series?: number;
  readonly props?: Readonly<Record<string, number>>;
  readonly reversed?: boolean;
  readonly floating?: boolean;
}

export interface Circuit {
  readonly readings: Readings;
  readonly topics: Readonly<Record<string, unknown>>;
  readonly board: TestBoard;
  run(untilPs: number): void;
  dispose(): void;
}

export async function circuit(options: CircuitOptions = {}): Promise<Circuit> {
  const supply = options.supply ?? 5;
  const series = options.series ?? 330;
  const device = await loadSourceDevice('blue-led');

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

  const board = await createBoardWith(
    [{ id: 'led', type: 'blue-led', device, props: options.props ?? {} }],
    {
      nets,
      resistors: [{ id: 'resistor', resistance: series }],
    },
  );

  const readings: Readings = { brightness: Number.NaN, current: Number.NaN, voltage: Number.NaN };
  const refresh = (): void => {
    readings.brightness = board.call('led', 'getBrightness') as number;
    readings.current = board.call('led', 'getCurrent') as number;
    readings.voltage = board.call('led', 'getVoltage') as number;
  };

  return {
    readings,
    topics: board.topics,
    board,
    run(untilPs) {
      board.runUntil(untilPs);
      refresh();
    },
    dispose: () => board.dispose(),
  };
}

/** 一次推进 1 ms 后返回读数。 */
export async function measure(options: CircuitOptions = {}): Promise<Readings> {
  const built = await circuit(options);

  try {
    built.run(1_000_000_000);
    return { ...built.readings };
  } finally {
    built.dispose();
  }
}
