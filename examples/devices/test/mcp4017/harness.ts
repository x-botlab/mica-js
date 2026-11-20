import { compileDDL } from '@mica-js/sdk/ddl';
import { createBoardWith, US } from '../harness.ts';
import type {
  BoardOptions,
  DeviceInstance,
  DeviceModule,
  NetDescription,
  TestBoard,
} from '../harness.ts';

/**
 * MCP4017 测试夹具与位级 I²C 主机。
 *
 * 默认复现 CT117E-M4 的等效接线：VDD=3.3 V，B 接地，W 经 R17=10 kΩ 上拉到 VDD，
 * SDA 经 10 kΩ 上拉，SCL 由数字源驱动。R17 是板上真实的上拉电阻，芯片内部没有
 * W–VDD 支路；关闭 R17 时 W 只经 W–B 变阻器到地。
 *
 * SDA 使用专属 0.8/2.0 V 阈值探针。共享探针的高阈值 3.5 V 会把 3.3 V 总线误判为
 * unknown；本夹具明确要求 ACK 与读数据期间只能是 0 或 1，浮空/中间电平直接失败。
 */

export const VDD = 3.3;
export const R17 = 10_000;
export const STEP = 2 * US;

export interface McpBoardOptions {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly r17?: boolean;
  readonly connectB?: boolean;
  readonly sdaPullup?: boolean;
  readonly floating?: boolean;
  readonly device?: DeviceModule;
}

export function expectedResistance(
  code: number,
  options: { readonly rab?: number; readonly wiperResistance?: number } = {},
): number {
  return ((options.rab ?? 100_000) * code) / 127 + (options.wiperResistance ?? 100);
}

export function expectedVoltage(
  code: number,
  options: {
    readonly rab?: number;
    readonly wiperResistance?: number;
    readonly supplyVoltage?: number;
    readonly r17?: number;
  } = {},
): number {
  const supply = options.supplyVoltage ?? VDD;
  const pullup = options.r17 ?? R17;
  const resistance = expectedResistance(code, options);

  return (supply * resistance) / (pullup + resistance);
}

let thresholdProbeModule: Promise<DeviceModule> | undefined;

