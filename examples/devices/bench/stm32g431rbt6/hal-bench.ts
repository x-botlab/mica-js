import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { adaptModelFactory, firmwareImage } from '../../test/support/legacy-model-bridge.mjs';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';

/**
 * CT117E-M4 的 Keil HAL 示例固件（`HAL_06_LCD`）在裸 MCU 板上的基准。
 *
 * 固件是真实工程产物，不是合成夹具：启动时执行 `SystemClock_Config`（HSI16 → PLL
 * 80 MHz，轮询 PWR 的 VOSF）、`MX_GPIO_Init`、`MX_USART1_UART_Init`，随后是 ILI9325 的
 * BSP 初始化（背光、寄存器序列、多次 `HAL_Delay`）。`HAL_Delay` 靠 SysTick 中断推进
 * `uwTick`，因此这个窗口同时覆盖 GPIO、RCC、PWR、USART、SysTick、NVIC 与 Flash 取指，
 * 而不是某一条外设路径。
 *
 * 口径：
 * - 裸 MCU 板（只接 VDD/VSS），不接 LCD；MCU 的 GPIO 边沿仍照常发布；
 * - 80 MHz 是固件自己配置的主频，`HAL_Delay` 的换算依赖它；
 * - 分别报告墙钟和进程 CPU 时间；三轮分别记录，避免把热缓存算成冷启动；
 * - 每种 `execution` 单独一个测试文件：器件的 `blockCache` 是模块级的，同进程里先跑完
 *   一种模式会把翻译缓存焐热，让另一种模式的冷启动读数失真。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const FIRMWARE = join(
  import.meta.dirname,
  '..',
  '..',
  'test',
  'ili9325',
  'fixtures',
  'HAL_06_LCD.bin',
);

export const CLOCK = 80_000_000;
const PS_PER_MS = 1_000_000_000;
/** 复位 → PLL 切换 → 外设初始化完成、进入第一个 `HAL_Delay`。 */
export const COLD_PS = 200 * 1_000_000;
const MID_MS = 220;
// 220 ms 仍在初始化等待中。360–390 ms 在清屏中，已覆盖所需的热块，
// 且尚未进入清屏后的下一批新代码和 1000 ms 等待。
const DRAW_START_MS = 360;
const DRAW_END_MS = 390;
const END_MS = 440;
const ROUNDS = 3;

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

interface Adapter {
  sync(batch: unknown): void;
  dispose(): void;
}

interface DirectStats {
  readonly directCompiles: number;
  readonly directShards: number;
  readonly directCalls: number;
  readonly directFallbacks: number;
}

interface JitLike {
  readonly cache: ReadonlyMap<number, unknown>;
  readonly revision: number;
  readonly direct?: {
    readonly program?: { readonly run?: () => unknown; readonly shards?: number };
  };
  readonly directPrograms?: ReadonlyMap<string, unknown>;
  readonly directStats?: DirectStats;
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly sampleResources: ReadonlyMap<string, { readonly version: number }>;
}

const firmware = new Uint8Array(readFileSync(FIRMWARE));

const model = await compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
  uri: 'mica:devices/stm32g431rbt6/model.ddl',
});

const module = (await import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href)) as {
  create: unknown;
};
const image = firmwareImage([{ addressSpace: 'code', address: 0x0800_0000, data: firmware }]);
const create = adaptModelFactory(module.create as never, {
  props: { clockFrequency: CLOCK, firmware: image },
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

function bareBoard(execution: 'precise' | 'throughput'): Board {
  return createBoard(
    createDeviceLibrary([{ id: 'mcu', model, create: create as never }]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: CLOCK } }],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
      ],
    },
    { execution },
  );
}

const timed = (fn: () => void) => {
  const before = process.cpuUsage();
  const start = performance.now();
  fn();
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(before);
  return { wallMs, cpuMs: (usage.user + usage.system) / 1000 };
};

const shardCount = (jit: JitLike | undefined): number => {
  const reported = jit?.directStats?.directShards ?? jit?.direct?.program?.shards;

  if (reported !== undefined) return reported;
  const dispatcher = jit?.direct?.program?.run?.toString() ?? '';
  const resident = dispatcher.match(/const D\d+ = SH\[/g)?.length ?? 0;
  const split = new Set(dispatcher.match(/stepShard\d+/g) ?? []).size;

  return resident || split || (dispatcher ? 1 : 0);
};

export function measureHal(execution: 'precise' | 'throughput') {
  const rounds = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    let board: Board | undefined;
    try {
      const cold = timed(() => {
        board = bareBoard(execution);
        board.runUntil(0);
        board.runUntil(COLD_PS);
      });
      const running = board!;
      const { jits, instances } = running as unknown as {
        jits: readonly JitLike[];
        instances: readonly InstanceView[];
      };
      const [jit] = jits;
      const [mcu] = instances;
      const counts = () => ({
        blocks: jit!.cache.size,
        revision: jit!.revision,
        compiles: jit!.directStats?.directCompiles ?? 0,
        calls: jit!.directStats?.directCalls ?? 0,
        fallbacks: jit!.directStats?.directFallbacks ?? 0,
        wrSamples: mcu!.sampleResources.get('PB5')!.version,
      });
      const advance = (endMs: number) => {
        const startMs = running.time / PS_PER_MS;
        const before = counts();
        const target = endMs * PS_PER_MS;
        const elapsed = timed(() => {
          while (running.time < target)
            running.runUntil(Math.min(running.time + 10 * PS_PER_MS, target));
        });
        const after = counts();
        return {
          fromMs: startMs,
          toMs: running.time / PS_PER_MS,
          ...elapsed,
          realtimeFactor: (endMs - startMs) / elapsed.wallMs,
          blocks: after.blocks - before.blocks,
          revision: after.revision - before.revision,
          compiles: after.compiles - before.compiles,
          calls: after.calls - before.calls,
          fallbacks: after.fallbacks - before.fallbacks,
          wrSamples: after.wrSamples - before.wrSamples,
        };
      };
      const initialization = advance(MID_MS);
      const drawingEntry = advance(DRAW_START_MS);
      const drawing = advance(DRAW_END_MS);
      const drawingExit = advance(END_MS);
      const postWallMs = drawingEntry.wallMs + drawing.wallMs + drawingExit.wallMs;
      rounds.push({
        cold,
        initialization,
        drawingEntry,
        drawing,
        drawingExit,
        postWallMs,
        postRealtimeFactor: (END_MS - MID_MS) / postWallMs,
        ...counts(),
        direct: jit?.direct !== undefined && jit.direct !== null,
        programs: jit?.directPrograms?.size ?? 0,
        shards: shardCount(jit),
        status: running.status,
        halted: mcu!.states.get('halted'),
      });
    } finally {
      board?.dispose();
    }
  }
  return { execution, clockFrequency: CLOCK, rounds };
}
