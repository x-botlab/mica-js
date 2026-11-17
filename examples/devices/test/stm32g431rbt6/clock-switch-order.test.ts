import { describe, expect, it } from 'vitest';
import { CLOCK_CACHE } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { clockBoard } from './clock-harness';
import type { ClockBoard } from './clock-harness';
import { firmware } from './harness';

interface Snapshot {
  readonly time: number;
  readonly pc: number;
  readonly marker: number;
  readonly sysHz: number;
  readonly hclkHz: number;
  readonly pclk1Hz: number;
  readonly pclk2Hz: number;
  readonly timApb1Hz: number;
  readonly timApb2Hz: number;
  readonly sws: number;
  readonly tx2Period: number;
  readonly bytes: readonly number[];
  readonly edges: readonly { readonly time: number; readonly value: number }[];
}

function snapshot(rig: ClockBoard): Snapshot {
  return {
    time: rig.time(),
    pc: rig.state('pc') as number,
    marker: rig.readSram(0x400),
    sysHz: rig.readPeriph(CLOCK_CACHE.sysHz),
    hclkHz: rig.readPeriph(CLOCK_CACHE.hclkHz),
    pclk1Hz: rig.readPeriph(CLOCK_CACHE.pclk1Hz),
    pclk2Hz: rig.readPeriph(CLOCK_CACHE.pclk2Hz),
    timApb1Hz: rig.readPeriph(CLOCK_CACHE.timApb1Hz),
    timApb2Hz: rig.readPeriph(CLOCK_CACHE.timApb2Hz),
    sws: rig.readPeriph(CLOCK_CACHE.sws),
    tx2Period: rig.state('tx2Period') as number,
    bytes:
      (rig.topics['serial2.tx'] as Uint8Array[] | undefined)?.flatMap((chunk) => [...chunk]) ?? [],
    edges: rig.transitions.PA2?.map(({ time, value }) => ({ time, value })) ?? [],
  };
}

async function run(steps: readonly number[]): Promise<Snapshot> {
  const rig = await clockBoard({
    firmware: firmware('clock-switch-order.bin'),
    clockFrequency: 16_000_000,
    pins: ['PA2'],
    execution: 'throughput',
  });

  try {
    for (const step of steps) rig.run(step);
    return snapshot(rig);
  } finally {
    rig.dispose();
  }
}

/**
 * 同一个 runUntil 跨过 RCC 16→80 MHz 切换，与在切换前后分步 runUntil 的
 * 最终状态和 USART2/PA2 波形必须一致。夹具含 APB1=/2、APB2=/4。
 *
 * 5 ms 内：16 MHz 发 0xFF，切 PLL 80 MHz / PCLK1 40 MHz / PCLK2 20 MHz，
 * 再发 0xFF，最后写 SRAM marker 0x5a 并停在 done。
 */
describe('RCC 16→80 MHz 的 runUntil 切分等价性', () => {
  it('同一次 runUntil 与切换前后分步，最终状态和 USART 波形一致', async () => {
    const single = await run([5_000_000_000]);
    // 300 µs 在切换前（16 MHz 首字节发送中）；1 ms 边界已在切换后；
    // 最后一段收尾。三个 runUntil 边界覆盖切换前后。
    const stepped = await run([300_000_000, 1_000_000_000, 3_700_000_000]);

    expect(stepped).toEqual(single);
    expect(single).toMatchObject({
      time: 5_000_000_000,
      pc: 0x0800_007e,
      marker: 0x5a,
      sysHz: 80_000_000,
      hclkHz: 80_000_000,
      pclk1Hz: 40_000_000,
      pclk2Hz: 20_000_000,
      timApb1Hz: 80_000_000,
      timApb2Hz: 40_000_000,
      sws: 3,
      tx2Period: 13_875_000,
      bytes: [0xff, 0xff],
    });
    expect(single.edges.length).toBeGreaterThan(0);
  });
});
