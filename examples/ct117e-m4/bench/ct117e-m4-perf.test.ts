import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadFirmware } from '../test/firmware';
import {
  CT117E_M4_CLEAR_END_PS,
  CT117E_M4_CLEAR_START_PS,
  CT117E_M4_DEVICE_ID,
  CT117E_M4_END_TIME_PS,
  CT117E_M4_EXPECTED,
  CT117E_M4_MID_TIME_PS,
  createHarness,
  lcdWorkDelta,
  type Workload,
} from '../test/harness';

/**
 * 正式构建产物的单实例基准。
 *
 * 保留冷启动、active（200 µs → 220 ms）和 post（220 → 440 ms），
 * 在 post 单独计时 360 → 390 ms 稳态清屏。每轮重新建板；工作量校验不计时。
 */

const ROUNDS = 6;
const PS_PER_MS = 1_000_000_000;
const QUANTUM_PS = 10 * PS_PER_MS;
const COLD_END_PS = 200_000_000;
const ACTIVE_MS = (CT117E_M4_MID_TIME_PS - COLD_END_PS) / PS_PER_MS;
const POST_MS = (CT117E_M4_END_TIME_PS - CT117E_M4_MID_TIME_PS) / PS_PER_MS;
const TOTAL_MS = CT117E_M4_END_TIME_PS / PS_PER_MS;
const CLEAR_MS = (CT117E_M4_CLEAR_END_PS - CT117E_M4_CLEAR_START_PS) / PS_PER_MS;
const TRACE_CLEAR_CPU = process.env.MICA_CT117E_M4_THREAD_CPU === '1';

const cpuMs = (start: NodeJS.CpuUsage): number => {
  const usage = process.cpuUsage(start);

  return (usage.user + usage.system) / 1_000;
};

const round = (value: number): number => Number(value.toFixed(3));

const timed = (advance: () => void) => {
  const cpu = process.cpuUsage();
  const wall = performance.now();
  advance();
  return { wallMs: performance.now() - wall, cpuMs: cpuMs(cpu) };
};

const timedClear = (iteration: number, advance: () => void) => {
  if (!TRACE_CLEAR_CPU) return timed(advance);

  // This is the Vitest worker's simulation thread, not the entire Node process.
  writeSync(1, `CT117E_TIER_BEGIN ${iteration}\n`);
  const start = process.threadCpuUsage();
  const clear = timed(advance);
  const thread = process.threadCpuUsage(start);
  writeSync(1, `CT117E_TIER_END ${iteration}\n`);
  const foregroundMs = (thread.user + thread.system) / 1_000;
  process.stdout.write(
    `CT117E_CLEAR_CPU ${JSON.stringify({
      round: iteration,
      wallMs: round(clear.wallMs),
      foregroundMs: round(foregroundMs),
      processMs: round(clear.cpuMs),
      otherThreadsMs: round(clear.cpuMs - foregroundMs),
      wallMinusForegroundMs: round(clear.wallMs - foregroundMs),
    })}\n`,
  );
  return clear;
};

interface Reading {
  readonly round: number;
  readonly cold: { readonly cpuMs: number; readonly wallMs: number };
  readonly active: { readonly cpuMs: number; readonly wallMs: number };
  readonly post: { readonly cpuMs: number; readonly wallMs: number };
  readonly clear: { readonly cpuMs: number; readonly wallMs: number };
  readonly total: { readonly cpuMs: number; readonly wallMs: number };
  readonly realtime: {
    readonly activeCpu: number;
    readonly postCpu: number;
    readonly clearWall: number;
    readonly totalCpu: number;
    readonly totalWall: number;
  };
  readonly clearWork: ReturnType<typeof lcdWorkDelta>;
  readonly workload: Workload;
}

