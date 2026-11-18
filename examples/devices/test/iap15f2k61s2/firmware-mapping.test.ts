import { describe, expect, it } from 'vitest';
import { firmwareImage } from '../support/legacy-model-bridge.mjs';
import { createSourceHarness } from './source-harness.ts';

/**
 * 固件地址空间边界：非零绝对地址、分段之间的空洞，以及 60 KiB 物理范围。
 *
 * IAP 的代码空间按字节地址 0 起算；镜像段保留绝对地址，工厂直接 `loadBytes` 到对应
 * 偏移。测试读取模型内存而不是拼接输入段，确认空洞没有被错误压缩。
 */

interface InstanceView {
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

function memories(board: unknown): ReadonlyMap<string, Uint8Array> {
  const internal = board as {
    readonly instances?: readonly InstanceView[];
  };
  const instance = internal.instances?.[0];

  if (instance === undefined) throw new Error('Missing MCU instance');

  return instance.memories;
}

describe('IAP15F2K61S2 固件映射', () => {
  it('非零绝对地址与段间空洞按模型内存保留，复位仍从 0 取指', async () => {
    const reset = Uint8Array.from([0x02, 0x00, 0x30]);
    const body = Uint8Array.from([
      0x75,
      0xa0,
      0x5a, // MOV P2,#5AH
      0x80,
      0xfe, // SJMP $
    ]);
    const image = firmwareImage([
      { addressSpace: 'code', address: 0, data: reset },
      { addressSpace: 'code', address: 0x30, data: body },
    ]);
    const harness = await createSourceHarness({
      image,
      observe: Array.from({ length: 8 }, (_, bit) => `P2_${bit}`),
    });

    try {
      // 消费方在边界处捕获独立快照；之后修改输入字节不影响模型。
      reset[0] = 0xff;
      body[0] = 0xff;

      const code = memories(harness.board).get('code')!;

      expect([...code.subarray(0, 3)]).toEqual([0x02, 0x00, 0x30]);
      expect(code.subarray(3, 0x30).every((byte) => byte === 0)).toBe(true);
      expect([...code.subarray(0x30, 0x35)]).toEqual([0x75, 0xa0, 0x5a, 0x80, 0xfe]);

      harness.board.runUntil(1_000_000_000);
      expect(harness.faults).toEqual([]);
      expect(harness.port(2)).toBe(0x5a);
    } finally {
      harness.dispose();
    }
  });

  it('超出 60 KiB 物理范围的段在创建期被拒绝', async () => {
    const image = firmwareImage([
      { addressSpace: 'code', address: 0xf000, data: Uint8Array.from([0x00]) },
    ]);

    await expect(createSourceHarness({ image })).rejects.toThrow(/60 KiB/);
  });

  it('未知地址空间在创建期被拒绝', async () => {
    const image = firmwareImage([
      { addressSpace: 'data', address: 0, data: Uint8Array.from([0x00]) },
    ]);

    await expect(createSourceHarness({ image })).rejects.toThrow(/address space/);
  });
});
