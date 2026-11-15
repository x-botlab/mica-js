import { types } from '@mica-js/sdk/model';
import type { JitTranslateInput } from '@mica-js/sdk/device';
import type { Body } from './ir';
import { asBody, num } from './ir';
import { conditionValue } from './cpu';
import { decode16 } from './thumb16';
import { decode32 } from './thumb32';

/** r0–r15 的块内编译期常量表；`undefined` 表示不可证明。 */
export type KnownRegs = (number | undefined)[];

/** 一条已译码的指令；`emit` 负责生成数据通路 IR。 */
export interface Instruction {
  readonly size: 2 | 4;
  readonly cycles: number;
  /**
   * 这条指令之后是否必须收块。写 pc 会在分支后留下死代码；静态 GPIO 输出写需要让宿主
   * 电气边界看到每个脉冲。块体是单个 `InstructionIR`，直接后端无法在 body 内再分片。
   */
  readonly endsBatch: boolean;
  /** 是否可能置位 `serviceMask`。 */
  readonly mayService: boolean;
  /** 是否需要在块内发射未知地址的完整内存分派树。 */
  readonly dynamicMemory?: boolean;
  /** 静态 GPIO 输出写之后必须收块，让电气求解看到脉冲。 */
  readonly boundaryAfter?: boolean;
  /** IT 指令覆盖的后续指令条数；非 IT 指令为 0。 */
  readonly itCount: number;
  readonly emit: (b: Body, pc: number) => void;
}

const byteAt = (code: JitTranslateInput['code'], offset: number): number =>
  code[offset & 0x1ffff] ?? 0;

/** 16 位指令里真正会改写 pc 的形式。 */
function writesPc16(instr: number): boolean {
  if ((instr & 0xf000) === 0xd000) return true; // B<cond> / SVC / UDF
  if ((instr & 0xf800) === 0xe000) return true; // B

  if ((instr & 0xfc00) === 0x4400) {
    if ((instr & 0xff00) === 0x4700) return true; // BX / BLX
    if ((instr & 0xff00) === 0x4500) return false; // CMP

    const rd = (instr & 0x7) | ((instr >>> 4) & 0x8);

    return rd === 15; // ADD/MOV 只有目标为 PC 才改变控制流
  }

  if ((instr & 0xf000) === 0xb000) {
    if ((instr & 0xf500) === 0xb100) return true; // CBZ / CBNZ
    if ((instr & 0xfe00) === 0xbc00) return (instr & 0x0100) !== 0; // POP {..., pc}
    if ((instr & 0xff00) === 0xbe00) return true; // BKPT

    return false;
  }

  if ((instr & 0xf000) === 0xc000) return (instr & 0x0800) !== 0; // ldm {pc}
  if ((instr & 0xf800) === 0x4800) return ((instr >> 8) & 7) === 7; // ldr pc, literal
  if ((instr & 0xf800) === 0x9800) return ((instr >> 8) & 7) === 7; // ldr pc, [sp, #imm]

  return false;
}

/** 32 位指令里会写 pc 的形式：B/BL/BLX、`pop.w {pc}`、`ldm {pc}`、`tbb/tbh`、`ldr.w pc`、
 * 目标寄存器为 pc 的数据处理指令。`B<cond>.W` 的 h2 bit15 与数据处理立即数天然区分。
 */
function writesPc32(h1: number, h2: number): boolean {
  if ((h1 & 0xf800) === 0xf000 && (h2 & 0x8000) !== 0) return true;
  if (h1 === 0xe8bd) return (h2 & 0x8000) !== 0;
  if ((h1 & 0xffd0) === 0xe890) return (h2 & 0x8000) !== 0;
  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) return true;

  const kind = h1 & 0xfff0;
  const load =
    kind === 0xf8d0 ||
    kind === 0xf890 ||
    kind === 0xf8b0 ||
    kind === 0xf990 ||
    kind === 0xf9b0 ||
    kind === 0xf850 ||
    kind === 0xf810 ||
    kind === 0xf830;

  if (load && ((h2 >> 12) & 0xf) === 15) return true;

  const rd = (h2 >> 8) & 0xf;
  if ((h1 & 0xfe00) === 0xea00 && rd === 15) return true;
  if (((h1 & 0xfbe0) === 0xf200 || (h1 & 0xfbe0) === 0xf2a0) && rd === 15) return true;
  if (((h1 & 0xfbf0) === 0xf240 || (h1 & 0xfbf0) === 0xf2c0) && rd === 15) return true;

  return false;
}

