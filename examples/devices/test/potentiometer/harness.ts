import { createBoardWith, createTestBoard, US } from '../harness.ts';
import type {
  BoardOptions,
  DeviceInstance,
  DeviceModule,
  NetDescription,
  TestBoard,
} from '../harness.ts';

/**
 * 电位器测试夹具。默认把 VDD 接 3.3 V、GND 接 0 V，并让滑臂进入真实求解网络；
 * `connectSupply: false` 时只保留滑臂网络，用来验证浮空不会伪造电压。
 */

export const VDD = 3.3;

export interface PotBoardOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly connectSupply?: boolean;
  readonly supplyVoltage?: number;
  readonly loadResistance?: number;
  readonly device?: DeviceModule;
}

export function expectedVoltage(
  position: number,
  options: {
    readonly trackResistance?: number;
    readonly endResistance?: number;
    readonly supplyVoltage?: number;
    readonly loadResistance?: number;
  } = {},
): number {
  const track = options.trackResistance ?? 10_000;
  const end = options.endResistance ?? 10;
  const supply = options.supplyVoltage ?? VDD;
  const upper = end + track * (1 - position);
  const lower = end + track * position;

  if (options.loadResistance === undefined) return (supply * lower) / (upper + lower);
  const parallel = (lower * options.loadResistance) / (lower + options.loadResistance);
  return (supply * parallel) / (upper + parallel);
}

export async function createPotBoard(options: PotBoardOptions = {}): Promise<TestBoard> {
  const supplyVoltage = options.supplyVoltage ?? VDD;
  const wiperPins: { instance: string; pin: string }[] = [
    { instance: 'dut', pin: 'wiper' },
    { instance: 'wiperProbe', pin: 'y' },
  ];
  const gndPins: { instance: string; pin: string }[] = [];
  const vddPins: { instance: string; pin: string }[] = [];
  const resistors: { readonly id: string; readonly resistance: number }[] = [];

  if (options.connectSupply !== false) {
    vddPins.push({ instance: 'dut', pin: 'vdd' });
    gndPins.push({ instance: 'dut', pin: 'gnd' });
  }
  if (options.loadResistance !== undefined) {
    wiperPins.push({ instance: 'load', pin: 'a' });
    gndPins.push({ instance: 'load', pin: 'b' });
    resistors.push({ id: 'load', resistance: options.loadResistance });
  }

  const nets: NetDescription[] = [{ id: 'wiper', pins: wiperPins }];
  if (vddPins.length > 0) nets.push({ id: 'vdd', pins: vddPins, voltage: supplyVoltage });
  if (gndPins.length > 0) nets.push({ id: 'gnd', pins: gndPins, voltage: 0 });

  const boardOptions: BoardOptions = {
    ...(options.props === undefined ? {} : { props: options.props }),
    probes: ['wiperProbe'],
    resistors,
    nets,
  };

  if (options.device === undefined) {
    const board = await createTestBoard('potentiometer', boardOptions);
    board.run(US);
    return board;
  }

  const device = options.device;
  const devices: DeviceInstance[] = [
    {
      id: 'dut',
      type: 'potentiometer',
      device,
      props: options.props ?? {},
    },
  ];
  const board = await createBoardWith(devices, boardOptions);
  board.run(US);
  return board;
}
