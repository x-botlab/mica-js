import { createBoardWith, US } from '../harness.ts';
import type { DeviceModule, NetDescription, TestBoard } from '../harness.ts';

/**
 * 红外发射端的专属夹具。
 *
 * 两个测试源分别驱动 VCC 和 mod；源的 level=1/0 表示拉高/拉低，2 表示释放。
 * `device` 可注入构建产物，避免在交付产物用例里复制整板接线。
 */

export interface EmitterFixtureOptions {
  readonly device?: DeviceModule;
}

export async function createEmitterFixture(
  options: EmitterFixtureOptions = {},
): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'five',
      pins: [
        { instance: 'modDrv', pin: 'vcc' },
        { instance: 'vccDrv', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'gnd',
      pins: [
        { instance: 'dut', pin: 'gnd' },
        { instance: 'modDrv', pin: 'gnd' },
        { instance: 'vccDrv', pin: 'gnd' },
      ],
      voltage: 0,
    },
    {
      id: 'mod',
      pins: [
        { instance: 'dut', pin: 'mod' },
        { instance: 'modDrv', pin: 'y' },
      ],
    },
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'vccDrv', pin: 'y' },
      ],
    },
  ];

  const board = await createBoardWith(
    [
      {
        id: 'dut',
        type: 'ir-emitter',
        ...(options.device === undefined ? {} : { device: options.device }),
      },
    ],
    {
      nets,
      sources: ['modDrv', 'vccDrv'],
    },
  );

  board.run(0);
  return board;
}

export function setSource(board: TestBoard, instance: string, high: boolean): void {
  board.send(instance, 'level', high ? 1 : 0);
  board.run(US);
}

export function setCarrier(board: TestBoard, enabled: boolean): void {
  board.call('dut', 'setCarrier', enabled);
  board.run(US);
}

export function isCarrier(board: TestBoard): boolean {
  return board.call('dut', 'isCarrier') === true;
}

export function carrierEvents(board: TestBoard): unknown[] {
  return board.events.filter((event) => event.name === 'onDidCarrier').map((event) => event.value);
}
