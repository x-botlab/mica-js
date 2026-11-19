import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../../devices/test/support/legacy-model-bridge.mjs';
import type { Board } from '@mica-js/sdk';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * CT117E-M4 单器件夹具：只装载构建产物 `dist/model.js`。
 *
 * 器件把 STM32G431RBT6 与 ILI9325 的固定接线合成一个模型：一个 instance、一个
 * JIT，外部只接 VDD1/VSS1。测试不退回 `src/`，也不重新拼接两个兄弟 example。
 * 旧 `createBoard` 兼容边界把统一事件映射回旧话题，并把测试固件包装成 FirmwareImage。
 */

const FLASH_BASE = 0x0800_0000;

export const CT117E_M4_DEVICE_ID = 'ct117e-m4';
export const CT117E_M4_INSTANCE_ID = 'ct117e-m4';
export const CT117E_M4_CLOCK_FREQUENCY = 80_000_000;
export const CT117E_M4_REFRESH_RATE = 60;

/** 与历次基准读数保持一致的单次 `runUntil` 跨度。 */
export const CT117E_M4_TIME_QUANTUM_PS = 200_000_000;
/** 220 ms：前半程检查点，覆盖初始化后的持续绘图与首屏清屏。 */
export const CT117E_M4_MID_TIME_PS = 220_000_000_000;
/** 440 ms：正式窗口，覆盖三次整屏清屏、局部绘图与 10 帧发布。 */
export const CT117E_M4_END_TIME_PS = 440_000_000_000;
export const CT117E_M4_CLEAR_START_PS = 360_000_000_000;
export const CT117E_M4_CLEAR_END_PS = 390_000_000_000;

/**
 * `HAL_06_LCD.hex` 的固定工作量，与分立 LCD 总线 oracle 对账。
 *
 * 这些数字约束 MCU 实际发出的写周期，不是允许漏边沿的容差。`wrChanges` 是融合
 * 模型内部记录的 WR 电平变化，`gramStores` 是每个真正落进 GRAM 的像素写。
 */
export const CT117E_M4_EXPECTED = Object.freeze({
  midpoint: Object.freeze({
    wrChanges: 80,
    gramStores: 0,
    frames: 0,
    nonZeroPixels: 0,
  }),
  clear: Object.freeze({
    wrChanges: 104_338,
    gramStores: 52_169,
    frames: 2,
  }),
  final: Object.freeze({
    wrChanges: 157_338,
    gramStores: 77_351,
    frames: 3,
    nonZeroPixels: 76_800,
  }),
});

const ARTIFACT_JS = resolve(import.meta.dirname, '..', 'dist', 'model.js');

interface OutputMessage {
  readonly time: number;
  readonly value: unknown;
}

type Outputs = Readonly<Record<string, readonly OutputMessage[]>>;

interface ArtifactAdapter {
  readonly methods?: Readonly<Record<string, (params: unknown) => unknown>>;
  sync(batch: { readonly from: number; readonly to: number; readonly outputs: Outputs }): void;
  dispose(): void;
}

interface DeviceModule {
  readonly model: DeviceIR;
  readonly create: (context: never) => ArtifactAdapter;
}

interface RawDeviceModule {
  readonly model?: DeviceIR;
  readonly create?: (context: never) => ArtifactAdapter;
}

interface DeviceInstanceState {
  readonly id?: string;
  readonly jits: readonly unknown[];
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

export interface Workload {
  readonly timePs: number;
  readonly wrChanges: number;
  readonly gramStores: number;
  readonly frames: number;
  readonly framePixels: number;
  readonly nonZeroPixels: number;
}

export function lcdWorkDelta(before: Workload, after: Workload) {
  return {
    wrChanges: after.wrChanges - before.wrChanges,
    gramStores: after.gramStores - before.gramStores,
    frames: after.frames - before.frames,
  };
}

export interface HarnessOptions {
  readonly firmware: Uint8Array;
  readonly clockFrequency?: number;
  readonly refreshRate?: number;
  /**
   * 是否在每次 `sync` 重建模型侧完整帧载荷与帧时间。正式用例需要；性能基准关闭，
   * 只保留话题帧引用，避免把测试用的合帧复制计进计时窗口。
   */
  readonly captureExpectedFrames?: boolean;
}

export interface Harness {
  readonly board: Board;
  readonly instance: DeviceInstanceState;
  readonly frames: readonly Uint8Array[];
  readonly expectedFrames: readonly Uint8Array[];
  readonly frameTimes: readonly number[];
  readonly faults: readonly number[];
  readonly errors: readonly string[];
  state(name: string): unknown;
  memory(name: string): Uint8Array;
  workload(): Workload;
  /** 按固定步长推进到目标虚拟时间。 */
  advanceTo(targetPs: number, quantumPs?: number): void;
  dispose(): void;
}

let artifactPromise: Promise<DeviceModule> | undefined;

/** 构建产物是否已经生成；仅用于诊断，不用于跳过正式用例。 */
export function artifactAvailable(): boolean {
  return existsSync(ARTIFACT_JS);
}

function loadArtifact(): Promise<DeviceModule> {
  artifactPromise ??= (async () => {
    if (!existsSync(ARTIFACT_JS))
      throw new Error(`Missing ${ARTIFACT_JS}; run "mica build" before the tests`);

    const imported = (await import(pathToFileURL(ARTIFACT_JS).href)) as RawDeviceModule;

    if (imported.model === undefined || imported.create === undefined)
      throw new Error(`${ARTIFACT_JS} must export both \`model\` and \`create\``);

    return { model: imported.model, create: imported.create };
  })();

  return artifactPromise;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);

