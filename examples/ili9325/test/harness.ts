import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import type { DeviceIR } from '@mica-js/sdk/model';
import { MASTER_MODEL, SINK_MODEL } from './master';

/**
 * 板级夹具：现场编译 ILI9325 的 `model.ddl`，装载 `src/` 的适配器，再用一个
 * 8080 总线主设备驱动它。全部走真实的 `@mica-js/simulator` 板：电气求解、同步
 * 反应、通道与话题都是运行时行为，不做替身。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'ili9325');
const ARTIFACT_JS = join(import.meta.dirname, '..', 'dist', 'devices', 'ili9325', 'device.js');

export const PANEL_WIDTH = 320;
export const PANEL_HEIGHT = 240;
export const GRAM_WIDTH = 240;
export const GRAM_HEIGHT = 320;

export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint16Array;
}

export interface ChannelStats {
  /** `frameInfo` 消息数：一帧一条。 */
  infos: number;
  /** `frameRows` 消息数：整行矩形一条，其余每行一条。 */
  rows: number;
}

interface Adapter {
  sync(batch: {
    readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
  }): void;
  dispose(): void;
}

export interface CircuitOptions {
  readonly refreshRate?: number;
  readonly accessPeriod?: number;
  /** `artifact` 装载 `dist/devices/ili9325/device.js`，默认装载 `src/`。 */
  readonly variant?: 'source' | 'artifact';
  /** `sink` 用同引脚的空白器件替代 ILI9325，仅用于性能对照。 */
  readonly target?: 'lcd' | 'sink';
}

export interface Op {
  readonly command?: boolean;
  readonly read?: boolean;
  readonly selected?: boolean;
  readonly pulse?: boolean;
  readonly value?: number;
  readonly count?: number;
}

export interface Circuit {
  readonly frames: readonly Frame[];
  readonly stats: ChannelStats;
  readonly reads: readonly number[];
  readonly faults: readonly string[];
  readonly time: number;
  /** 一帧的合帧周期（ps）。 */
  readonly framePeriod: number;
  /** 排队一次命令写数据（RS=低）。 */
  command(value: number, options?: { readonly selected?: boolean }): void;
  /** 排队一次数据写（RS=高）；`count` 为连续写入的像素/数据个数。 */
  data(value: number, count?: number, options?: { readonly selected?: boolean }): void;
  /** 排队一次读周期；结果出现在 `reads`。 */
  read(options?: { readonly selected?: boolean }): void;
  /** 排队一次 RST 脉冲。 */
  pulseReset(): void;
  /** 发送排队的操作并推进到它们全部完成。 */
  drain(): void;
  /** 继续推进指定的仿真时长。 */
  run(durationPs: number): void;
  dispose(): void;
}

interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => Adapter;
}

let sourceCache: Promise<DeviceModule> | undefined;
let artifactCache: Promise<DeviceModule> | undefined;
let masterCache: Promise<DeviceIR> | undefined;
let sinkCache: Promise<DeviceIR> | undefined;

function loadSource(): Promise<DeviceModule> {
  sourceCache ??= (async () => {
    const [model, adapter] = await Promise.all([
      compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
        uri: 'mica:devices/ili9325/model.ddl',
      }),
      import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
        default: (context: never) => Adapter;
      }>,
    ]);

    return { model, create: adapter.default };
  })();

  return sourceCache;
}

function loadArtifact(): Promise<DeviceModule> {
  artifactCache ??= (async () => {
    const module = (await import(pathToFileURL(ARTIFACT_JS).href)) as DeviceModule;

    return { model: module.model, create: module.create };
  })();

  return artifactCache;
}

function masterModel(): Promise<DeviceIR> {
  masterCache ??= compileDDL(MASTER_MODEL, { uri: 'mica:test/master.ddl' });
  return masterCache;
}

function sinkModel(): Promise<DeviceIR> {
  sinkCache ??= compileDDL(SINK_MODEL, { uri: 'mica:test/sink.ddl' });
  return sinkCache;
}

/** 构建产物是否已经生成；未生成时跳过产物用例。 */
export function artifactAvailable(): boolean {
  return existsSync(ARTIFACT_JS);
}

const DATA_PINS = Array.from({ length: 16 }, (_, index) => index as number);
const CONTROL_PINS = ['WR', 'RD', 'RS', 'CS', 'RST'] as const;

function decodeFrame(bytes: Uint8Array): Frame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x = view.getUint16(0, true);
  const y = view.getUint16(2, true);
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const pixels = new Uint16Array(width * height);

  for (let index = 0; index < pixels.length; index += 1)
    pixels[index] = view.getUint16(8 + index * 2, true);

  expectPixels(bytes, width, height);

  return { x, y, width, height, pixels };
}

function expectPixels(bytes: Uint8Array, width: number, height: number): void {
  if (bytes.length !== 8 + width * height * 2)
    throw new Error(`frame body ${bytes.length} bytes does not match ${width}x${height}`);
}

/** 把区域更新按顺序贴到一张 320×240 的面板图上。 */
export function compose(frames: readonly Frame[], fill = 0): Uint16Array {
  const panel = new Uint16Array(PANEL_WIDTH * PANEL_HEIGHT).fill(fill);

  for (const frame of frames)
    for (let row = 0; row < frame.height; row += 1)
      panel.set(
        frame.pixels.subarray(row * frame.width, (row + 1) * frame.width),
        (frame.y + row) * PANEL_WIDTH + frame.x,
      );

  return panel;
}

