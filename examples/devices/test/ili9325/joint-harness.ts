import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '@mica-js/sdk/device';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * STM32G431RBT6 + ILI9325 联合板夹具。
 *
 * 固件 `HAL_06_LCD.bin` 从 `HAL_06_LCD.axf` 的 PT_LOAD 段导出，按 80 MHz 配置时钟。
 * 这里复用真实电气网络、适配器和话题发布，供正确性用例与性能基准共同使用。
 */

const ILI_DIR = join(import.meta.dirname, '..', '..', 'ili9325', 'src');
const MCU_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const FIRMWARE = join(import.meta.dirname, 'fixtures', 'HAL_06_LCD.bin');

/** 固件 `SystemClock_Config`：HSI16 → PLL M=2 / N=20 / R=2，SYSCLK = 80 MHz。 */
export const JOINT_CLOCK_FREQUENCY = 80_000_000;
/** 与历次基准读数保持一致的单次 `runUntil` 跨度。 */
export const JOINT_TIME_QUANTUM_PS = 200_000_000;

interface Adapter {
  sync(batch: unknown): void;
  dispose(): void;
}

interface BatchOutputs {
  readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
}

interface InternalPin {
  readonly intent: readonly { readonly to: { readonly name: string } }[];
}

/** 运行时内部字段：只用于显式正确性/诊断用例，不构成 SDK API。 */
interface InternalInstance {
  readonly pins: ReadonlyMap<string, InternalPin>;
  writeIntent(pin: unknown, value: unknown): boolean;
  readonly host: {
    send(name: string, value: unknown): void;
  };
  readonly memoryResources: ReadonlyMap<string, { readonly version: number }>;
  readonly sampleResources: ReadonlyMap<string, { readonly version: number }>;
}

export interface JointInstance {
  readonly memories: Map<string, Uint8Array>;
  readonly states: Map<string, unknown>;
}

export interface JointBoardOptions {
  /** Alternative Flash image loaded at 0x08000000; omitted for the historical BIN fixture. */
  readonly firmware?: Uint8Array;
  /**
   * 安装独立对账：按 MCU 的 WR/CS/RS/PC intent 发出量解码总线写，并维护一份不经过
   * ILI9325 模型的 GRAM oracle。该模式会增加每个 intent 的宿主调用开销，只用于显式
   * 正确性/诊断用例，不进入计时轮次。
   */
  readonly accounting?: boolean;
}

export interface JointFullScreenFill {
  readonly value: number;
  readonly pixels: number;
  /** 第 76,800 次写完成时，oracle 的整块 GRAM 是否都等于 `value`。 */
  readonly uniform: boolean;
}

export interface JointAccountingReadout {
  readonly timePs: number;
  readonly intentCalls: number;
  readonly intentChanges: number;
  readonly wrLevelChanges: number;
  readonly wrRises: number;
  readonly selectedRises: number;
  readonly commandWrites: number;
  readonly dataWrites: number;
  readonly pixelWrites: number;
  readonly csLevelChanges: number;
  readonly rsLevelChanges: number;
  readonly dataBitLevelChanges: number;
  readonly wrSamples: number;
  readonly csSamples: number;
  readonly rsSamples: number;
  readonly dataSamples: number;
  /** ILI9325 `gram` memory 的版本增量：每次模型执行 `store16le` 计一次。 */
  readonly gramStores: number;
  readonly oracleGramStores: number;
  readonly fullScreenFills: readonly JointFullScreenFill[];
  /** 面板坐标（320×240）的独立参考图像。 */
  readonly oracleGram: Uint16Array;
  /** 从独立总线 oracle 在 frameInfo 发送时刻生成的帧。 */
  readonly oracleFrames: readonly Uint8Array[];
}

interface JointDevices {
  readonly mcuModel: DeviceIR;
  readonly lcdModel: DeviceIR;
  readonly mcuModule: { readonly create: unknown };
  readonly lcdModule: { readonly create: unknown };
}