/**
 * IT 块的条件执行。
 *
 * ITSTATE 高 4 位是首条件，低 4 位是掩码；当前指令的条件由首条件与掩码最低位组成。
 * 执行后把掩码左移一位，移空即离开 IT 块。IT 指令本身不走这个包装。
 *
 * 只有静态判定在 IT 块内的指令才需要这层包装：包装本身要读写 `itState` 并多三次 `if`，
 * 而真实固件里绝大多数指令不在 IT 块内。批处理不会在 IT 块中间切开，所以一条指令是否
 * 受 IT 控制在翻译期就能确定（见 `index.ts` 的 `collectBatch`）。
 */
export function guard(instruction: Instruction): Instruction {
  return {
    size: instruction.size,
    cycles: instruction.cycles,
    endsBatch: instruction.endsBatch,
    mayService: instruction.mayService,
    ...(instruction.dynamicMemory === undefined
      ? {}
      : { dynamicMemory: instruction.dynamicMemory }),
    itCount: 0,
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
  endsBatch: false,
  mayService: false,
  itCount: 0,
  emit: () => {},
});

/**
 * `it` 指令：`1111 1011 cond mask`。掩码每左移一位消耗一条被控指令，左移到低 4 位全 0
 * 即离开 IT 块，因此覆盖条数是「掩码最低置位之上的左移次数」。
 *
 * 例：掩码 `1000` 覆盖 1 条，`1100` 覆盖 2 条，`0110` 覆盖 3 条，`1111` 覆盖 4 条。
 */
const itInstruction = (h1: number): Instruction => {
  const mask = h1 & 0xf;
  let count = 1;

  while (count < 4 && ((mask << count) & 0xf) !== 0) count += 1;

  return {
    size: 2,
    cycles: 1,
    endsBatch: false,
    mayService: false,
    itCount: count,
    emit: (b) => {
      b.writeState('itState', num(b, h1 & 0xff));
    },
  };
};
export function decode(
  code: JitTranslateInput['code'],
  pc: number,
  knownRegs?: KnownRegs,
  firmwareLength = code.byteLength,
  conditional = false,
): Instruction {
  const h1 = byteAt(code, pc) | (byteAt(code, pc + 1) << 8);
  let instruction: Instruction;

  // Thumb 的 32 位前缀是 0xE800–0xFFFF（0b11101 / 11110 / 11111）；只判
  // 0xE800 与 0xF000 两档会漏掉 0xF800–0xFFFF（`ldr.w`/`str.w` 等），把它们
  // 当成 16 位指令解码后 PC 只会前进 2 字节，落到半条指令上继续执行垃圾。
  if (h1 >= 0xe800) {
    const h2 = byteAt(code, pc + 2) | (byteAt(code, pc + 3) << 8);

    const decoded = decode32(h1, h2, knownRegs, pc, code, firmwareLength);

    instruction = {
      ...decoded,
      endsBatch: writesPc32(h1, h2) || decoded.boundaryAfter === true,
      itCount: 0,
    };
  } else if ((h1 & 0xff00) === 0xbf00) {
    if ((h1 & 0x0f) === 0 || ((h1 >> 4) & 0xf) === 0xf) instruction = hint();
    else instruction = itInstruction(h1);
  } else {
    const decoded = decode16(h1, knownRegs, pc, code, firmwareLength);

    instruction = {
      ...decoded,
      endsBatch: writesPc16(h1) || decoded.boundaryAfter === true,
      itCount: 0,
    };
  }

  // IT 谓词可能让写失效；入口常量仍可用于该指令自身的静态地址，但离开后必须清空。
  if (conditional) knownRegs?.fill(undefined);

  return instruction;
}
