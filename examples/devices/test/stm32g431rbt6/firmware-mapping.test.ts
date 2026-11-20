import { describe, expect, it } from 'vitest';
import { firmwareImage } from '../support/legacy-model-bridge.mjs';
import { circuit, firmware } from './harness';

/**
 * 固件分段映射：非零绝对地址、段间空洞与模型内存快照。
 *
 * 把 `gpio-blink` 的向量表放在 0x08000000，代码块整体搬到 0x08000100，中间留出空洞；
 * JIT 只从装载后的 `code` 内存取指。用例同时验证：输入字节之后被修改不影响模型、
 * 快照来自模型内存而不是把两段输入直接拼接。
 */

const BASE = 0x0800_0000;

describe('STM32G431RBT6 固件映射', () => {
  it('未提供固件时保持零初始化 Flash 并可推进', async () => {
    const board = await circuit({ clockFrequency: 1_000_000, pins: ['PA5'] });

    try {
      expect(board.code.every((byte) => byte === 0)).toBe(true);
      board.run(1_000_000);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('分段镜像保留空洞，JIT 从装载后的模型内存执行搬移后的代码', async () => {
    const source = firmware('gpio-blink.bin');
    const header = source.slice(0, 8);
    const body = source.slice(8);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

    view.setUint32(4, BASE + 0x101, true);

    const image = firmwareImage([
      { addressSpace: 'code', address: BASE, data: header },
      { addressSpace: 'code', address: BASE + 0x100, data: body },
    ]);
    const board = await circuit({ image, clockFrequency: 1_000_000, pins: ['PA5'] });

    try {
      const code = board.code;

      expect([...code.subarray(0, 8)]).toEqual([...header]);
      expect(code.subarray(8, 0x100).every((byte) => byte === 0)).toBe(true);
      expect([...code.subarray(0x100, 0x100 + body.length)]).toEqual([...body]);

      // 消费方在边界捕获快照；之后修改输入段不影响模型内存或执行。
      header.fill(0);
      body.fill(0);

      expect([...board.code.subarray(0, 8)]).not.toEqual([...header]);
      expect([...board.code.subarray(0x100, 0x100 + body.length)]).not.toEqual([...body]);

      for (let step = 0; step < 100; step += 1) board.run(100_000_000);

      expect(board.faults).toEqual([]);
      expect(board.history.PA5).toContain(1);
      expect(board.history.PA5).toContain(0);
    } finally {
      board.dispose();
    }
  });

  it('超出 128 KiB Flash 的段在创建期被拒绝', async () => {
    const image = firmwareImage([
      {
        addressSpace: 'code',
        address: BASE + 0x20000,
        data: Uint8Array.from([0x00]),
      },
    ]);

    await expect(circuit({ image, clockFrequency: 1_000_000 })).rejects.toThrow(
      /code address space/,
    );
  });

  it('未知地址空间在创建期被拒绝', async () => {
    const image = firmwareImage([
      {
        addressSpace: 'sram',
        address: 0x2000_0000,
        data: Uint8Array.from([0x00]),
      },
    ]);

    await expect(circuit({ image, clockFrequency: 1_000_000 })).rejects.toThrow(
      /address space/,
    );
  });
});
