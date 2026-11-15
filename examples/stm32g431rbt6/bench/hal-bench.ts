import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';

/**
 * CT117E-M4 的 Keil HAL 示例固件（`HAL_06_LCD`）在裸 MCU 板上的基准。
 *
 * 固件是真实工程产物，不是合成夹具：`main` 之前就跑完 `SystemClock_Config`（HSI16 → PLL
 * 80 MHz，轮询 PWR 的 VOSF）、`MX_GPIO_Init`、`MX_USART1_UART_Init`，随后是 ILI9325 的
 * BSP 初始化（背光、寄存器序列、多次 `HAL_Delay`）。`HAL_Delay` 靠 SysTick 中断推进
 * `uwTick`，因此这个窗口同时覆盖 GPIO、RCC、PWR、USART、SysTick、NVIC 与 Flash 取指，
 * 而不是某一条外设路径。
 *
 * 口径：
 * - 裸 MCU 板（只接 VDD/VSS），不接 LCD，排除电气求解与话题发布；
 * - 80 MHz 是固件自己配置的主频，`HAL_Delay` 的换算依赖它；
 * - 进程 CPU 时间（不是挂钟），三轮取最小值；
 * - 每种 `execution` 单独一个测试文件：器件的 `blockCache` 是模块级的，同进程里先跑完
 *   一种模式会把翻译缓存焐热，让另一种模式的冷启动读数失真。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'stm32g431rbt6');
const FIRMWARE = join(
  import.meta.dirname,
  '..',
  '..',
  'ili9325',
  'test',
  'fixtures',
  'HAL_06_LCD.bin',
);

export const CLOCK = 80_000_000;
const PS_PER_MS = 1_000_000_000;
/** 复位 → PLL 切换 → 外设初始化完成、进入第一个 `HAL_Delay`。 */
export const COLD_PS = 200 * 1_000_000;
/** 继续推进到 220 ms：覆盖 SysTick 周期中断、多个 `HAL_Delay` 与 LCD 初始化写序列。 */
export const STEADY_MS = 220;
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
  readonly direct?: {
    readonly program?: { readonly run?: () => unknown; readonly shards?: number };
  };
  readonly directPrograms?: ReadonlyMap<string, unknown>;
  readonly directStats?: DirectStats;
}

const firmware = new Uint8Array(readFileSync(FIRMWARE));

const model = await compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
  uri: 'mica:devices/stm32g431rbt6/model.ddl',
});

const module = (await import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href)) as {
  default: (context: never) => Adapter;
};

function bareBoard(execution: 'precise' | 'throughput'): Board {
  return createBoard(
    createDeviceLibrary([{ id: 'mcu', model, create: module.default as never }]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { firmware, clockFrequency: CLOCK } }],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
      ],
    },
    { execution },
  );
}

const cpuMs = (fn: () => void): number => {
  const before = process.cpuUsage();

  fn();

  const usage = process.cpuUsage(before);

  return (usage.user + usage.system) / 1000;
};

const min = (values: readonly number[]): number => Math.min(...values);