/** 共享 harness 的探针高阈值是 3.5 V；这里用专属 0.8/2.0 V 探针检查 3.3 V 总线。 */
function loadThresholdProbe(): Promise<DeviceModule> {
  thresholdProbeModule ??= compileDDL(
    `device ThresholdProbe {
       pin y(low: 0.8, high: 2.0);
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
  ).then((model) => ({
    model,
    create: () => ({ sync() {}, dispose() {} }),
    manifest: {
      publisher: 'test',
      name: 'threshold-probe',
      version: '0.0.0',
      engines: { mica: '^1.0.0' },
      displayName: 'Threshold Probe',
      model: { entry: 'model.js', types: {}, methods: {}, events: {} },
    },
  }));

  return thresholdProbeModule;
}

export async function createMcpBoard(options: McpBoardOptions = {}): Promise<TestBoard> {
  const dut: DeviceInstance = {
    id: 'dut',
    type: 'mcp4017',
    ...(options.device === undefined ? {} : { device: options.device }),
    props: options.props ?? {},
  };

  if (options.floating === true) {
    const board = await createBoardWith([dut], { nets: [] });
    board.run(10 * US);
    return board;
  }

  const vccPins: { instance: string; pin: string }[] = [
    { instance: 'dut', pin: 'vdd' },
    { instance: 'sclSrc', pin: 'vcc' },
    { instance: 'sdaSrc', pin: 'vcc' },
  ];
  const gndPins: { instance: string; pin: string }[] = [
    { instance: 'dut', pin: 'vss' },
    { instance: 'sclSrc', pin: 'gnd' },
    { instance: 'sdaSrc', pin: 'gnd' },
  ];
  const wiperPins: { instance: string; pin: string }[] = [{ instance: 'dut', pin: 'w' }];
  const sdaPins: { instance: string; pin: string }[] = [
    { instance: 'dut', pin: 'sda' },
    { instance: 'sdaSrc', pin: 'y' },
    { instance: 'sdaProbe', pin: 'y' },
  ];
  const resistors: { readonly id: string; readonly resistance: number }[] = [];

  if (options.connectB !== false) gndPins.push({ instance: 'dut', pin: 'b' });
  if (options.r17 !== false) {
    vccPins.push({ instance: 'r17', pin: 'b' });
    wiperPins.push({ instance: 'r17', pin: 'a' });
    resistors.push({ id: 'r17', resistance: R17 });
  }
  if (options.sdaPullup !== false) {
    vccPins.push({ instance: 'sdaPull', pin: 'b' });
    sdaPins.push({ instance: 'sdaPull', pin: 'a' });
    resistors.push({ id: 'sdaPull', resistance: 10_000 });
  }

  const nets: NetDescription[] = [
    { id: 'vcc', pins: vccPins, voltage: VDD },
    { id: 'gnd', pins: gndPins, voltage: 0 },
    { id: 'sda', pins: sdaPins },
    {
      id: 'scl',
      pins: [
        { instance: 'dut', pin: 'scl' },
        { instance: 'sclSrc', pin: 'y' },
      ],
    },
    { id: 'w', pins: wiperPins },
  ];

  const boardOptions: BoardOptions = {
    resistors,
    sources: ['sclSrc', 'sdaSrc'],
    nets,
  };
  const board = await createBoardWith(
    [dut, { id: 'sdaProbe', type: 'threshold-probe', device: await loadThresholdProbe() }],
    boardOptions,
  );
  board.run(10 * US);
  return board;
}

export interface I2cBus {
  start(): void;
  stop(): void;
  /** 发送一个字节，返回第 9 个时钟上采样到的 SDA 电平（0=ACK，1=NACK）。 */
  writeByte(value: number): number;
  /** 读取一个字节；`ack` 为主机是否在第 9 个时钟拉低应答。 */
  readByte(ack: boolean): number;
  /**
   * 发送 8 个数据位后停在第 9 个时钟之前，返回由从机拉低的应答电平。
   * 用于验证 wiper 只在应答位结束的下降沿写入。
   */
  writeDataUntilAck(value: number): number;
  /** 完成上一条 `writeDataUntilAck` 的第 9 个时钟。 */
  completeAck(): void;
  /** 产生一个仅用于观察的 SCL 高脉冲，返回高电平期间的 SDA 逻辑值。 */
  pulseClock(): number;
  /** 当前 SDA 逻辑值；浮空或落在阈值之间时抛错。 */
  readSda(): number;
}

export function makeBus(board: TestBoard): I2cBus {
  const scl = (high: boolean): void => {
    board.send('sclSrc', 'level', high ? 1 : 0);
    board.run(STEP);
  };
  const sda = (high: boolean): void => {
    // 开漏主机：高电平只释放，由上拉电阻决定。
    board.send('sdaSrc', 'level', high ? 2 : 0);
    board.run(STEP);
  };
  const readSda = (): number => {
    const level = board.probe('sdaProbe');
    if (level !== 0 && level !== 1)
      throw new Error(`SDA is not a valid logic level (probe=${level})`);
    return level;
  };

  return {
    start() {
      sda(true);
      scl(true);
      sda(false);
    },
    stop() {
      scl(false);
      sda(false);
      scl(true);
      sda(true);
    },
    writeByte(value) {
      scl(false);
      for (let bit = 7; bit >= 0; bit -= 1) {
        sda(((value >> bit) & 1) === 1);
        scl(true);
        scl(false);
      }

      sda(true);
      scl(true);
      const ack = readSda();
      scl(false);
      return ack;
    },
    readByte(ack) {
      let value = 0;

      sda(true);
      for (let bit = 0; bit < 8; bit += 1) {
        scl(true);
        value = (value << 1) | readSda();
        scl(false);
      }

      sda(!ack);
      scl(true);
      scl(false);
      sda(true);
      return value;
    },
    writeDataUntilAck(value) {
      scl(false);
      for (let bit = 7; bit >= 0; bit -= 1) {
        sda(((value >> bit) & 1) === 1);
        scl(true);
        scl(false);
      }

      // 第 8 个下降沿后从机已拉低 SDA 应答，但第 9 个时钟尚未到来。
      return readSda();
    },
    completeAck() {
      sda(true);
      scl(true);
      scl(false);
      sda(true);
    },
    pulseClock() {
      scl(true);
      const level = readSda();
      scl(false);
      return level;
    },
    readSda,
  };
}