  if (value !== null && typeof value === 'object' && 'length' in value) {
    const source = value as { readonly length: number; readonly [index: number]: number };
    const bytes = new Uint8Array(source.length);

    for (let index = 0; index < source.length; index += 1) bytes[index] = source[index]!;
    return bytes;
  }

  throw new TypeError('Expected a bytes payload');
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function rectOf(value: unknown): Rect {
  if (value === null || typeof value !== 'object')
    throw new TypeError('frameInfo payload must be a rectangle');

  const record = value as Record<string, unknown>;
  const x = Number(record['x']);
  const y = Number(record['y']);
  const width = Number(record['width']);
  const height = Number(record['height']);

  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new TypeError('frameInfo payload has an invalid rectangle');

  return { x, y, width, height };
}

/** 按适配器的配对规则重建模型在帧体发送时刻交给它的完整帧载荷。 */
function assembleFrames(
  infos: readonly OutputMessage[],
  rows: readonly OutputMessage[],
): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let at = 0;

  for (const info of infos) {
    const { x, y, width, height } = rectOf(info.value);
    const body = width * height * 2;
    const frame = new Uint8Array(8 + body);
    const header = new DataView(frame.buffer);

    header.setUint16(0, x, true);
    header.setUint16(2, y, true);
    header.setUint16(4, width, true);
    header.setUint16(6, height, true);

    let filled = 0;

    while (filled < body) {
      const row = rows[at];

      if (row === undefined) throw new Error(`frameRows ended before frame ${frames.length + 1}`);

      const chunk = toBytes(row.value);

      if (chunk.length === 0) throw new Error('frameRows contains an empty chunk');
      if (chunk.length > body - filled)
        throw new Error(`frameRows chunk crosses frame ${frames.length + 1}`);

      frame.set(chunk, 8 + filled);
      filled += chunk.length;
      at += 1;
    }

    frames.push(frame);
  }

  if (at !== rows.length)
    throw new Error(`frameRows contains ${rows.length - at} unexpected trailing chunk(s)`);

  return frames;
}

function captureOutputs(
  outputs: Outputs,
  expectedFrames: Uint8Array[],
  frameTimes: number[],
): void {
  const infos = outputs['frameInfo'];

  if (infos !== undefined) {
    const rows = outputs['frameRows'] ?? [];

    expectedFrames.push(...assembleFrames(infos, rows));
    for (const info of infos) frameTimes.push(info.time);
    return;
  }

  const buffers = outputs['framebuffer'];

  if (buffers !== undefined)
    for (const message of buffers) {
      expectedFrames.push(toBytes(message.value));
      frameTimes.push(message.time);
    }
}

function findInstance(value: unknown): DeviceInstanceState | undefined {
  if (value instanceof Map)
    return value.get(CT117E_M4_INSTANCE_ID) as DeviceInstanceState | undefined;

  if (Array.isArray(value))
    return (value as readonly DeviceInstanceState[]).find(
      (entry) => entry.id === CT117E_M4_INSTANCE_ID,
    );

  if (value !== null && typeof value === 'object')
    return (value as Record<string, DeviceInstanceState>)[CT117E_M4_INSTANCE_ID];

  return undefined;
}

function countNonZeroPixels(gram: Uint8Array): number {
  const view = new DataView(gram.buffer, gram.byteOffset, gram.byteLength);
  let count = 0;

  for (let at = 0; at + 1 < gram.length; at += 2) if (view.getUint16(at, true) !== 0) count += 1;
  return count;
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let at = 0; at < left.length; at += 1) if (left[at] !== right[at]) return false;
  return true;
}

export function sameFrames(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!sameBytes(left[index]!, right[index]!)) return false;
  return true;
}

