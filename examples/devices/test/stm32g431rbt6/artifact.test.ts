import { describe, expect, it } from 'vitest';
import { artifactAvailable, circuit, firmware } from './harness';

describe.skipIf(!artifactAvailable())('STM32G431RBT6 交付产物', () => {
  it('从 device.js 复位并翻转 GPIO', async () => {
    const board = await circuit({
      firmware: firmware('gpio-blink.bin'),
      clockFrequency: 1_000_000,
      variant: 'artifact',
    });

    try {
      for (let step = 0; step < 100; step += 1) board.run(100_000_000);
      expect(board.faults).toEqual([]);
      expect(board.history.PA5).toContain(1);
      expect(board.history.PA5).toContain(0);
    } finally {
      board.dispose();
    }
  });
});