export interface JointBoard {
  readonly board: Board;
  readonly frames: Uint8Array[];
  /** Model frameInfo send times, before adapter delivery at the quantum boundary. */
  readonly frameTimes: number[];
  /**
   * 与 `frames` 一一对应，记录模型在帧体发送时刻交给适配器的完整载荷。
   *
   * 帧体由 `publishFrames` 用 `copyBytes` 复制 GRAM；话题发布发生在稍后的 adapter
   * `sync`。完整 WR 边沿下，同一量子内后续绘图可能已经改变 GRAM，因此不能再拿
   * `sync` 末尾的 GRAM 快照与帧体逐像素比较。这里直接重建模型发出的帧体。
   */
  readonly expectedFrames: Uint8Array[];
  readonly faults: number[];
  readonly errors: string[];
  readonly mcu: JointInstance;
  readonly lcd: JointInstance;
  /** 按固定步长推进到目标仿真时间。 */
  advanceTo(targetPs: number): void;
  /** 仅在 `createJointBoard({ accounting: true })` 时可用。 */
  readAccounting(): JointAccountingReadout | undefined;
  dispose(): void;
}

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 240;
const GRAM_WIDTH = 240;
const GRAM_HEIGHT = 320;
export const JOINT_PANEL_WIDTH = PANEL_WIDTH;
export const JOINT_PANEL_HEIGHT = PANEL_HEIGHT;
export const JOINT_FULL_FRAME_PIXELS = PANEL_WIDTH * PANEL_HEIGHT;

/**
 * 当前 `HAL_06_LCD.bin` 在 0 → 440 ms 的固定工作量；以独立总线 oracle
 * 在运行时优化前后的相同结果为准。
 *
 * 这些数字约束 MCU 实际发出的写周期，不是允许漏边沿的容差：
 * - `wrLevelChanges` 是 MCU WR intent 的全部电平变化；
 * - `selectedRises` 是 CS 有效时的 WR 上升沿；
 * - `pixelWrites` 是 RS 为数据且当前命令为 0x22 的写周期；
 * - `gramStores` 是 ILI9325 模型执行的 `store16le` 次数；
 * - `nonZeroPixels` 是整屏清屏后每个面板像素都被写过的结果。
 */
export const JOINT_440MS_EXPECTED = Object.freeze({
  wrLevelChanges: 157_338,
  selectedRises: 78_669,
  pixelWrites: 77_351,
  gramStores: 77_351,
  nonZeroPixels: 76_800,
  frames: 3,
  clearColor: 0x001f,
} as const);
const FULL_FRAME_PIXELS = JOINT_FULL_FRAME_PIXELS;

interface PixelRun {
  readonly startX: number;
  readonly startY: number;
  readonly windowX0: number;
  readonly windowX1: number;
  readonly windowY0: number;
  readonly windowY1: number;
  readonly entryMode: number;
  readonly value: number;
  count: number;
  uniform: boolean;
}

/**
 * ILI9325 的独立 GRAM oracle：只消费 MCU 侧观察到的写周期，不读取 LCD 模型状态。
 * 寄存器、窗口与地址推进按数据手册语义重写，用于给联合路径提供参考图像。
 */
class GramOracle {
  readonly gram = new Uint16Array(FULL_FRAME_PIXELS);
  readonly frames: Uint8Array[] = [];
  readonly fullScreenFills: JointFullScreenFill[] = [];
  stores = 0;
  index = 0;
  private entryMode = 0x1030;
  private addrX = 0;
  private addrY = 0;
  private windowX0 = 0;
  private windowX1 = GRAM_WIDTH - 1;
  private windowY0 = 0;
  private windowY1 = GRAM_HEIGHT - 1;
  private run: PixelRun | undefined;

  captureFrame(rect: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = rect;
    if (
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > PANEL_WIDTH ||
      y + height > PANEL_HEIGHT
    )
      throw new Error('joint oracle: invalid frame rectangle');
    const frame = new Uint8Array(8 + width * height * 2);
    const view = new DataView(frame.buffer);
    for (const [index, value] of [x, y, width, height].entries())
      view.setUint16(index * 2, value, true);
    for (let row = 0; row < height; row++)
      for (let column = 0; column < width; column++)
        view.setUint16(
          8 + (row * width + column) * 2,
          this.gram[(y + row) * PANEL_WIDTH + x + column]!,
          true,
        );
    this.frames.push(frame);
  }

  command(value: number): void {
    const index = value & 0xff;
    // WriteRAM 可以为每个像素重复选择 R22；重复选择不改变地址或像素序列。
    if (index !== 0x22 || this.index !== index) this.run = undefined;
    this.index = index;
  }

  /** 返回这次数据写是否落在 R22h 的像素路径上。 */
  data(value: number): boolean {
    if (this.index === 0x22) {
      const startX = this.addrX;
      const startY = this.addrY;

      this.writePixel(value);
      this.trackPixel(value, startX, startY);
      return true;
    }
    this.writeRegister(value);
    return false;
  }

