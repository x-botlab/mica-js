import { mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadFirmware } from '../test/firmware';
import {
  CT117E_M4_DEVICE_ID,
  CT117E_M4_END_TIME_PS,
  CT117E_M4_EXPECTED,
  CT117E_M4_MID_TIME_PS,
  createHarness,
  type Workload,
} from '../test/harness';

/**
 * 正式构建产物的单实例基准。
 *
 * 0 → 440 ms 拆成三段：冷启动（建板 + 复位 + 0 → 200 µs）、active（200 µs →
 * 220 ms）、post（220 ms → 440 ms）。每轮只在段内计时，段间校验板状态、最终工作
 * 量与 GRAM 非零像素都在计时之外。三轮都创建全新的板；构建产物模块和工作量计数
 * 口径不变。
 */

const ROUNDS = 3;
const COLD_END_PS = 200_000_000;
const ACTIVE_MS = (CT117E_M4_MID_TIME_PS - COLD_END_PS) / 1_000_000_000;
const POST_MS = (CT117E_M4_END_TIME_PS - CT117E_M4_MID_TIME_PS) / 1_000_000_000;
const TOTAL_MS = CT117E_M4_END_TIME_PS / 1_000_000_000;

const cpuMs = (start: NodeJS.CpuUsage): number => {
  const usage = process.cpuUsage(start);

  return (usage.user + usage.system) / 1_000;
};

const round = (value: number): number => Number(value.toFixed(3));

interface Reading {
  readonly round: number;
  readonly cold: { readonly cpuMs: number; readonly wallMs: number };
  readonly active: { readonly cpuMs: number; readonly wallMs: number };
  readonly post: { readonly cpuMs: number; readonly wallMs: number };
  readonly total: { readonly cpuMs: number; readonly wallMs: number };
  readonly realtime: {
    readonly activeCpu: number;
    readonly postCpu: number;
    readonly totalCpu: number;
    readonly totalWall: number;
  };
  readonly workload: Workload;
}

it('dist 单实例 HAL_06_LCD.hex 0→440 ms，三段三轮 CPU/墙钟', async () => {
  const image = loadFirmware();

  // 预热动态导入与库校验，但不预热固件翻译；首轮冷启动仍包含真实的首次翻译。
  (await createHarness({ firmware: image.bytes, captureExpectedFrames: false })).dispose();

  const readings: Reading[] = [];

  for (let index = 0; index < ROUNDS; index += 1) {
    const coldCpu = process.cpuUsage();
    const coldWall = performance.now();
    const harness = await createHarness({
      firmware: image.bytes,
      captureExpectedFrames: false,
    });

    harness.board.runUntil(0);
    harness.advanceTo(COLD_END_PS);
    const coldCpuMs = cpuMs(coldCpu);
    const coldWallMs = performance.now() - coldWall;

    expect(harness.board.status).toBe('ready');
    expect(harness.errors).toEqual([]);
    expect(harness.faults).toEqual([]);

    const activeCpu = process.cpuUsage();
    const activeWall = performance.now();

    harness.advanceTo(CT117E_M4_MID_TIME_PS);
    const activeCpuMs = cpuMs(activeCpu);
    const activeWallMs = performance.now() - activeWall;

    expect(harness.board.status).toBe('ready');
    expect(harness.errors).toEqual([]);
    expect(harness.faults).toEqual([]);

    const postCpu = process.cpuUsage();
    const postWall = performance.now();

    harness.advanceTo(CT117E_M4_END_TIME_PS);
    const postCpuMs = cpuMs(postCpu);
    const postWallMs = performance.now() - postWall;

    // 校验在计时之外：工作量、帧数和非零像素都必须与正式用例一致。
    const workload = harness.workload();

    expect(harness.board.time).toBe(CT117E_M4_END_TIME_PS);
    expect(harness.board.status).toBe('ready');
    expect(harness.errors).toEqual([]);
    expect(harness.faults).toEqual([]);
    expect(workload.wrChanges).toBe(CT117E_M4_EXPECTED.final.wrChanges);
    expect(workload.gramStores).toBe(CT117E_M4_EXPECTED.final.gramStores);
    expect(workload.frames).toBe(CT117E_M4_EXPECTED.final.frames);
    expect(workload.nonZeroPixels).toBe(CT117E_M4_EXPECTED.final.nonZeroPixels);

    const totalCpuMs = coldCpuMs + activeCpuMs + postCpuMs;
    const totalWallMs = coldWallMs + activeWallMs + postWallMs;
    const reading: Reading = {
      round: index + 1,
      cold: { cpuMs: round(coldCpuMs), wallMs: round(coldWallMs) },
      active: { cpuMs: round(activeCpuMs), wallMs: round(activeWallMs) },
      post: { cpuMs: round(postCpuMs), wallMs: round(postWallMs) },
      total: { cpuMs: round(totalCpuMs), wallMs: round(totalWallMs) },
      realtime: {
        activeCpu: round(ACTIVE_MS / activeCpuMs),
        postCpu: round(POST_MS / postCpuMs),
        totalCpu: round(TOTAL_MS / totalCpuMs),
        totalWall: round(TOTAL_MS / totalWallMs),
      },
      workload,
    };

    readings.push(reading);
    process.stdout.write(`CT117E_M4_PERF ${JSON.stringify(reading)}\n`);
    harness.dispose();
  }

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
          cold: COLD_END_PS / 1_000_000_000,
          active: ACTIVE_MS,
          post: POST_MS,
        },
        rounds: readings,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`CT117E_M4_REPORT ${directory}\n`);

  expect(readings).toHaveLength(ROUNDS);
}, 1_800_000);
