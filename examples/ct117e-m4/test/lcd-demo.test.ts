import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createHarness, digest } from './harness';

const STEP = 16;
const MS = 1_000_000_000;
const BANDS = '2e9b35c26d327933e73853e2f3a8fd8ec81b33516161a0807b2fb9984b786f3e';

// Expected 320×240 RGB565 rasters derived from HAL_06_LCD main.c, lcd.c and fonts.h,
// not from model snapshots. Sample after drawing and before the next HAL_Delay expires.
const SCENES = [
  [480, '十字', '0de1cda765da66060420faed78e9359a841f6123948f12090e2bb134d729f1da'],
  [1536, '矩形', '9f09be5f6fde74902535fe7d4cdb791a449760114ea24bcfe0e9f30e246ced89'],
  [2560, '圆', '32bc713b369655faa08e1c7b9dcb1d96bb59194f32c6b329912a4f0eb7b04a82'],
  [3696, 'Hello,world.', '8979ee6d1462ea740477d4742b8d1ba6997034fcc4da413327eb6445efa091cb'],
  [4704, '十条色带', BANDS],
] as const;

it('runs the Playground LCD firmware through all five scenes and holds the final bands', async () => {
  const hex = readFileSync(new URL('../assets/HAL_06_LCD.hex', import.meta.url));
  const board = await createHarness({ hex, stepPs: STEP * MS });
  try {
    // Reconstruct what View2D receives, not just the model's backing memory.
    const screen = new Uint8Array(320 * 240 * 2);
    let nextFrame = 0;
    for (const [ms, label, expected] of SCENES) {
      await board.advanceTo(ms * MS);
      for (; nextFrame < board.frames.length; nextFrame++) {
        const frame = board.frames[nextFrame]!;
        const header = new DataView(frame.buffer, frame.byteOffset, 8);
        const x = header.getUint16(0, true);
        const y = header.getUint16(2, true);
        const width = header.getUint16(4, true);
        const height = header.getUint16(6, true);
        for (let row = 0; row < height; row++) {
          const from = 8 + row * width * 2;
          screen.set(frame.subarray(from, from + width * 2), ((y + row) * 320 + x) * 2);
        }
      }
      expect(digest(screen), `${ms} ms: ${label}`).toBe(expected);
      expect(digest((await board.framebuffer()).subarray(8)), `${label} snapshot`).toBe(expected);
    }
    await board.advanceTo(5808 * MS);
    expect(board.frames).toHaveLength(nextFrame);
    expect(digest((await board.framebuffer()).subarray(8))).toBe(BANDS);
    expect(board.faults).toEqual([]);
    expect(board.errors).toEqual([]);
    expect(board.diagnostics).toEqual([]);
  } finally {
    await board.dispose();
  }
});
