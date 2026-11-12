import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../test/harness';

/**
 * 器件侧性能基准。
 *
 * 固件是 `test/device.test.ts` 里的 `stc15-led-blink`：P1.1 每 33.205 ms 翻转一次，
 * 全部时间花在 `DJNZ Rn,rel` 的两层延时循环上，因此墙钟几乎等于「指令数 × 单指令成本」，
 * 适合作为外设节拍与块翻译开销的对照。
 *
 * 读数说明：
 * - `wallMs`：预热之后的稳态墙钟（不含板级搭建与首次翻译）；
 * - `slowdown`：墙钟 / 仿真时间，越小越快（1 表示实时）；
 * - `jit`：`direct` 为 true 表示走了直接后端，`programs` 是直接程序缓存条数。
 */

const CLOCK_FREQUENCY = 11_059_200;
const WARM_UP_MS = 20;
const MEASURE_MS = 500;

function blinkFirmware(): Uint8Array {
  const image = new Array<number>(0x30).fill(0);

  image[0] = 0x02; // LJMP 0030H
  image[1] = 0x00;
  image[2] = 0x30;
  [
    0x75,
    0x92,
    0x02, // MOV P1M0,#02H  → P1.1 推挽
    0x75,
    0x91,
    0x00, // MOV P1M1,#00H
    0xb2,
    0x91, // LOOP: CPL P1.1
    0x7f,
    0xc8, // MOV R7,#200
    0x7e,
    0x28, // OUTER: MOV R6,#40
    0xde,
    0xfe, // INNER: DJNZ R6,INNER
    0xdf,
    0xfa, // DJNZ R7,OUTER
    0x80,
    0xf4, // SJMP LOOP
  ].forEach((value, index) => {
    image[0x30 + index] = value;
  });

  return Uint8Array.from(image);
}

describe('性能基准', () => {
  it('stc15-led-blink：DJNZ 延时循环与 P1.1 翻转', async () => {
    const result = await run({
      firmware: blinkFirmware(),
      milliseconds: MEASURE_MS,
      warmUpMilliseconds: WARM_UP_MS,
      clockFrequency: CLOCK_FREQUENCY,
      led: true,
    });

    expect(result.faults).toEqual([]);
    expect(result.brightness).toBeDefined();
    // 延时环必须走直接后端：节拍推进在共享服务块里，紧循环因此可编译。
    expect(result.jit.direct).toBe(true);

    const data = {
      device: 'iap15f2k61s2',
      firmware: 'stc15-led-blink',
      clockFrequency: CLOCK_FREQUENCY,
      simMs: MEASURE_MS,
      coldMs: Math.round(result.coldMs),
      wallMs: Math.round(result.wallMs),
      slowdown: Number((result.wallMs / MEASURE_MS).toFixed(1)),
      jit: {
        direct: result.jit.direct,
        cache: result.jit.cache,
        programs: result.jit.programs,
      },
    };

    appendFileSync(join(import.meta.dirname, 'results.jsonl'), `${JSON.stringify(data)}\n`);
    console.log(`PERF ${JSON.stringify(data)}`);
  });
});
