import { describe, expect, it } from 'vitest';
import { measureHal } from './hal-bench';

/**
 * 对照：`execution: 'precise'`（逐指令调度，用于需要精确时序的场景）。
 *
 * 单独成文件，避免被 throughput 那一轮焐热的翻译缓存抬高读数。
 */
describe('HAL_06_LCD 裸 MCU、80 MHz、precise', () => {
  it('分开测初始化与绘图，连续运行到 440 ms', () => {
    const sample = measureHal('precise');

    console.log('HAL', JSON.stringify({ firmware: 'HAL_06_LCD', ...sample }));
    for (const round of sample.rounds) {
      expect(round.direct).toBe(false);
      expect(round.status).toBe('ready');
      expect(round.halted).toBe(false);
      expect(round.blocks).toBeGreaterThan(0);
      expect(round.drawingExit.toMs).toBe(440);
      expect(round.wrSamples).toBe(157_378);
      expect(round.drawing.wrSamples).toBe(104_338);
    }
  }, 900_000);
});