const shardCount = (jit: JitLike | undefined): number => {
  const reported = jit?.directStats?.directShards ?? jit?.direct?.program?.shards;

  if (reported !== undefined) return reported;
  const dispatcher = jit?.direct?.program?.run?.toString() ?? '';
  const resident = dispatcher.match(/const D\d+ = SH\[/g)?.length ?? 0;
  const split = new Set(dispatcher.match(/stepShard\d+/g) ?? []).size;

  return resident || split || (dispatcher ? 1 : 0);
};

export interface HalSample {
  readonly execution: 'precise' | 'throughput';
  readonly clockFrequency: number;
  /** 0 → 200 µs 的 CPU 时间。 */
  readonly coldMs: number;
  /** 200 µs → 220 ms 的 CPU 时间。 */
  readonly steadyMs: number;
  /** 程序完整后 220 ms → 440 ms 的 CPU 时间；此窗口不再重建。 */
  readonly postMs: number;
  readonly totalMs: number;
  /** 稳态窗口的仿真时间 / 墙钟时间：大于 1 表示快于实时。 */
  readonly steadyRealtimeFactor: number;
  /** 无重建窗口的仿真时间 / 墙钟时间。 */
  readonly postRealtimeFactor: number;
  /** 整段仿真（含冷启动）的实时倍率。 */
  readonly realtimeFactor: number;
  readonly direct: boolean;
  readonly programs: number;
  readonly blocks: number;
  readonly shards: number;
  readonly compiles: number;
  readonly calls: number;
  readonly fallbacks: number;
  /** 220 ms → 440 ms 窗口内新增的编译、直接调用与回退次数。 */
  readonly postCompiles: number;
  readonly postCalls: number;
  readonly postFallbacks: number;
}

export function measureHal(execution: 'precise' | 'throughput'): HalSample {
  const cold: number[] = [];
  const steady: number[] = [];
  const post: number[] = [];
  let direct = false;
  let programs = 0;
  let blocks = 0;
  let shards = 0;
  let compiles = 0;
  let calls = 0;
  let fallbacks = 0;
  let postCompiles = 0;
  let postCalls = 0;
  let postFallbacks = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    let board: Board | undefined;
    let probe: JitLike | undefined;
    const coldMs = cpuMs(() => {
      board = bareBoard(execution);
      probe = (board as unknown as { jits?: readonly JitLike[] }).jits?.[0];
      board.runUntil(0);
      board.runUntil(COLD_PS);
    });
    const steadyMs = cpuMs(() => {
      const target = COLD_PS + (STEADY_MS - COLD_PS / PS_PER_MS) * PS_PER_MS;

      while (board!.time < target) board!.runUntil(Math.min(board!.time + 10 * PS_PER_MS, target));
    });
    const beforePost = {
      compiles: probe?.directStats?.directCompiles ?? 0,
      calls: probe?.directStats?.directCalls ?? 0,
      fallbacks: probe?.directStats?.directFallbacks ?? 0,
    };
    const postMs = cpuMs(() => {
      const target = COLD_PS + (STEADY_MS * 2 - COLD_PS / PS_PER_MS) * PS_PER_MS;

      while (board!.time < target) board!.runUntil(Math.min(board!.time + 10 * PS_PER_MS, target));
    });

    cold.push(coldMs);
    steady.push(steadyMs);
    post.push(postMs);
    if (round === 0) {
      direct = probe?.direct !== undefined && probe.direct !== null;
      programs = probe?.directPrograms?.size ?? 0;
      blocks = probe?.cache.size ?? 0;
      shards = shardCount(probe);
      compiles = probe?.directStats?.directCompiles ?? 0;
      calls = probe?.directStats?.directCalls ?? 0;
      fallbacks = probe?.directStats?.directFallbacks ?? 0;
      postCompiles = compiles - beforePost.compiles;
      postCalls = calls - beforePost.calls;
      postFallbacks = fallbacks - beforePost.fallbacks;
    }
    board!.dispose();
  }

  const coldMs = min(cold);
  const steadyMs = min(steady);
  const postMs = min(post);
  const totalMs = coldMs + steadyMs;
  const steadySimMs = STEADY_MS - COLD_PS / PS_PER_MS;

  return {
    execution,
    clockFrequency: CLOCK,
    coldMs: Number(coldMs.toFixed(0)),
    steadyMs: Number(steadyMs.toFixed(0)),
    postMs: Number(postMs.toFixed(0)),
    totalMs: Number(totalMs.toFixed(0)),
    /** 稳态窗口的仿真时间 / 墙钟时间；大于 1 表示快于实时。 */
    steadyRealtimeFactor: Number((steadySimMs / steadyMs).toFixed(2)),
    postRealtimeFactor: Number((STEADY_MS / postMs).toFixed(2)),
    /** 整段仿真（含冷启动）的实时倍率。 */
    realtimeFactor: Number((STEADY_MS / totalMs).toFixed(2)),
    direct,
    programs,
    blocks,
    shards,
    compiles,
    calls,
    fallbacks,
    postCompiles,
    postCalls,
    postFallbacks,
  };
}
