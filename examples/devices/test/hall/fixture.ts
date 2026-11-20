import { createBoardWith, US } from '../harness.ts';
import type { DeviceModule, NetDescription, TestBoard } from '../harness.ts';

/**
 * 开关型霍尔传感器的专属夹具。
 *
 * OUT 是低有效开漏输出：默认用 10 kΩ 上拉到 5 V 后经探针采样。供电默认接固定的
 * 5 V/0 V；需要验证掉电行为时改由测试源驱动 VCC。`device` 可注入构建产物，避免在
 * 交付产物用例里复制整板接线。
 */

export interface HallFixtureOptions {
  readonly pullup?: boolean;
  readonly drivenVcc?: boolean;
  readonly field?: number;
  readonly device?: DeviceModule;
}

export async function createHallFixture(options: HallFixtureOptions = {}): Promise<TestBoard> {
  const pullup = options.pullup ?? true;
  const drivenVcc = options.drivenVcc ?? false;
  const nets: NetDescription[] = [];
  const sources = drivenVcc ? ['vccDrv'] : [];

  nets.push({
    id: 'gnd',
    pins: [
      { instance: 'dut', pin: 'gnd' },
      ...(drivenVcc ? [{ instance: 'vccDrv', pin: 'gnd' }] : []),
    ],
    voltage: 0,
  });

  // 上拉电阻接独立的 5 V 参考；驱动 VCC 时它是逻辑高电平来源，不是被测器件的供电节点。
  const fiveVoltPins: { instance: string; pin: string }[] = drivenVcc
    ? [{ instance: 'vccDrv', pin: 'vcc' }]
    : [{ instance: 'dut', pin: 'vcc' }];
  if (pullup) fiveVoltPins.push({ instance: 'outPull', pin: 'b' });
  nets.push({ id: 'five', pins: fiveVoltPins, voltage: 5 });

  if (drivenVcc) {
    nets.push({
      id: 'vccDriven',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'vccDrv', pin: 'y' },
      ],
    });
  }

  const resistors = pullup ? [{ id: 'outPull', resistance: 10_000 }] : [];
  nets.push({
    id: 'out',
    pins: [
      { instance: 'dut', pin: 'out' },
      ...(pullup ? [{ instance: 'outPull', pin: 'a' }] : []),
      { instance: 'outProbe', pin: 'y' },
    ],
  });

  const board = await createBoardWith(
    [
      {
        id: 'dut',
        type: 'hall',
        props: options.field === undefined ? {} : { field: options.field },
        ...(options.device === undefined ? {} : { device: options.device }),
      },
    ],
    {
      nets,
      probes: ['outProbe'],
      sources,
      resistors,
    },
  );

  board.run(0);
  return board;
}

export function setField(board: TestBoard, value: number): void {
  board.call('dut', 'setField', value);
  board.run(US);
}

export function isActive(board: TestBoard): boolean {
  return board.call('dut', 'isActive') === true;
}

export function activeEvents(board: TestBoard): unknown[] {
  return board.events.filter((event) => event.name === 'onDidActive').map((event) => event.value);
}