  private writeRegister(value: number): void {
    if (this.index === 0x20) {
      this.addrX = value & 0xff;
    } else if (this.index === 0x21) {
      this.addrY = value & 0x1ff;
    } else if (this.index === 0x03) {
      this.entryMode = value;
    } else if (this.index === 0x50) {
      const next = value & 0xff;

      if (next <= this.windowX1) this.windowX0 = next;
    } else if (this.index === 0x51) {
      const next = value & 0xff;

      if (next >= this.windowX0 && next < GRAM_WIDTH) this.windowX1 = next;
    } else if (this.index === 0x52) {
      const next = value & 0x1ff;

      if (next <= this.windowY1) this.windowY0 = next;
    } else if (this.index === 0x53) {
      const next = value & 0x1ff;

      if (next >= this.windowY0 && next < GRAM_HEIGHT) this.windowY1 = next;
    }
  }

  private writePixel(value: number): void {
    if (
      this.addrX >= this.windowX0 &&
      this.addrX <= this.windowX1 &&
      this.addrY >= this.windowY0 &&
      this.addrY <= this.windowY1 &&
      this.addrX < GRAM_WIDTH &&
      this.addrY < GRAM_HEIGHT
    ) {
      this.gram[this.addrX * PANEL_WIDTH + (PANEL_WIDTH - 1) - this.addrY] = value;
      this.stores += 1;
    }
    this.advanceAddress();
  }

  private advanceAddress(): void {
    const xUp = (this.entryMode & 16) !== 0;
    const yUp = (this.entryMode & 32) !== 0;

    if ((this.entryMode & 8) === 0) {
      this.addrX += xUp ? 1 : -1;
      if (this.addrX > this.windowX1) {
        this.addrX = this.windowX0;
        this.addrY += yUp ? 1 : -1;
        if (this.addrY > this.windowY1) this.addrY = this.windowY0;
        else if (this.addrY < this.windowY0) this.addrY = this.windowY1;
      } else if (this.addrX < this.windowX0) {
        this.addrX = this.windowX1;
        this.addrY += yUp ? 1 : -1;
        if (this.addrY > this.windowY1) this.addrY = this.windowY0;
        else if (this.addrY < this.windowY0) this.addrY = this.windowY1;
      }
    } else {
      this.addrY += yUp ? 1 : -1;
      if (this.addrY > this.windowY1) {
        this.addrY = this.windowY0;
        this.addrX += xUp ? 1 : -1;
        if (this.addrX > this.windowX1) this.addrX = this.windowX0;
        else if (this.addrX < this.windowX0) this.addrX = this.windowX1;
      } else if (this.addrY < this.windowY0) {
        this.addrY = this.windowY1;
        this.addrX += xUp ? 1 : -1;
        if (this.addrX > this.windowX1) this.addrX = this.windowX0;
        else if (this.addrX < this.windowX0) this.addrX = this.windowX1;
      }
    }
  }

  private trackPixel(value: number, startX: number, startY: number): void {
    const run = (this.run ??= {
      startX,
      startY,
      windowX0: this.windowX0,
      windowX1: this.windowX1,
      windowY0: this.windowY0,
      windowY1: this.windowY1,
      entryMode: this.entryMode,
      value,
      count: 0,
      uniform: true,
    });

    run.count += 1;
    if (value !== run.value) run.uniform = false;
    if (run.count !== FULL_FRAME_PIXELS) return;

    const fullWindow =
      run.windowX0 === 0 &&
      run.windowX1 === GRAM_WIDTH - 1 &&
      run.windowY0 === 0 &&
      run.windowY1 === GRAM_HEIGHT - 1;
    // 满窗口下，从任一合法起点沿任一方向循环 76,800 次都会覆盖整屏一次。
    const fullCoverage =
      run.startX >= 0 && run.startX < GRAM_WIDTH && run.startY >= 0 && run.startY < GRAM_HEIGHT;

    if (!fullWindow || !fullCoverage) return;
    let uniform = run.uniform;

    if (uniform)
      for (let at = 0; at < this.gram.length; at += 1)
        if (this.gram[at] !== run.value) {
          uniform = false;
          break;
        }
    this.fullScreenFills.push({ value: run.value, pixels: run.count, uniform });
  }
}

function intentLevel(pin: InternalPin | undefined): number | undefined {
  const name = pin?.intent[0]?.to.name;

  if (name?.startsWith('VDD')) return 1;
  if (name?.startsWith('VSS')) return 0;
  return undefined;
}

