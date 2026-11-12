import { describe, expect, it } from 'vitest';
import create from '../src/devices/iap15f2k61s2/index.ts';

/**
 * 内核取指基线：256 个操作码的指令长度必须与 8051 操作码表一致。
 *
 * 长度决定顺序后继地址，是跳转与中断返回的基础；这里直接调用翻译回调，不经过板。
 */

type Translate = (input: { pc: number; code: Uint8Array }, builder: unknown) => unknown;

function translator(): { translate: Translate } {
  let options: { translate: Translate } | undefined;
  const context = {
    props: { firmware: new Uint8Array(0), clockFrequency: 11_059_200 },
    attachJit(value: { translate: Translate }) {
      options = value;

      return { dispose() {} };
    },
    loadBytes() {},
  };

  create(context as never);

  if (options === undefined) throw new Error('attachJit was not called');

  return options;
}

/** 标准 8051 操作码的指令字节数。 */
function expectedSize(opcode: number): number {
  if (opcode === 0x02 || opcode === 0x12) return 3;
  if (opcode === 0x43 || opcode === 0x53 || opcode === 0x63) return 3;
  if (opcode === 0x75 || opcode === 0x85 || opcode === 0x90) return 3;
  if (opcode === 0x10 || opcode === 0x20 || opcode === 0x30) return 3;
  if (opcode === 0xd5) return 3;
  if (opcode >= 0xb4 && opcode <= 0xbf) return 3;

  const low = opcode & 0x0f;
  const high = opcode & 0xf0;

  // AJMP/ACALL 页内转移。
  if (low === 0x01 || low === 0x11) return 2;

  // ALU 组：A 与立即数/直接地址是双字节，@Ri 与 Rn 是单字节。
  if ([0x20, 0x30, 0x40, 0x50, 0x60, 0x90].includes(high) && low >= 0x04)
    return low === 0x04 || low === 0x05 ? 2 : 1;

  const twoByte = new Set([
    0x05, 0x15, 0x24, 0x25, 0x34, 0x35, 0x40, 0x42, 0x44, 0x45, 0x50, 0x52, 0x54, 0x55, 0x60, 0x62,
    0x64, 0x65, 0x70, 0x72, 0x74, 0x76, 0x77, 0x80, 0x82, 0x86, 0x87, 0x92, 0xa0, 0xa2, 0xa6, 0xa7,
    0xb0, 0xb2, 0xc0, 0xc2, 0xc5, 0xd0, 0xd2, 0xe5, 0xf5,
  ]);

  if (twoByte.has(opcode)) return 2;
  if (opcode >= 0x78 && opcode <= 0x7f) return 2;
  if (opcode >= 0x88 && opcode <= 0x8f) return 2;
  if (opcode >= 0xa8 && opcode <= 0xaf) return 2;
  if (opcode >= 0xd8 && opcode <= 0xdf) return 2;

  return 1;
}

describe('操作码长度', () => {
  it('256 个操作码的顺序后继与 8051 表一致', () => {
    const { translate } = translator();
    const mismatches: string[] = [];

    for (let opcode = 0; opcode < 0x100; opcode += 1) {
      const code = new Uint8Array(0x10000);

      code[0] = opcode;
      code[1] = 0x12;
      code[2] = 0x34;

      const block = translate({ pc: 0, code }, undefined) as {
        instructions: { nextPc: number }[];
      };
      const actual = block.instructions[0]?.nextPc;

      if (actual !== expectedSize(opcode))
        mismatches.push(
          `${opcode.toString(16).padStart(2, '0')}: ${String(actual)} != ${expectedSize(opcode)}`,
        );
    }

    expect(mismatches).toEqual([]);
  });

  it('保留操作码按单字节 NOP 处理', () => {
    const { translate } = translator();
    const code = new Uint8Array(0x10000);

    code[0] = 0xa5;

    const block = translate({ pc: 0, code }, undefined) as {
      instructions: { nextPc: number }[];
    };

    expect(block.instructions[0]?.nextPc).toBe(1);
  });
});
