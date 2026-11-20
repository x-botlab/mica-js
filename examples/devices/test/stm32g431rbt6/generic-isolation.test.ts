import { describe, expect, it } from 'vitest';
import {
  genericTagOffset,
  genericValueOffset,
  genericWordIndex,
} from '@mica-js/stm32g431rbt6-core/layout';
import { circuit, firmware } from './harness';

const wordAt = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16) |
  ((bytes[offset + 3] ?? 0) << 24);

const A = 0x4000_f000;
const B = 0x4001_01f0;

describe('generic peripheral fallback isolation', () => {
  it('collision evicts the old tag, reads 0 for the old address, and never aliases PERIPH', async () => {
    expect(genericWordIndex(A)).toBe(genericWordIndex(B));

    const board = await circuit({
      firmware: firmware('generic-collision.bin'),
      clockFrequency: 1_000_000,
      pins: [],
    });

    try {
      board.run(0);
      const resetPeriph = board.memory('periph');
      board.run(1_000_000_000);

      const periph = board.memory('periph');
      const generic = board.memory('generic');
      const sram = board.memory('sram');
      const slot = genericWordIndex(A);

      expect(periph.length).toBe(0x1000);
      expect(generic.length).toBe(0x2000);
      // 启动过程会写入非零复位值；generic 访存不得改动任何复位后的外设字节。
      expect(periph).toEqual(resetPeriph);

      // guest 读：A 首次读回 0x11111111；B 用同 hash 槽覆盖后，A 读回 0（tag 不匹配）。
      expect(wordAt(sram, 0) >>> 0).toBe(0x1111_1111);
      expect(wordAt(sram, 4) >>> 0).toBe(0);
      expect(wordAt(sram, 8) >>> 0).toBe(0x2222_2222);
      // 窄写 A+1 重新占据该槽，只写 0xAA 到字节 1。
      expect(wordAt(sram, 12) >>> 0).toBe(0x0000_aa00);

      expect(wordAt(generic, genericTagOffset(slot)) >>> 0).toBe(A);
      expect(wordAt(generic, genericValueOffset(slot)) >>> 0).toBe(0x0000_aa00);
    } finally {
      board.dispose();
    }
  });
});