function sampleVersion(instance: InternalInstance, name: string): number {
  return instance.sampleResources.get(name)?.version ?? 0;
}

function dataSampleVersion(instance: InternalInstance): number {
  let version = 0;

  for (let bit = 0; bit < 16; bit += 1) version += sampleVersion(instance, `D${bit}`);
  return version;
}

function memoryVersion(instance: InternalInstance, name: string): number {
  return instance.memoryResources.get(name)?.version ?? 0;
}

/** 按适配器的配对规则重建模型在帧体发送时刻交给它的完整帧载荷。 */
export function assembleFrames(outputs: BatchOutputs['outputs']): Uint8Array[] {
  const infos = outputs.frameInfo ?? [];
  const rows = outputs.frameRows ?? [];
  const frames: Uint8Array[] = [];
  let at = 0;

  for (const info of infos) {
    const { x, y, width, height } = info.value as {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    const body = width * height * 2;
    const frame = new Uint8Array(8 + body);
    const header = new DataView(frame.buffer);

    header.setUint16(0, x, true);
    header.setUint16(2, y, true);
    header.setUint16(4, width, true);
    header.setUint16(6, height, true);

    let filled = 0;

    while (filled < body && at < rows.length) {
      const chunk = rows[at]!.value as Uint8Array;
      const take = Math.min(chunk.length, body - filled);

      frame.set(take === chunk.length ? chunk : chunk.subarray(0, take), 8 + filled);
      filled += take;
      at += 1;
    }
    if (filled < body) break;
    frames.push(frame);
  }

  return frames;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let at = 0; at < left.length; at += 1) if (left[at] !== right[at]) return false;
  return true;
}

export function gramMatchesOracle(gram: Uint8Array, oracle: Uint16Array): boolean {
  if (gram.length !== oracle.length * 2) return false;
  const view = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);

  for (let at = 0; at < oracle.length; at += 1)
    if (view.getUint16(at * 2, true) !== oracle[at]) return false;
  return true;
}

export function nonZeroGramPixels(gram: Uint8Array): number {
  const view = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);
  let count = 0;

  for (let at = 0; at < gram.length; at += 2) if (view.getUint16(at, true) !== 0) count += 1;
  return count;
}

const DATA_BITS = Array.from({ length: 16 }, (_, index) => index);
/** CT117E-M4 的 LCD 控制线接法（`lcd.c` 的 `LCD_CtrlLinesConfig`）。 */
const CONTROL_LINES: readonly (readonly [mcu: string, lcd: string])[] = [
  ['PB5', 'WR'],
  ['PB8', 'RS'],
  ['PB9', 'CS'],
  ['PA8', 'RD'],
];
const VDD_PINS = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'];
const VSS_PINS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'];

let devicesPromise: Promise<JointDevices> | undefined;