/** 创建一块全新的单器件板；构建产物模块在进程内只加载一次。 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const { model, create } = await loadArtifact();
  const captureExpectedFrames = options.captureExpectedFrames ?? true;
  const frames: Uint8Array[] = [];
  const expectedFrames: Uint8Array[] = [];
  const frameTimes: number[] = [];
  const faults: number[] = [];
  const errors: string[] = [];

  const createAdapter = (context: never): ArtifactAdapter => {
    const adapted = adaptModelFactory(create as never, {
      props: (legacy) => ({
        ...(legacy.props as Readonly<Record<string, unknown>>),
        firmware: firmwareImage([
          {
            addressSpace: 'flash',
            address: FLASH_BASE,
            data: options.firmware,
          },
        ]),
      }),
      events: {
        onDidFramebuffer: 'framebuffer',
        onDidFault: 'fault',
        onDidSerial1Tx: 'serial1.tx',
        onDidSerial2Tx: 'serial2.tx',
        onDidSerial3Tx: 'serial3.tx',
      },
    });
    const adapter = adapted(context);

    return {
      methods: adapter.methods as Readonly<Record<string, (params: unknown) => unknown>>,
      sync(batch) {
        if (captureExpectedFrames) captureOutputs(batch.outputs, expectedFrames, frameTimes);
        adapter.sync(batch);
      },
      dispose: () => adapter.dispose(),
    };
  };

  const board = createBoard(
    createDeviceLibrary([{ id: CT117E_M4_DEVICE_ID, model, create: createAdapter as never }]),
    {
      instances: [
        {
          id: CT117E_M4_INSTANCE_ID,
          type: CT117E_M4_DEVICE_ID,
          props: {
            clockFrequency: options.clockFrequency ?? CT117E_M4_CLOCK_FREQUENCY,
            refreshRate: options.refreshRate ?? CT117E_M4_REFRESH_RATE,
          },
        },
      ],
      nets: [
        {
          id: 'vdd',
          voltage: 3.3,
          pins: [{ instance: CT117E_M4_INSTANCE_ID, pin: 'VDD1' }],
        },
        {
          id: 'vss',
          voltage: 0,
          pins: [{ instance: CT117E_M4_INSTANCE_ID, pin: 'VSS1' }],
        },
      ],
    } as never,
  );

  const instance = findInstance((board as unknown as { instances?: unknown }).instances);

  if (instance === undefined) {
    board.dispose();
    throw new Error('ct117e-m4 board did not expose its single instance');
  }

  const subscription = board.topics.onDidReceive((message) => {
    if (message.topic === 'framebuffer') frames.push(toBytes(message.payload));
    else if (message.topic === 'fault') faults.push(Number(message.payload));
  });
  const diagnostics = board.onDidError((error) => errors.push(`${error.code}: ${error.message}`));

  const state = (name: string): unknown => {
    if (!instance.states.has(name)) throw new Error(`Missing state ${name}`);
    return instance.states.get(name);
  };

  const memory = (name: string): Uint8Array => {
    const value = instance.memories.get(name);

    if (value === undefined) throw new Error(`Missing memory ${name}`);
    return value;
  };

  return {
    board,
    instance,
    frames,
    expectedFrames,
    frameTimes,
    faults,
    errors,
    state,
    memory,
    workload(): Workload {
      const wrChanges = state('fusedWrChanges');
      const gramStores = state('fusedGramStores');

      if (typeof wrChanges !== 'number' || typeof gramStores !== 'number')
        throw new Error('ct117e-m4 must expose fusedWrChanges and fusedGramStores as numbers');

      let framePixels = 0;

      for (const frame of frames) {
        if (frame.length < 8)
          throw new Error('framebuffer payload is shorter than its 8-byte header');

        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const width = view.getUint16(4, true);
        const height = view.getUint16(6, true);

        if (frame.length !== 8 + width * height * 2)
          throw new Error(`framebuffer ${width}x${height} body mismatch: ${frame.length} bytes`);

        framePixels += width * height;
      }

      return {
        timePs: board.time,
        wrChanges,
        gramStores,
        frames: frames.length,
        framePixels,
        nonZeroPixels: countNonZeroPixels(memory('gram')),
      };
    },
    advanceTo(targetPs, quantumPs = CT117E_M4_TIME_QUANTUM_PS) {
      if (!Number.isSafeInteger(targetPs) || targetPs < board.time)
        throw new Error(`Invalid advance target ${targetPs} ps`);
      if (!Number.isSafeInteger(quantumPs) || quantumPs <= 0)
        throw new Error(`Invalid advance quantum ${quantumPs} ps`);

      while (board.time < targetPs) {
        const previous = board.time;

        try {
          board.runUntil(previous + Math.min(quantumPs, targetPs - previous));
        } catch (cause) {
          throw new Error(
            `ct117e-m4 failed at ${board.time} ps (pc=${String(instance.states.get('pc'))}, ` +
              `errors=${errors.join('; ') || 'none'}, faults=${faults.join(',') || 'none'})`,
            { cause },
          );
        }

        if (board.time === previous)
          throw new Error(`ct117e-m4 did not advance past ${previous} ps`);
      }
    },
    dispose() {
      subscription.dispose();
      diagnostics.dispose();
      board.dispose();
    },
  };
}
