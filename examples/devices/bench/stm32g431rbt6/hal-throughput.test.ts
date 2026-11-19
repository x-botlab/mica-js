import { describe, expect, it } from 'vitest';
import { measureHal } from './hal-bench';

/**
 * 主路径：`execution: 'throughput'`（直接后端，板级默认模式）。
 *
 * 单独成文件，让器件的翻译缓存从这个固件的冷启动开始计数。
 */
describe('HAL_06_LCD 裸 MCU、80 MHz、throughput', () => {
  it('分开测初始化与 360–390 ms 的稳定绘图，连续运行到 440 ms', () => {
    const sample = measureHal('throughput');

    console.log('HAL', JSON.stringify({ firmware: 'HAL_06_LCD', ...sample }));
    for (const round of sample.rounds) {
      expect(round.status).toBe('ready');
      expect(round.halted).toBe(false);
      expect(round.direct).toBe(true);
      expect(round.programs).toBeGreaterThan(0);
      expect(round.drawingExit.toMs).toBe(440);
      expect(round.wrSamples).toBe(157_338);
      expect(round.drawing).toMatchObject({
        fromMs: 360,
        toMs: 390,
        wrSamples: 104_338,
        blocks: 0,
        revision: 0,
        compiles: 0,
        fallbacks: 0,
      });
      expect(round.drawing.calls).toBeGreaterThan(0);
    }
  }, 900_000);
});
