import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { circuit, firmware } from '../test/harness';

/**
 * 器件侧性能基准。
 *
 * 固件是 `test/fixtures/gpio-blink.bin`：PA5 推挽翻转，延时子程序是 255 次 `subs/bne`，
 * 单圈指令数固定，适合作为「每块固定开销 + 指令数据通路」的对照。
 *
 * 读数说明：
 * - `wallMs`：预热之后的稳态墙钟（不含板级搭建与首次翻译）；
 * - `slowdown`：墙钟 / 仿真时间，越小越快（1 表示实时）；
 * - `jit`：`direct` 为 true 表示走了直接后端，`programs` 是直接程序缓存条数。
 */

const CLOCK_FREQUENCY = 1_000_000;
const WARM_UP_MS = 20;
const MEASURE_MS = 500;

describe('性能基准', () => {
  it('gpio-blink：PA5 翻转与 subs/bne 延时循环', async () => {
    const constructed = performance.now();
    const board = await circuit({
      variant: 'artifact',
      firmware: firmware('gpio-blink.bin'),
      clockFrequency: CLOCK_FREQUENCY,
    });

    try {
      board.run(WARM_UP_MS * 1_000_000_000);

      const coldMs = performance.now() - constructed;
      const started = performance.now();
      board.run(MEASURE_MS * 1_000_000_000);
      const wallMs = performance.now() - started;

      expect(board.faults).toEqual([]);

      const result = {
        device: 'stm32g431rbt6',
        firmware: 'gpio-blink',
        clockFrequency: CLOCK_FREQUENCY,
        simMs: MEASURE_MS,
        coldMs: Math.round(coldMs),
        wallMs: Math.round(wallMs),
        slowdown: Number((wallMs / MEASURE_MS).toFixed(1)),
        jit: board.jit(),
      };

      appendFileSync(join(import.meta.dirname, 'results.jsonl'), `${JSON.stringify(result)}\n`);
      console.log(`PERF ${JSON.stringify(result)}`);
    } finally {
      board.dispose();
    }
  });
});
