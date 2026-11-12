import { types } from '@mica-js/sdk/model';
import type { JitTranslateInput } from '@mica-js/sdk/device';
import type { Body } from './ir';
import { asBody, num } from './ir';
import { conditionValue } from './cpu';
import { decode16 } from './thumb16';
import { decode32 } from './thumb32';

/** 一条已译码的指令；`emit` 负责生成数据通路 IR。 */
export interface Instruction {
  readonly size: 2 | 4;
  readonly cycles: number;
  readonly emit: (b: Body, pc: number) => void;
}

const byteAt = (code: JitTranslateInput['code'], offset: number): number =>
  code[offset & 0x1ffff] ?? 0;

/**
 * IT 块的条件执行。
 *
 * ITSTATE 高 4 位是首条件，低 4 位是掩码；当前指令的条件由首条件与掩码最低位组成。
 * 执行后把掩码左移一位，移空即离开 IT 块。IT 指令本身不走这个包装。
 */
function guarded(instruction: Instruction): Instruction {
  return {
    size: instruction.size,
    cycles: instruction.cycles,
    emit: (b, pc) => {
      const state = b.readState('itState', types.number);
      const active = b.notEqual(types.number, b.bitAnd(state, num(b, 0xf)), num(b, 0));
      // 条件成立与否写进 local，指令体只发射一次：否则每个块都会带两份数据通路，
      // 直接程序的体积与执行成本翻倍。
      const holds = b.local(types.bool, true);

      b.if(active, (inner) => {
        const body = asBody(inner);
        const condition = body.bitAnd(body.shiftRightUnsigned(state, num(body, 4)), num(body, 0xf));

        body.setLocal(holds, conditionValue(body, condition));
      });
      b.if(b.getLocal(holds), (yes) => instruction.emit(asBody(yes), pc));
      b.if(active, (inner) => {
        const body = asBody(inner);
        const next = body.bitOr(
          body.bitAnd(state, num(body, 0xe0)),
          body.bitAnd(body.shiftLeft(state, num(body, 1)), num(body, 0x1f)),
        );

        body.writeState('itState', next);
      });
    },
  };
}

const hint = (): Instruction => ({
  size: 2,
  cycles: 1,
  emit: () => {},
});

const itInstruction = (h1: number): Instruction => ({
  size: 2,
  cycles: 1,
  emit: (b) => {
    b.writeState('itState', num(b, h1 & 0xff));
  },
});

export function decode(code: JitTranslateInput['code'], pc: number): Instruction {
  const h1 = byteAt(code, pc) | (byteAt(code, pc + 1) << 8);

  if ((h1 & 0xf800) === 0xe800 || (h1 & 0xf800) === 0xf000) {
    const h2 = byteAt(code, pc + 2) | (byteAt(code, pc + 3) << 8);

    return guarded(decode32(h1, h2));
  }

  if ((h1 & 0xff00) === 0xbf00) {
    if ((h1 & 0x0f) === 0) return hint();
    if (((h1 >> 4) & 0xf) === 0xf) return hint();

    return itInstruction(h1);
  }

  return guarded(decode16(h1));
}