/** 面板像素读数（面板坐标）。 */
export function pixel(panel: Uint16Array, x: number, y: number): number {
  return panel[y * PANEL_WIDTH + x]!;
}

export async function circuit(options: CircuitOptions = {}): Promise<Circuit> {
  const refreshRate = options.refreshRate ?? 60;
  const accessPeriod = options.accessPeriod ?? 100_000;
  const sink = options.target === 'sink';
  const [loaded, master, sinkIr] = await Promise.all([
    options.variant === 'artifact' ? loadArtifact() : loadSource(),
    masterModel(),
    sink ? sinkModel() : Promise.resolve(undefined),
  ]);
  const device: DeviceModule = sink
    ? { model: sinkIr!, create: () => ({ sync() {}, dispose() {} }) }
    : loaded;

  const frames: Frame[] = [];
  const stats: ChannelStats = { infos: 0, rows: 0 };
  const reads: number[] = [];
  const faults: string[] = [];
  const pending: Op[] = [];
  let queue: ((value: unknown) => void) | undefined;

  const instrument = (context: {
    readonly topics: { publish(topic: string, payload: unknown): void };
  }) => {
    const adapter = device.create(context as never);

    return {
      sync(batch: {
        readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
      }) {
        stats.infos += batch.outputs.frameInfo?.length ?? 0;
        stats.rows += batch.outputs.frameRows?.length ?? 0;
        adapter.sync(batch);
      },
      dispose: () => adapter.dispose(),
    };
  };

  const createMaster = (context: {
    readonly inputs: Record<string, { send(value: unknown): void }>;
  }) => {
    queue = (value: unknown) => context.inputs.op!.send(value);

    return {
      sync(batch: {
        readonly outputs: Readonly<Record<string, readonly { readonly value: unknown }[]>>;
      }) {
        for (const message of batch.outputs.readData ?? []) reads.push(message.value as number);
      },
      dispose() {},
    };
  };

  const entries = [
    { id: 'lcd', model: device.model, create: instrument as never },
    { id: 'master', model: master, create: createMaster as never },
  ];

  const instances = [
    sink ? { id: 'lcd', type: 'lcd' } : { id: 'lcd', type: 'lcd', props: { refreshRate } },
    {
      id: 'master',
      type: 'master',
      props: { accessPeriod },
    },
  ];

  const nets = [
    {
      id: 'vdd',
      pins: [
        { instance: 'lcd', pin: 'VDD' },
        { instance: 'master', pin: 'vcc' },
      ],
      voltage: 3.3,
    },
    {
      id: 'vss',
      pins: [
        { instance: 'lcd', pin: 'VSS' },
        { instance: 'master', pin: 'gnd' },
      ],
      voltage: 0,
    },
    ...DATA_PINS.map((bit) => ({
      id: `d${bit}`,
      pins: [
        { instance: 'lcd', pin: `D${bit}` },
        { instance: 'master', pin: `d${bit}` },
      ],
    })),
    ...CONTROL_PINS.map((name) => ({
      id: name.toLowerCase(),
      pins: [
        { instance: 'lcd', pin: name },
        { instance: 'master', pin: name.toLowerCase() },
      ],
    })),
  ];

  const board = createBoard(createDeviceLibrary(entries as never), {
    instances,
    nets,
  } as never);

  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic !== 'framebuffer') return;
    frames.push(decodeFrame(message.payload as Uint8Array));
  });
  const errors = board.onDidError((error) => faults.push(error.message));

  board.runUntil(0);

  /** 每个排队操作的仿真耗时：写/读各两个 HALF，RST 脉冲四个 HALF。 */
  const durationOf = (op: Op): number => {
    if (op.pulse) return accessPeriod * 2;
    if (op.read) return accessPeriod;
    const count = Math.max(1, op.count ?? 1);

    return count * accessPeriod + accessPeriod / 2;
  };

  const send = (op: Op) => {
    if (queue === undefined) throw new Error('master factory did not run');
    // 记录载荷字段全部必填：在边界处补齐，调用点只写关心的字段。
    queue({
      command: op.command ?? false,
      read: op.read ?? false,
      selected: op.selected ?? true,
      pulse: op.pulse ?? false,
      value: op.value ?? 0,
      count: op.count ?? 0,
    });
  };

  return {
    frames,
    stats,
    reads,
    faults,
    framePeriod: Math.round(1_000_000_000_000 / refreshRate),
    get time() {
      return board.time;
    },
    command(value, options = {}) {
      pending.push({
        command: true,
        selected: options.selected ?? true,
        value,
      });
    },
    data(value, count = 1, options = {}) {
      pending.push({
        command: false,
        selected: options.selected ?? true,
        value,
        count,
      });
    },
    read(options = {}) {
      pending.push({ command: false, read: true, selected: options.selected ?? true });
    },
    pulseReset() {
      pending.push({ pulse: true });
    },
    drain() {
      let duration = 0;

      for (const op of pending) {
        send(op);
        duration += durationOf(op);
      }
      pending.length = 0;
      if (duration > 0) board.runUntil(board.time + duration);
    },
    run(durationPs) {
      board.runUntil(board.time + durationPs);
    },
    dispose() {
      subscription.dispose();
      errors.dispose();
      board.dispose();
    },
  };
}