it('dist 单实例 HAL_06_LCD.hex：360–390 ms 稳态清屏 CPU/墙钟', async () => {
  const image = loadFirmware();

  // 预热动态导入与库校验，但不预热固件翻译；首轮冷启动仍包含真实的首次翻译。
  (await createHarness({ firmware: image.bytes, captureExpectedFrames: false })).dispose();

  const readings: Reading[] = [];
  const clearWalls: number[] = [];

  for (let index = 0; index < ROUNDS; index += 1) {
    const coldCpu = process.cpuUsage();
    const coldWall = performance.now();
    const harness = await createHarness({
      firmware: image.bytes,
      captureExpectedFrames: false,
    });

    const advance = (endPs: number) => harness.advanceTo(endPs, QUANTUM_PS);
    try {
      harness.board.runUntil(0);
      advance(COLD_END_PS);
      const coldWallMs = performance.now() - coldWall;
      const coldCpuMs = cpuMs(coldCpu);

      const active = timed(() => advance(CT117E_M4_MID_TIME_PS));
      const entry = timed(() => advance(CT117E_M4_CLEAR_START_PS));
      const before = harness.workload();
      const clear = timedClear(index + 1, () => advance(CT117E_M4_CLEAR_END_PS));
      const clearWork = lcdWorkDelta(before, harness.workload());
      const exit = timed(() => advance(CT117E_M4_END_TIME_PS));
      const postCpuMs = entry.cpuMs + clear.cpuMs + exit.cpuMs;
      const postWallMs = entry.wallMs + clear.wallMs + exit.wallMs;

      const workload = harness.workload();
      expect(harness.board.time).toBe(CT117E_M4_END_TIME_PS);
      expect(harness.board.status).toBe('ready');
      expect(harness.errors).toEqual([]);
      expect(harness.faults).toEqual([]);
      expect(clearWork).toEqual(CT117E_M4_EXPECTED.clear);
      expect(workload).toMatchObject(CT117E_M4_EXPECTED.final);

      const totalCpuMs = coldCpuMs + active.cpuMs + postCpuMs;
      const totalWallMs = coldWallMs + active.wallMs + postWallMs;
      const reading: Reading = {
        round: index + 1,
        cold: { cpuMs: round(coldCpuMs), wallMs: round(coldWallMs) },
        active: { cpuMs: round(active.cpuMs), wallMs: round(active.wallMs) },
        post: { cpuMs: round(postCpuMs), wallMs: round(postWallMs) },
        clear: { cpuMs: round(clear.cpuMs), wallMs: round(clear.wallMs) },
        total: { cpuMs: round(totalCpuMs), wallMs: round(totalWallMs) },
        realtime: {
          activeCpu: round(ACTIVE_MS / active.cpuMs),
          postCpu: round(POST_MS / postCpuMs),
          clearWall: round(CLEAR_MS / clear.wallMs),
          totalCpu: round(TOTAL_MS / totalCpuMs),
          totalWall: round(TOTAL_MS / totalWallMs),
        },
        clearWork,
        workload,
      };

      clearWalls.push(clear.wallMs);
      readings.push(reading);
      process.stdout.write(`CT117E_M4_PERF ${JSON.stringify(reading)}\n`);
    } finally {
      harness.dispose();
    }
  }

  const warm = clearWalls.slice(1).sort((a, b) => a - b);
  const medianWallMs = warm[Math.floor(warm.length / 2)]!;
  const clearSummary = {
    warmRounds: warm.length,
    // Five warm rounds: retain actual min/max rather than hiding variability.
    medianWallMs: round(medianWallMs),
    minWallMs: round(warm[0]!),
    maxWallMs: round(warm.at(-1)!),
    realtime: round(CLEAR_MS / medianWallMs),
    windowsAtRealtime: warm.filter((ms) => ms <= CLEAR_MS).length,
  };
  const directory = mkdtempSync(join(tmpdir(), 'mica-ct117e-m4-bench-'));

  writeFileSync(
    join(directory, 'readings.json'),
    JSON.stringify(
      {
        device: CT117E_M4_DEVICE_ID,
        node: process.version,
        cpu: cpus()[0]?.model,
        firmware: {
          path: image.path,
          imageSha256: image.imageSha256,
          length: image.length,
          dataBytes: image.dataBytes,
        },
        segmentsMs: {
          cold: COLD_END_PS / PS_PER_MS,
          active: ACTIVE_MS,
          post: POST_MS,
          clear: [CT117E_M4_CLEAR_START_PS / PS_PER_MS, CT117E_M4_CLEAR_END_PS / PS_PER_MS],
        },
        quantumMs: QUANTUM_PS / PS_PER_MS,
        clearSummary,
        rounds: readings,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`CT117E_M4_CLEAR ${JSON.stringify(clearSummary)}\n`);
  process.stdout.write(`CT117E_M4_REPORT ${directory}\n`);

  expect(readings).toHaveLength(ROUNDS);
}, 1_800_000);
