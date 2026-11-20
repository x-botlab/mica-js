import { describe, expect, it } from 'vitest';
import { circuit, firmware } from './harness';
import { RNG_STATE_SEED } from '@mica-js/stm32g431rbt6-core/rng';
function firstRngWord(): number {
  let state = RNG_STATE_SEED >>> 0;
  state = (state ^ (state << 13)) >>> 0;
  state = (state ^ (state >>> 17)) >>> 0;
  return (state ^ (state << 5)) >>> 0;
}

function bytesOf(board: Awaited<ReturnType<typeof circuit>>): number[] {
  return (board.topics['serial2.tx'] as Uint8Array[] | undefined ?? []).flatMap((chunk) => [
    ...chunk,
  ]);
}

describe('STM32G431 system firmware', () => {
  it('runs CRC/RTC/IWDG and DMA M2M + USART2 TX on central JIT/services', async () => {
    const board = await circuit({
      firmware: firmware('system-mcu-no-rng.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      for (let step = 0; step < 5; step += 1) board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      const bytes = bytesOf(board);

      expect(bytes.slice(0, 4)).toEqual([0xe7, 0xe6, 0x76, 0x03]);
      expect(bytes.slice(4, 8)).toEqual([0x56, 0x34, 0x12, 0x00]);
      expect(bytes[8]).toBe(0x57);
      expect(String.fromCharCode(...bytes.slice(9, 13))).toBe('M2M!');
      expect(String.fromCharCode(...bytes.slice(13, 18))).toBe('DMAOK');
    } finally {
      board.dispose();
    }
  });

  it('runs RNG as part of the same system firmware', async () => {
    const board = await circuit({
      firmware: firmware('system-mcu.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      for (let step = 0; step < 5; step += 1) board.run(1_000_000_000);
      expect(board.faults).toEqual([]);
      const bytes = bytesOf(board);

      expect(bytes.slice(0, 4)).toEqual([0xe7, 0xe6, 0x76, 0x03]);
      const rng = firstRngWord();

      expect(bytes.slice(4, 8)).toEqual([
        rng & 0xff,
        (rng >>> 8) & 0xff,
        (rng >>> 16) & 0xff,
        (rng >>> 24) & 0xff,
      ]);
      expect(bytes.slice(8, 12)).toEqual([0x56, 0x34, 0x12, 0x00]);
      expect(bytes[12]).toBe(0x57);
      expect(String.fromCharCode(...bytes.slice(13, 17))).toBe('M2M!');
      expect(String.fromCharCode(...bytes.slice(17, 22))).toBe('DMAOK');
    } finally {
      board.dispose();
    }
  });
});