function loadDevices(): Promise<JointDevices> {
  devicesPromise ??= (async () => {
    const [mcuModel, lcdModel, mcuModule, lcdModule] = await Promise.all([
      compileDDL(readFileSync(join(MCU_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/stm32g431rbt6/model.ddl',
      }),
      compileDDL(readFileSync(join(ILI_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/ili9325/model.ddl',
      }),
      import(pathToFileURL(join(MCU_DIR, 'index.ts')).href),
      import(pathToFileURL(join(ILI_DIR, 'index.ts')).href),
    ]);

    return {
      mcuModel,
      lcdModel,
      mcuModule: mcuModule as JointDevices['mcuModule'],
      lcdModule: lcdModule as JointDevices['lcdModule'],
    };
  })();

  return devicesPromise;
}

export function instance(
  instances:
    | Map<string, JointInstance>
    | readonly (JointInstance & { readonly id?: string })[]
    | Record<string, JointInstance>
    | undefined,
  id: string,
): JointInstance | undefined {
  if (instances instanceof Map) return instances.get(id);
  if (Array.isArray(instances))
    return (instances as readonly (JointInstance & { readonly id?: string })[]).find(
      (entry) => entry.id === id,
    );
  return (instances as Record<string, JointInstance> | undefined)?.[id];
}

/** 创建一块全新的联合板；器件模型与适配器模块在进程内只加载一次。 */
export async function createJointBoard(options: JointBoardOptions = {}): Promise<JointBoard> {
  const { mcuModel, lcdModel, mcuModule, lcdModule } = await loadDevices();
  const expectedFrames: Uint8Array[] = [];
  const frameTimes: number[] = [];
  const firmware = firmwareImage([
    {
      addressSpace: 'code',
      address: 0x0800_0000,
      data: options.firmware?.slice() ?? new Uint8Array(readFileSync(FIRMWARE)),
    },
  ]);
  const mcuCreate = adaptModelFactory(mcuModule.create as never, {
    props: {
      clockFrequency: JOINT_CLOCK_FREQUENCY,
      firmware,
    },
    events: {
      onDidUart1Tx: {
        topic: 'serial1.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidUart2Tx: {
        topic: 'serial2.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidUart3Tx: {
        topic: 'serial3.tx',
        transform: (value) => (value as { data: Uint8Array }).data,
      },
      onDidFault: 'fault',
    },
  }) as unknown as (context: never) => Adapter;
  const lcdCreate = adaptModelFactory(lcdModule.create as never, {
    events: {
      onDidFrame: {
        topic: 'framebuffer',
        transform: (value) => {
          const frame = value as {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
            readonly pixels: Uint8Array;
          };
          const payload = new Uint8Array(8 + frame.pixels.length);
          const header = new DataView(payload.buffer);

          header.setUint16(0, frame.x, true);
          header.setUint16(2, frame.y, true);
          header.setUint16(4, frame.width, true);
          header.setUint16(6, frame.height, true);
          payload.set(frame.pixels, 8);

          return payload;
        },
      },
    },
  }) as unknown as (context: never) => Adapter;
  const wrap =
    (id: string, create: (context: never) => Adapter) => (context: never) => {
      const adapter = create(context);

      return {
        sync: (batch: unknown) => {
          // 适配器拿到的帧体就是模型 `copyBytes` 的结果，在这里捕获发送时刻的载荷。
          if (id === 'lcd') {
            expectedFrames.push(...assembleFrames((batch as BatchOutputs).outputs));
            frameTimes.push(
              ...(batch as { outputs: { frameInfo: { time: number }[] } }).outputs.frameInfo.map(
                (info) => info.time,
              ),
            );
          }
          adapter.sync(batch);
        },
        dispose: () => adapter.dispose(),
      };
    };

  const nets = [
    {
      id: 'vdd',
      voltage: 3.3,
      pins: [
        ...VDD_PINS.map((pin) => ({ instance: 'mcu', pin })),
        { instance: 'lcd', pin: 'VDD' },
        // 参考程序不驱动 RST，板级把它接在 VDD 上。
        { instance: 'lcd', pin: 'RST' },
      ],
    },
    {
      id: 'vss',
      voltage: 0,
      pins: [...VSS_PINS.map((pin) => ({ instance: 'mcu', pin })), { instance: 'lcd', pin: 'VSS' }],
    },
    ...DATA_BITS.map((bit) => ({
      id: `d${bit}`,
      pins: [
        { instance: 'mcu', pin: `PC${bit}` },
        { instance: 'lcd', pin: `D${bit}` },
      ],
    })),
    ...CONTROL_LINES.map(([mcuPin, lcdPin]) => ({
      id: lcdPin.toLowerCase(),
      pins: [
        { instance: 'mcu', pin: mcuPin },
        { instance: 'lcd', pin: lcdPin },
      ],
    })),
  ];

  const board = createBoard(
    createDeviceLibrary([
      { id: 'mcu', model: mcuModel, create: wrap('mcu', mcuCreate) as never },
      { id: 'lcd', model: lcdModel, create: wrap('lcd', lcdCreate) as never },
    ] as never),
    {
      instances: [
        {
          id: 'mcu',
          type: 'mcu',
          props: {
            clockFrequency: JOINT_CLOCK_FREQUENCY,
          },
        },
        { id: 'lcd', type: 'lcd', props: { refreshRate: 60 } },
      ],
      nets,
    } as never,
    // 默认走 throughput（直接后端）：这是运行时的主路径。
  );

  const instances = (
    board as unknown as {
      instances?:
        | Map<string, JointInstance>
        | readonly (JointInstance & { readonly id?: string })[]
        | Record<string, JointInstance>;
    }
  ).instances;
  const mcu = instance(instances, 'mcu');
  const lcd = instance(instances, 'lcd');

  if (mcu === undefined || lcd === undefined) {
    board.dispose();
    throw new Error('joint board: missing mcu or lcd instance');
  }

  const frames: Uint8Array[] = [];
  const faults: number[] = [];
  const errors: string[] = [];
  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'fault') faults.push(message.payload as number);
    else if (message.topic === 'framebuffer') frames.push(message.payload as Uint8Array);
  });
  const diagnostics = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));

  let accountingReadout: (() => JointAccountingReadout) | undefined;

  if (options.accounting) {
    const internalMcu = mcu as unknown as InternalInstance;
    const internalLcd = lcd as unknown as InternalInstance;
    const oracle = new GramOracle();
    const counters = {
      intentCalls: 0,
      intentChanges: 0,
      wrLevelChanges: 0,
      wrRises: 0,
      selectedRises: 0,
      commandWrites: 0,
      dataWrites: 0,
      pixelWrites: 0,
      csLevelChanges: 0,
      rsLevelChanges: 0,
      dataBitLevelChanges: 0,
    };
    const base = {
      wr: sampleVersion(internalLcd, 'WR'),
      cs: sampleVersion(internalLcd, 'CS'),
      rs: sampleVersion(internalLcd, 'RS'),
      data: dataSampleVersion(internalLcd),
      gram: memoryVersion(internalLcd, 'gram'),
    };
    const originalIntent = internalMcu.writeIntent.bind(internalMcu);
    const originalSend = internalLcd.host.send;
    // publishFrames 在 frameInfo 与 frameRows 之间不挂起；此处 oracle 与全部行同刻。
    internalLcd.host.send = (name, value) => {
      if (name === 'frameInfo')
        oracle.captureFrame(value as Parameters<GramOracle['captureFrame']>[0]);
      originalSend(name, value);
    };

    /** WR 上升沿：CS 有效时按 RS 把当前 intent 电平解码成命令/数据。 */
    const latch = (): void => {
      if (intentLevel(internalMcu.pins.get('PB9')) !== 0) return;
      counters.selectedRises += 1;
      const register = intentLevel(internalMcu.pins.get('PB8')) === 1;
      let value = 0;

      for (let bit = 0; bit < 16; bit += 1)
        if (intentLevel(internalMcu.pins.get(`PC${bit}`)) === 1) value |= 1 << bit;

      if (register) {
        counters.dataWrites += 1;
        if (oracle.data(value)) counters.pixelWrites += 1;
      } else {
        counters.commandWrites += 1;
        oracle.command(value);
      }
    };

    // Both the interpreter and the direct JIT write through this entry point.
    internalMcu.writeIntent = (ref, value) => {
      const name = String(ref);
      const pin = internalMcu.pins.get(name);
      const previous = intentLevel(pin);
      const changed = originalIntent(ref, value);
      counters.intentCalls += 1;
      if (changed) counters.intentChanges += 1;

      const next = intentLevel(pin);

      if (previous === next) return changed;
      if (name === 'PB5') {
        counters.wrLevelChanges += 1;
        if (previous === 0 && next === 1) {
          counters.wrRises += 1;
          latch();
        }
      } else if (name === 'PB9') counters.csLevelChanges += 1;
      else if (name === 'PB8') counters.rsLevelChanges += 1;
      else if (/^PC(?:[0-9]|1[0-5])$/.test(name)) counters.dataBitLevelChanges += 1;
      return changed;
    };

    accountingReadout = () => ({
      timePs: board.time,
      ...counters,
      wrSamples: sampleVersion(internalLcd, 'WR') - base.wr,
      csSamples: sampleVersion(internalLcd, 'CS') - base.cs,
      rsSamples: sampleVersion(internalLcd, 'RS') - base.rs,
      dataSamples: dataSampleVersion(internalLcd) - base.data,
      gramStores: memoryVersion(internalLcd, 'gram') - base.gram,
      oracleGramStores: oracle.stores,
      fullScreenFills: [...oracle.fullScreenFills],
      oracleGram: oracle.gram.slice(),
      oracleFrames: oracle.frames,
    });
  }

  return {
    board,
    frames,
    frameTimes,
    expectedFrames,
    faults,
    errors,
    mcu,
    lcd,
    advanceTo(targetPs) {
      while (board.time < targetPs && faults.length === 0 && errors.length === 0) {
        const previous = board.time;
        board.runUntil(Math.min(board.time + JOINT_TIME_QUANTUM_PS, targetPs));
        if (board.time === previous)
          throw new Error(`joint board: time did not advance at ${previous} ps`);
      }
    },
    readAccounting: () => accountingReadout?.(),
    dispose() {
      subscription.dispose();
      diagnostics.dispose();
      board.dispose();
    },
  };
}
