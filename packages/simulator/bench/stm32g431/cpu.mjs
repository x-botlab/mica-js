/**
 * STM32G431 (Cortex-M4F, Thumb) decoder and Builder-IR translator for the bench model.
 *
 * Scope: the real 16-bit Thumb main path used by the fixtures, plus Thumb-32
 * MOVW/MOVT/BL. Instructions are decoded from the flash image handed to the
 * translator and lowered to Builder IR; nothing runs during translation.
 *
 * Timing is an explicit simplification and is not claimed to be hardware accurate:
 *   ALU, IT, CPS, hint, MOVW/MOVT, ADR, SP adjust       1 cycle
 *   load / store, any width                            2 cycles
 *   PUSH / POP                                         registers + 1 (PC/LR counted)
 *   LDM / STM                                          registers + 2
 *   B, B<cond>, CBZ/CBNZ, BL, BLX, BX                  3 taken, 1 not taken
 *   BX with EXC_RETURN, exception entry and return     12 cycles
 *   instruction skipped by an IT condition             1 cycle
 *
 * A conditional branch selects its target and its delay and ends in a single
 * top-level redirect, so no instruction uses nested redirects. Setting
 * `exactBranchCycles: false` charges the taken cost in both directions, which is
 * two cycles too much for a not-taken branch.
 *
 * IT blocks are resolved statically: membership and the T/E polarity pattern come
 * from the IT instruction bytes, while `itstate` is advanced on every instruction
 * of the block so exception entry and return can save and restore it.
 */

import { createRequire } from 'node:module';
import { types } from '../../../device-model/dist/index.js';
import { EXC_RETURN, FLASH_BASE, RESET_PC, SCB_VTOR, STACK_TOP } from './constants.mjs';

const requireModule = createRequire(import.meta.url);

export const REGISTER_NAMES = Object.freeze([
  'r0',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'pc',
]);
export const FLAG_NAMES = Object.freeze(['n', 'z', 'c', 'v']);
const CONDITION_NAMES = Object.freeze([
  'eq',
  'ne',
  'cs',
  'cc',
  'mi',
  'pl',
  'vs',
  'vc',
  'hi',
  'ls',
  'ge',
  'lt',
  'gt',
  'le',
]);

/** Nominal cost of one guest instruction, in core cycles. */
export const CYCLE_TABLE = Object.freeze({
  alu: 1,
  load: 2,
  store: 2,
  takenBranch: 3,
  notTaken: 1,
  pushPopOverhead: 1,
  exception: 12,
});

/** Declared by `registerCpu`; `irqPending` belongs to the bus/SysTick model. */
export const cpuInitialState = Object.freeze({
  r0: 0,
  r1: 0,
  r2: 0,
  r3: 0,
  r4: 0,
  r5: 0,
  r6: 0,
  r7: 0,
  r8: 0,
  r9: 0,
  r10: 0,
  r11: 0,
  r12: 0,
  r13: STACK_TOP,
  r14: 0,
  pc: RESET_PC,
  n: false,
  z: false,
  c: false,
  v: false,
  itstate: 0,
  primask: 0,
  ipsr: 0,
});

const MASK32 = 0xffffffff;

/** Raised for encodings the translator does not implement; carries pc and opcode. */
export class ThumbDecodeError extends Error {
  constructor(reason, { pc, opcode }) {
    super(
      `Unsupported Thumb encoding ${reason} at pc 0x${pc.toString(16).padStart(8, '0')} ` +
        `(opcode 0x${opcode.toString(16).padStart(4, '0')})`,
    );
    this.name = 'ThumbDecodeError';
    this.pc = pc;
    this.opcode = opcode;
  }
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

function halfwordAt(code, index, pc) {
  if (index < 0 || index + 1 >= code.length)
    throw new ThumbDecodeError('with an instruction fetch outside the code image', {
      pc,
      opcode: 0,
    });
  return code[index] | (code[index + 1] << 8);
}

/** Thumb-2 instructions start with 11101, 11110 or 11111. */
function isWide(first) {
  return (first & 0xf800) >= 0xe800;
}

function sizeAt(code, index, pc) {
  return isWide(halfwordAt(code, index, pc)) ? 4 : 2;
}

function signExtend(value, bits) {
  const limit = 1 << (bits - 1);
  return value >= limit ? value - (1 << bits) : value;
}

function hex(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function formatReg(index) {
  return index === 13 ? 'sp' : index === 14 ? 'lr' : index === 15 ? 'pc' : REGISTER_NAMES[index];
}

function formatList(registers) {
  return registers.map((index) => formatReg(index)).join(', ');
}

/**
 * Advance ITSTATE: IT[7:5] keep condition bits <3:1>, bit 4 is the current T/E
 * polarity and [3:0] is the shifted mask.
 */
function advanceItstate(itstate) {
  if ((itstate & 0x7) === 0) return 0;
  return ((itstate & 0xe0) | (((itstate & 0x1f) << 1) & 0x1f)) & 0xff;
}

function makeInstruction(pc, size, opcode, kind, mnemonic, text, extra) {
  return Object.freeze({
    pc,
    size,
    nextPc: (pc + size) >>> 0,
    opcode,
    kind,
    mnemonic,
    text,
    cond: null,
    itstate: null,
    cycles: CYCLE_TABLE.alu,
    terminal: false,
    ...extra,
  });
}

const SHIFT_NAMES = Object.freeze(['lsls', 'lsrs', 'asrs']);
const IMM8_NAMES = Object.freeze(['movs', 'cmp', 'adds', 'subs']);
const DP_NAMES = Object.freeze([
  'ands',
  'eors',
  'lsls',
  'lsrs',
  'asrs',
  'adcs',
  'sbcs',
  'rors',
  'tst',
  'rsbs',
  'cmp',
  'cmn',
  'orrs',
  'muls',
  'bics',
  'mvns',
]);
const REGISTER_LOAD_NAMES = Object.freeze([
  'str',
  'strh',
  'strb',
  'ldrsb',
  'ldr',
  'ldrh',
  'ldrb',
  'ldrsh',
]);
const EXTEND_NAMES = Object.freeze(['sxth', 'sxtb', 'uxth', 'uxtb']);
const REVERSE_NAMES = Object.freeze(['rev', 'rev16', 'revsh']);
const HINT_NAMES = Object.freeze(['nop', 'yield', 'wfe', 'wfi', 'sev']);

function decodeThumb16(op, pc) {
  // Shift by immediate / add-subtract
  if ((op & 0xe000) === 0x0000) {
    if ((op & 0x1800) === 0x1800) {
      const sub = (op & 0x0200) !== 0;
      const immediate = (op & 0x0400) !== 0;
      const rd = op & 7;
      const rn = (op >> 3) & 7;
      const operand = (op >> 6) & 7;
      const mnemonic = sub ? 'subs' : 'adds';
      const text = immediate
        ? `${mnemonic} ${formatReg(rd)}, ${formatReg(rn)}, #${operand}`
        : `${mnemonic} ${formatReg(rd)}, ${formatReg(rn)}, ${formatReg(operand)}`;
      return makeInstruction(pc, 2, op, 'add-sub', mnemonic, text, {
        rd,
        rn,
        rm: immediate ? null : operand,
        imm: immediate ? operand : null,
        sub,
        withResult: true,
      });
    }
    const shift = (op >> 11) & 3;
    const imm = (op >> 6) & 0x1f;
    const rm = (op >> 3) & 7;
    const rd = op & 7;
    const mnemonic = SHIFT_NAMES[shift];
    return makeInstruction(
      pc,
      2,
      op,
      'shift-imm',
      mnemonic,
      `${mnemonic} ${formatReg(rd)}, ${formatReg(rm)}, #${imm}`,
      { shift, rd, rm, imm },
    );
  }

  // MOV/CMP/ADD/SUB immediate 8
  if ((op & 0xe000) === 0x2000) {
    const dp = (op >> 11) & 3;
    const rd = (op >> 8) & 7;
    const imm = op & 0xff;
    const mnemonic = IMM8_NAMES[dp];
    return makeInstruction(
      pc,
      2,
      op,
      'add-sub',
      mnemonic,
      `${mnemonic} ${formatReg(rd)}, #${imm}`,
      {
        dp,
        rd,
        rn: rd,
        rm: null,
        imm,
        sub: dp === 3,
        mov: dp === 0,
        withResult: dp !== 1,
      },
    );
  }

  // Data processing (register)
  if ((op & 0xfc00) === 0x4000) {
    const dp = (op >> 6) & 0xf;
    const rm = (op >> 3) & 7;
    const rd = op & 7;
    const mnemonic = DP_NAMES[dp];
    return makeInstruction(
      pc,
      2,
      op,
      'dp-reg',
      mnemonic,
      `${mnemonic} ${formatReg(rd)}, ${formatReg(rm)}`,
      {
        dp,
        rd,
        rm,
      },
    );
  }

  // Special data processing / branch and exchange
  if ((op & 0xfc00) === 0x4400) {
    const special = (op >> 8) & 3;
    const rm = (op >> 3) & 0xf;
    const rd = ((op >> 4) & 8) | (op & 7);
    if (special === 3) {
      if ((op & 0x0007) !== 0)
        throw new ThumbDecodeError('for a reserved branch-and-exchange form', { pc, opcode: op });
      const link = (op & 0x0080) !== 0;
      const mnemonic = link ? 'blx' : 'bx';
      return makeInstruction(
        pc,
        2,
        op,
        link ? 'blx' : 'bx',
        mnemonic,
        `${mnemonic} ${formatReg(rm)}`,
        {
          rm,
          cycles: CYCLE_TABLE.takenBranch,
          terminal: 'indirect',
        },
      );
    }
    const mnemonic = ['add', 'cmp', 'mov'][special];
    return makeInstruction(
      pc,
      2,
      op,
      `hi-${mnemonic}`,
      mnemonic,
      `${mnemonic} ${formatReg(rd)}, ${formatReg(rm)}`,
      {
        rd,
        rm,
        terminal: special === 2 && rd === 15 ? 'indirect' : false,
      },
    );
  }

  // LDR (literal)
  if ((op & 0xf800) === 0x4800) {
    const rt = (op >> 8) & 7;
    const imm = (op & 0xff) * 4;
    return makeInstruction(pc, 2, op, 'ld', 'ldr', `ldr ${formatReg(rt)}, [pc, #${imm}]`, {
      rt,
      rn: null,
      rm: null,
      imm,
      width: 4,
      signed: false,
      literal: true,
      cycles: CYCLE_TABLE.load,
    });
  }

  // Load/store (register offset)
  if ((op & 0xf000) === 0x5000) {
    const sel = (op >> 9) & 7;
    const rm = (op >> 6) & 7;
    const rn = (op >> 3) & 7;
    const rt = op & 7;
    const mnemonic = REGISTER_LOAD_NAMES[sel];
    const load = sel >= 3;
    const width = mnemonic.endsWith('b') ? 1 : mnemonic.endsWith('h') ? 2 : 4;
    return makeInstruction(
      pc,
      2,
      op,
      load ? 'ld' : 'st',
      mnemonic,
      `${mnemonic} ${formatReg(rt)}, [${formatReg(rn)}, ${formatReg(rm)}]`,
      {
        rt,
        rn,
        rm,
        imm: null,
        width,
        signed: mnemonic === 'ldrsb' || mnemonic === 'ldrsh',
        literal: false,
        cycles: load ? CYCLE_TABLE.load : CYCLE_TABLE.store,
      },
    );
  }

  // Load/store (immediate offset, word/byte)
  if ((op & 0xe000) === 0x6000) {
    const byte = (op & 0x1000) !== 0;
    const load = (op & 0x0800) !== 0;
    const imm5 = (op >> 6) & 0x1f;
    const rn = (op >> 3) & 7;
    const rt = op & 7;
    const imm = imm5 * (byte ? 1 : 4);
    const mnemonic = `${load ? 'ldr' : 'str'}${byte ? 'b' : ''}`;
    return makeInstruction(
      pc,
      2,
      op,
      load ? 'ld' : 'st',
      mnemonic,
      `${mnemonic} ${formatReg(rt)}, [${formatReg(rn)}, #${imm}]`,
      {
        rt,
        rn,
        rm: null,
        imm,
        width: byte ? 1 : 4,
        signed: false,
        literal: false,
        cycles: load ? CYCLE_TABLE.load : CYCLE_TABLE.store,
      },
    );
  }

  // Load/store halfword (immediate offset)
  if ((op & 0xf000) === 0x8000) {
    const load = (op & 0x0800) !== 0;
    const imm = ((op >> 6) & 0x1f) * 2;
    const rn = (op >> 3) & 7;
    const rt = op & 7;
    const mnemonic = load ? 'ldrh' : 'strh';
    return makeInstruction(
      pc,
      2,
      op,
      load ? 'ld' : 'st',
      mnemonic,
      `${mnemonic} ${formatReg(rt)}, [${formatReg(rn)}, #${imm}]`,
      {
        rt,
        rn,
        rm: null,
        imm,
        width: 2,
        signed: false,
        literal: false,
        cycles: load ? CYCLE_TABLE.load : CYCLE_TABLE.store,
      },
    );
  }

  // SP-relative load/store
  if ((op & 0xf000) === 0x9000) {
    const load = (op & 0x0800) !== 0;
    const rt = (op >> 8) & 7;
    const imm = (op & 0xff) * 4;
    const mnemonic = load ? 'ldr' : 'str';
    return makeInstruction(
      pc,
      2,
      op,
      load ? 'ld' : 'st',
      mnemonic,
      `${mnemonic} ${formatReg(rt)}, [sp, #${imm}]`,
      {
        rt,
        rn: 13,
        rm: null,
        imm,
        width: 4,
        signed: false,
        literal: false,
        cycles: load ? CYCLE_TABLE.load : CYCLE_TABLE.store,
      },
    );
  }

  // ADR / ADD Rd, SP, #imm
  if ((op & 0xf000) === 0xa000) {
    const rd = (op >> 8) & 7;
    const imm = (op & 0xff) * 4;
    const spBase = (op & 0x0800) !== 0;
    const mnemonic = spBase ? 'add' : 'adr';
    const text = spBase ? `add ${formatReg(rd)}, sp, #${imm}` : `adr ${formatReg(rd)}, #${imm}`;
    return makeInstruction(pc, 2, op, spBase ? 'add-sp-imm' : 'adr', mnemonic, text, { rd, imm });
  }
  if ((op & 0xf000) === 0xb000) {
    // ADD/SUB SP, #imm7
    if ((op & 0xff00) === 0xb000) {
      const sub = (op & 0x0080) !== 0;
      const imm = (op & 0x7f) * 4;
      const mnemonic = sub ? 'sub' : 'add';
      return makeInstruction(pc, 2, op, 'add-sub-sp', mnemonic, `${mnemonic} sp, #${imm}`, {
        imm,
        sub,
      });
    }
    // CBZ/CBNZ
    if ((op & 0xf500) === 0xb100) {
      const nonzero = (op & 0x0800) !== 0;
      const rn = op & 7;
      const imm = (((op >> 9) & 1) << 6) | (((op >> 3) & 0x1f) << 1);
      const target = (pc + 4 + imm) >>> 0;
      const mnemonic = nonzero ? 'cbnz' : 'cbz';
      return makeInstruction(
        pc,
        2,
        op,
        'cbz',
        mnemonic,
        `${mnemonic} ${formatReg(rn)}, ${hex(target)}`,
        { rn, imm, target, nonzero, cycles: CYCLE_TABLE.takenBranch, terminal: 'branch' },
      );
    }
    // SXTH/SXTB/UXTH/UXTB
    if ((op & 0xff00) === 0xb200) {
      const sel = (op >> 6) & 3;
      const rm = (op >> 3) & 7;
      const rd = op & 7;
      const mnemonic = EXTEND_NAMES[sel];
      return makeInstruction(
        pc,
        2,
        op,
        'extend',
        mnemonic,
        `${mnemonic} ${formatReg(rd)}, ${formatReg(rm)}`,
        {
          sel,
          rd,
          rm,
        },
      );
    }
    // REV/REV16/REVSH
    if ((op & 0xff00) === 0xba00) {
      const sel = (op >> 6) & 3;
      if (sel === 3) throw new ThumbDecodeError('for a reserved reverse form', { pc, opcode: op });
      const rm = (op >> 3) & 7;
      const rd = op & 7;
      const mnemonic = REVERSE_NAMES[sel];
      return makeInstruction(
        pc,
        2,
        op,
        'reverse',
        mnemonic,
        `${mnemonic} ${formatReg(rd)}, ${formatReg(rm)}`,
        {
          sel,
          rd,
          rm,
        },
      );
    }
    // PUSH/POP
    if ((op & 0xfe00) === 0xb400 || (op & 0xfe00) === 0xbc00) {
      const load = (op & 0xfe00) === 0xbc00;
      const extra = (op & 0x0100) !== 0;
      const registers = [];
      for (let index = 0; index < 8; index++) if (op & (1 << index)) registers.push(index);
      if (extra) registers.push(load ? 15 : 14);
      if (!registers.length)
        throw new ThumbDecodeError('for an empty push/pop list', { pc, opcode: op });
      const mnemonic = load ? 'pop' : 'push';
      return makeInstruction(
        pc,
        2,
        op,
        load ? 'pop' : 'push',
        mnemonic,
        `${mnemonic} {${formatList(registers)}}`,
        {
          registers,
          cycles: registers.length + CYCLE_TABLE.pushPopOverhead,
          terminal: load && extra ? 'indirect' : false,
        },
      );
    }
    // CPSID/CPSIE i
    if ((op & 0xffe0) === 0xb660) {
      if ((op & 0x0007) !== 0x0002)
        throw new ThumbDecodeError('for CPS outside the interrupt mask', { pc, opcode: op });
      const disable = (op & 0x0030) === 0x0030;
      const mnemonic = disable ? 'cpsid' : 'cpsie';
      return makeInstruction(pc, 2, op, 'cps', mnemonic, `${mnemonic} i`, { disable });
    }
    if ((op & 0xff00) === 0xbf00) {
      const mask = op & 0xf;
      if (mask !== 0) {
        const firstCondition = (op >> 4) & 0xf;
        if (firstCondition >= 0xe)
          throw new ThumbDecodeError('for an IT instruction without a condition', {
            pc,
            opcode: op,
          });
        return makeInstruction(pc, 2, op, 'it', 'it', `it ${CONDITION_NAMES[firstCondition]}`, {
          itstate: (firstCondition << 4) | mask,
        });
      }
      const hint = (op >> 4) & 0xf;
      if (hint > 4) throw new ThumbDecodeError('for an unsupported hint', { pc, opcode: op });
      return makeInstruction(pc, 2, op, 'nop', HINT_NAMES[hint], HINT_NAMES[hint], {});
    }
    throw new ThumbDecodeError('for an unsupported miscellaneous form', { pc, opcode: op });
  }

  // Load/store multiple
  if ((op & 0xf000) === 0xc000) {
    const load = (op & 0x0800) !== 0;
    const rn = (op >> 8) & 7;
    const registers = [];
    for (let index = 0; index < 8; index++) if (op & (1 << index)) registers.push(index);
    if (!registers.length)
      throw new ThumbDecodeError('for an empty ldm/stm list', { pc, opcode: op });
    const mnemonic = load ? 'ldm' : 'stm';
    return makeInstruction(
      pc,
      2,
      op,
      load ? 'ldm' : 'stm',
      mnemonic,
      `${mnemonic} ${formatReg(rn)}!, {${formatList(registers)}}`,
      { rn, registers, cycles: registers.length + CYCLE_TABLE.load },
    );
  }

  // Conditional branch
  if ((op & 0xf000) === 0xd000) {
    const cond = (op >> 8) & 0xf;
    if (cond >= 0xe) throw new ThumbDecodeError('for UDF/SVC', { pc, opcode: op });
    const target = (pc + 4 + signExtend((op & 0xff) << 1, 9)) >>> 0;
    return makeInstruction(
      pc,
      2,
      op,
      'b-cond',
      `b${CONDITION_NAMES[cond]}`,
      `b${CONDITION_NAMES[cond]} ${hex(target)}`,
      { cond, target, cycles: CYCLE_TABLE.takenBranch, terminal: 'branch' },
    );
  }

  // Unconditional branch
  if ((op & 0xf800) === 0xe000) {
    const target = (pc + 4 + signExtend((op & 0x7ff) << 1, 12)) >>> 0;
    return makeInstruction(pc, 2, op, 'b', 'b', `b ${hex(target)}`, {
      target,
      cycles: CYCLE_TABLE.takenBranch,
      terminal: 'branch',
    });
  }

  throw new ThumbDecodeError('for an unassigned 16-bit form', { pc, opcode: op });
}
function decodeThumb32(code, index, pc, first) {
  const second = halfwordAt(code, index + 2, pc);
  const nextPc = (pc + 4) >>> 0;

  // MOVW / MOVT
  if ((first & 0xfbf0) === 0xf240 || (first & 0xfbf0) === 0xf2c0) {
    const top = (first & 0xfbf0) === 0xf2c0;
    const imm =
      ((first & 0xf) << 12) |
      (((first >> 10) & 1) << 11) |
      (((second >> 12) & 7) << 8) |
      (second & 0xff);
    const rd = (second >> 8) & 0xf;
    const mnemonic = top ? 'movt' : 'movw';
    return makeInstruction(
      pc,
      4,
      first,
      top ? 'movt' : 'movw',
      mnemonic,
      `${mnemonic} ${formatReg(rd)}, #${imm}`,
      { rd, imm },
    );
  }

  // BL (immediate)
  if ((first & 0xf800) === 0xf000 && (second & 0xf800) === 0xf800) {
    const s = (first >> 10) & 1;
    const j1 = (second >> 13) & 1;
    const j2 = (second >> 11) & 1;
    const i1 = ~(j1 ^ s) & 1;
    const i2 = ~(j2 ^ s) & 1;
    const offset = signExtend(
      (s << 24) | (i1 << 23) | (i2 << 22) | ((first & 0x3ff) << 12) | ((second & 0x7ff) << 1),
      25,
    );
    const target = (nextPc + offset) >>> 0;
    return makeInstruction(pc, 4, first, 'bl', 'bl', `bl ${hex(target)}`, {
      target,
      cycles: CYCLE_TABLE.takenBranch,
      terminal: 'branch',
    });
  }

  throw new ThumbDecodeError('for an unsupported Thumb-32 form', { pc, opcode: first });
}

/**
 * Resolve IT-block membership for the instruction at `index`.
 * Branching into an IT block is architecturally UNPREDICTABLE, so walking the
 * linear block from its IT instruction is enough.
 */
function resolveItstate(code, index, pc) {
  for (let back = 2; back <= 8; back += 2) {
    const start = index - back;
    if (start < 0) break;
    const op = halfwordAt(code, start, pc);
    if ((op & 0xff00) !== 0xbf00) continue;
    const mask = op & 0xf;
    if (mask === 0) continue;
    const firstCondition = (op >> 4) & 0xf;
    if (firstCondition >= 0xe) continue;
    let itstate = (firstCondition << 4) | mask;
    let cursor = start + 2;
    for (let slot = 0; slot < 4 && itstate !== 0; slot++) {
      if (cursor === index)
        return { cond: itstate >> 4, after: advanceItstate(itstate), start: FLASH_BASE + start };
      if (cursor > index) break;
      cursor += sizeAt(code, cursor, FLASH_BASE + cursor);
      itstate = advanceItstate(itstate);
    }
  }
  return null;
}

function decodeAt(code, index, pc) {
  const first = halfwordAt(code, index, pc);
  const base = isWide(first) ? decodeThumb32(code, index, pc, first) : decodeThumb16(first, pc);
  const it = resolveItstate(code, index, pc);
  if (!it) return base;
  if (it.cond >= 0xe)
    throw new ThumbDecodeError('inside an IT block without a valid condition', {
      pc,
      opcode: base.opcode,
    });
  return Object.freeze({
    ...base,
    cond: it.cond,
    itstate: Object.freeze({ after: it.after, start: it.start }),
    text: `${base.text}    @ it ${CONDITION_NAMES[it.cond]}`,
  });
}

/**
 * Pure decoder used by tests and disassembly.
 * @param {Uint8Array} code flash image, indexed by `pc - FLASH_BASE`
 * @param {number} pc absolute address of the instruction
 */
export function decodeThumb(code, pc) {
  if (!code || typeof code.length !== 'number' || typeof code[0] !== 'number')
    throw new TypeError('decodeThumb requires the flash byte image');
  if (!Number.isSafeInteger(pc) || pc < FLASH_BASE)
    throw new RangeError('decodeThumb requires an absolute flash address');
  return decodeAt(code, pc - FLASH_BASE, pc);
}
// ---------------------------------------------------------------------------
// Builder value helpers
// ---------------------------------------------------------------------------

/** Value-building helpers for one instruction body or one branch body. */
class Body {
  constructor(builder, context) {
    this.b = builder;
    this.context = context;
    this.constants = new Map();
  }

  /** Unsigned 32-bit view; `>>> 0` is the only lossless conversion offered by the IR. */
  u32(value) {
    return this.b.shiftRightUnsigned(value, this.num(0));
  }

  num(value) {
    let slot = this.constants.get(value);
    if (slot === undefined) {
      slot = this.b.constant(types.number, value);
      this.constants.set(value, slot);
    }
    return slot;
  }

  read(register) {
    return this.b.readState(REGISTER_NAMES[register], types.number);
  }

  /** Reads a register field that may name the program counter. */
  readReg(insn, register) {
    return register === 15 ? this.num((insn.pc + 4) >>> 0) : this.read(register);
  }

  write(register, value) {
    if (register === 15)
      throw new TypeError('the program counter is only written through redirect');
    this.b.writeState(REGISTER_NAMES[register], value);
  }

  flag(name) {
    return this.b.readState(name, types.bool);
  }

  setFlag(name, value) {
    this.b.writeState(name, value);
  }

  setNz(result) {
    this.setFlag('n', this.b.greaterThan(result, this.num(0x7fffffff)));
    this.setFlag('z', this.b.equal(types.number, result, this.num(0)));
  }

  /** Result, carry-out and overflow of `a + d + carryIn`. */
  add(a, d, carryIn) {
    const b = this.b;
    const sum =
      carryIn === undefined || carryIn === null
        ? b.add(a, d)
        : b.add(b.add(a, d), typeof carryIn === 'number' ? this.num(carryIn) : carryIn);
    const result = this.u32(sum);
    this.setFlag('c', b.greaterThan(sum, this.num(MASK32)));
    this.setFlag('v', b.lessThan(b.bitAnd(b.bitXor(a, result), b.bitXor(d, result)), this.num(0)));
    this.setNz(result);
    return result;
  }

  /** Result, carry and overflow of `a - d - borrowIn`; the carry flag means no borrow. */
  subtract(a, d, borrowIn = 0) {
    const b = this.b;
    const raw =
      borrowIn === 0
        ? b.subtract(a, d)
        : b.subtract(
            b.subtract(a, d),
            typeof borrowIn === 'number' ? this.num(borrowIn) : borrowIn,
          );
    const result = this.u32(raw);
    this.setFlag(
      'c',
      borrowIn === 0
        ? b.greaterThanOrEqual(a, d)
        : b.greaterThanOrEqual(
            a,
            b.add(d, typeof borrowIn === 'number' ? this.num(borrowIn) : borrowIn),
          ),
    );
    this.setFlag('v', b.lessThan(b.bitAnd(b.bitXor(a, d), b.bitXor(a, result)), this.num(0)));
    this.setNz(result);
    return result;
  }

  /** Tests one bit of a 32-bit value. */
  bit(value, position) {
    if (typeof position === 'number' && position >= 31)
      return this.b.greaterThan(value, this.num(0x7fffffff));
    const shift = typeof position === 'number' ? this.num(position) : position;
    return this.b.equal(
      types.number,
      this.b.bitAnd(this.b.shiftRightUnsigned(value, shift), this.num(1)),
      this.num(1),
    );
  }

  signExtend(value, bits) {
    const shift = this.num(32 - bits);
    return this.u32(this.b.shiftRight(this.b.shiftLeft(value, shift), shift));
  }

  load(address, width) {
    return this.u32(this.context.emitLoad(this.b, address, width));
  }

  store(address, value, width) {
    this.context.emitStore(this.b, address, value, width);
  }
}

/**
 * Dynamic shift by a register amount.
 * The JavaScript shift operators mask the count, so amounts of 32 and above are
 * folded through selects instead of relying on the operator.
 */
function shiftByRegister(owner, mode, value, amount) {
  const b = owner.b;
  const pick = (condition, yes, no) =>
    b.select(
      types.bool,
      condition,
      () => yes,
      () => no,
    );
  const pickNumber = (condition, yes, no) =>
    b.select(
      types.number,
      condition,
      () => yes,
      () => no,
    );
  const count = b.bitAnd(amount, owner.num(0xff));
  const zero = b.equal(types.number, count, owner.num(0));
  const wide = b.greaterThan(count, owner.num(31));
  const at32 = b.equal(types.number, count, owner.num(32));
  const below = b.subtract(count, owner.num(1));
  if (mode === 3) {
    const rotate = b.bitAnd(count, owner.num(31));
    const rotated = owner.u32(
      b.bitOr(
        b.shiftRightUnsigned(value, rotate),
        b.shiftLeft(value, b.subtract(owner.num(32), rotate)),
      ),
    );
    return {
      result: pickNumber(zero, value, rotated),
      carry: pick(zero, owner.flag('c'), owner.bit(rotated, 31)),
    };
  }
  const top = owner.bit(value, 31);
  // LSR/ASR shift out bit (count - 1); LSL shifts out bit (32 - count).
  const carried = owner.bit(value, below);
  if (mode === 0) {
    const normal = owner.u32(b.shiftLeft(value, count));
    const lslCarried = owner.bit(value, b.subtract(owner.num(32), count));
    return {
      result: pickNumber(wide, owner.num(0), normal),
      carry: pick(
        zero,
        owner.flag('c'),
        pick(wide, pick(at32, owner.bit(value, 0), false), lslCarried),
      ),
    };
  }
  if (mode === 1) {
    const normal = b.shiftRightUnsigned(value, count);
    return {
      result: pickNumber(wide, owner.num(0), normal),
      carry: pick(zero, owner.flag('c'), pick(wide, pick(at32, top, false), carried)),
    };
  }
  const normal = owner.u32(b.shiftRight(value, count));
  const filled = owner.u32(b.shiftRight(value, owner.num(31)));
  return {
    result: pickNumber(wide, filled, normal),
    carry: pick(zero, owner.flag('c'), pick(wide, top, carried)),
  };
}
/** Boolean value of a condition code, evaluated from the current NZCV state. */
function emitCondition(b, cond) {
  const flag = (name) => b.readState(name, types.bool);
  switch (cond) {
    case 0x0:
      return b.equal(types.bool, flag('z'), true);
    case 0x1:
      return b.notEqual(types.bool, flag('z'), true);
    case 0x2:
      return b.equal(types.bool, flag('c'), true);
    case 0x3:
      return b.notEqual(types.bool, flag('c'), true);
    case 0x4:
      return b.equal(types.bool, flag('n'), true);
    case 0x5:
      return b.notEqual(types.bool, flag('n'), true);
    case 0x6:
      return b.equal(types.bool, flag('v'), true);
    case 0x7:
      return b.notEqual(types.bool, flag('v'), true);
    case 0x8:
      return b.and(flag('c'), (inner) =>
        inner.notEqual(types.bool, inner.readState('z', types.bool), true),
      );
    case 0x9:
      return b.or(b.notEqual(types.bool, flag('c'), true), (inner) =>
        inner.equal(types.bool, inner.readState('z', types.bool), true),
      );
    case 0xa:
      return b.equal(types.bool, flag('n'), flag('v'));
    case 0xb:
      return b.notEqual(types.bool, flag('n'), flag('v'));
    case 0xc:
      return b.and(b.equal(types.bool, flag('n'), flag('v')), (inner) =>
        inner.notEqual(types.bool, inner.readState('z', types.bool), true),
      );
    case 0xd:
      return b.or(b.notEqual(types.bool, flag('n'), flag('v')), (inner) =>
        inner.equal(types.bool, inner.readState('z', types.bool), true),
      );
    default:
      throw new RangeError(`Unsupported condition code ${cond}`);
  }
}

/** 32-bit product assembled from 16-bit halves; `a * b` alone overflows binary64. */
function multiply32(owner, a, d) {
  const b = owner.b;
  const aLow = b.bitAnd(a, owner.num(0xffff));
  const dLow = b.bitAnd(d, owner.num(0xffff));
  const aHigh = b.shiftRightUnsigned(a, owner.num(16));
  const dHigh = b.shiftRightUnsigned(d, owner.num(16));
  const cross = b.add(b.multiply(aHigh, dLow), b.multiply(aLow, dHigh));
  return owner.u32(b.add(b.multiply(aLow, dLow), b.multiply(cross, owner.num(0x10000))));
}

// ---------------------------------------------------------------------------
// instruction lowering
// ---------------------------------------------------------------------------

const HANDLERS = {
  'shift-imm'(owner, insn) {
    const b = owner.b;
    const value = owner.read(insn.rm);
    let result;
    let carry;
    if (insn.shift === 0) {
      if (insn.imm === 0) {
        result = value;
      } else {
        result = owner.u32(b.shiftLeft(value, owner.num(insn.imm)));
        // LSL shifts the top bits out: the carry is bit (32 - imm) of the source.
        carry = owner.bit(value, 32 - insn.imm);
      }
    } else if (insn.shift === 1) {
      const amount = insn.imm === 0 ? 32 : insn.imm;
      result = amount === 32 ? owner.num(0) : b.shiftRightUnsigned(value, owner.num(amount));
      carry = owner.bit(value, amount - 1);
    } else {
      const amount = insn.imm === 0 ? 32 : insn.imm;
      result =
        amount === 32
          ? owner.u32(b.shiftRight(value, owner.num(31)))
          : owner.u32(b.shiftRight(value, owner.num(amount)));
      carry = owner.bit(value, amount - 1);
    }
    owner.write(insn.rd, result);
    owner.setNz(result);
    if (carry !== undefined) owner.setFlag('c', carry);
  },

  'add-sub'(owner, insn) {
    const a = owner.read(insn.rn);
    if (insn.mov) {
      const value = owner.num(insn.imm);
      owner.write(insn.rd, value);
      owner.setNz(value);
      return;
    }
    const d = insn.rm === null ? owner.num(insn.imm) : owner.read(insn.rm);
    if (!insn.withResult) {
      owner.subtract(a, d);
      return;
    }
    owner.write(insn.rd, insn.sub ? owner.subtract(a, d) : owner.add(a, d));
  },

  'dp-reg'(owner, insn) {
    const b = owner.b;
    const a = owner.read(insn.rd);
    const d = owner.read(insn.rm);
    switch (insn.dp) {
      case 0x0: {
        const result = owner.u32(b.bitAnd(a, d));
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
      case 0x1: {
        const result = owner.u32(b.bitXor(a, d));
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x7: {
        const mode = insn.dp === 0x2 ? 0 : insn.dp === 0x3 ? 1 : insn.dp === 0x4 ? 2 : 3;
        const shifted = shiftByRegister(owner, mode, a, d);
        owner.write(insn.rd, shifted.result);
        owner.setNz(shifted.result);
        owner.setFlag('c', shifted.carry);
        break;
      }
      case 0x5: {
        const carry = b.select(
          types.number,
          owner.flag('c'),
          (inner) => inner.constant(types.number, 1),
          (inner) => inner.constant(types.number, 0),
        );
        owner.write(insn.rd, owner.add(a, d, carry));
        break;
      }
      case 0x6: {
        const borrow = b.select(
          types.number,
          owner.flag('c'),
          (inner) => inner.constant(types.number, 0),
          (inner) => inner.constant(types.number, 1),
        );
        owner.write(insn.rd, owner.subtract(a, d, borrow));
        break;
      }
      case 0x8:
        owner.setNz(owner.u32(b.bitAnd(a, d)));
        break;
      case 0x9:
        owner.write(insn.rd, owner.subtract(owner.num(0), d));
        break;
      case 0xa:
        owner.subtract(a, d);
        break;
      case 0xb:
        owner.add(a, d);
        break;
      case 0xc: {
        const result = owner.u32(b.bitOr(a, d));
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
      case 0xd: {
        const result = multiply32(owner, a, d);
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
      case 0xe: {
        const result = owner.u32(b.bitAnd(a, b.bitNot(d)));
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
      default: {
        const result = owner.u32(b.bitNot(d));
        owner.write(insn.rd, result);
        owner.setNz(result);
        break;
      }
    }
  },

  'hi-add'(owner, insn) {
    const result = owner.u32(
      owner.b.add(owner.readReg(insn, insn.rd), owner.readReg(insn, insn.rm)),
    );
    if (insn.rd !== 15) owner.write(insn.rd, result);
  },

  'hi-cmp'(owner, insn) {
    owner.subtract(owner.readReg(insn, insn.rd), owner.readReg(insn, insn.rm));
  },

  'hi-mov'(owner, insn) {
    const value = owner.readReg(insn, insn.rm);
    if (insn.rd === 15) {
      // MOV pc, Rm is an interworking branch; exception return needs BX.
      owner.b.redirect(
        owner.u32(owner.b.bitAnd(value, owner.num(-2))),
        owner.context.cycles(CYCLE_TABLE.takenBranch),
      );
      return { skipElapse: true };
    }
    owner.write(insn.rd, value);
  },

  bx(owner, insn) {
    return branchExchange(owner, insn, false);
  },

  blx(owner, insn) {
    return branchExchange(owner, insn, true);
  },

  ld(owner, insn) {
    const b = owner.b;
    const address = insn.literal
      ? owner.num((((insn.pc + 4) & ~3) + insn.imm) >>> 0)
      : insn.rm === null
        ? owner.u32(b.add(owner.read(insn.rn), owner.num(insn.imm)))
        : owner.u32(b.add(owner.read(insn.rn), owner.read(insn.rm)));
    const value = owner.load(address, insn.width);
    const result = insn.signed ? owner.signExtend(value, insn.width * 8) : value;
    return () => owner.write(insn.rt, result);
  },

  st(owner, insn) {
    const b = owner.b;
    const address = owner.u32(
      insn.rm === null
        ? b.add(owner.read(insn.rn), owner.num(insn.imm))
        : b.add(owner.read(insn.rn), owner.read(insn.rm)),
    );
    owner.store(address, owner.read(insn.rt), insn.width);
  },

  adr(owner, insn) {
    owner.write(insn.rd, owner.num((((insn.pc + 4) & ~3) + insn.imm) >>> 0));
  },

  'add-sp-imm'(owner, insn) {
    owner.write(insn.rd, owner.u32(owner.b.add(owner.read(13), owner.num(insn.imm))));
  },

  'add-sub-sp'(owner, insn) {
    const b = owner.b;
    const sp = owner.read(13);
    owner.write(
      13,
      insn.sub
        ? owner.u32(b.subtract(sp, owner.num(insn.imm)))
        : owner.u32(b.add(sp, owner.num(insn.imm))),
    );
  },

  extend(owner, insn) {
    const b = owner.b;
    const value = owner.read(insn.rm);
    const result =
      insn.sel === 0
        ? owner.signExtend(value, 16)
        : insn.sel === 1
          ? owner.signExtend(value, 8)
          : insn.sel === 2
            ? owner.u32(b.bitAnd(value, owner.num(0xffff)))
            : owner.u32(b.bitAnd(value, owner.num(0xff)));
    owner.write(insn.rd, result);
  },

  reverse(owner, insn) {
    const b = owner.b;
    const value = owner.read(insn.rm);
    const swap = (input) =>
      b.bitOr(
        b.bitAnd(b.shiftLeft(input, owner.num(8)), owner.num(0xff00)),
        b.bitAnd(b.shiftRightUnsigned(input, owner.num(8)), owner.num(0xff)),
      );
    const swapped = owner.u32(
      b.bitOr(
        b.shiftLeft(swap(b.shiftRightUnsigned(value, owner.num(16))), owner.num(16)),
        swap(value),
      ),
    );
    owner.write(insn.rd, insn.sel === 2 ? owner.signExtend(owner.u32(swap(value)), 16) : swapped);
  },

  push(owner, insn) {
    const b = owner.b;
    const sp = owner.u32(b.subtract(owner.read(13), owner.num(insn.registers.length * 4)));
    owner.write(13, sp);
    insn.registers.forEach((register, slot) => {
      owner.store(owner.u32(b.add(sp, owner.num(slot * 4))), owner.readReg(insn, register), 4);
    });
  },

  pop(owner, insn) {
    const b = owner.b;
    const base = owner.read(13);
    let branch = null;
    const loaded = insn.registers.map((register, slot) => {
      const value = owner.load(owner.u32(b.add(base, owner.num(slot * 4))), 4);
      if (register === 15) branch = value;
      return { register, value };
    });
    owner.write(13, owner.u32(b.add(base, owner.num(insn.registers.length * 4))));
    for (const entry of loaded) if (entry.register !== 15) owner.write(entry.register, entry.value);
    if (branch === null) return undefined;
    b.redirect(owner.u32(b.bitAnd(branch, owner.num(-2))), owner.context.cycles(insn.cycles));
    return { skipElapse: true };
  },

  ldm(owner, insn) {
    const b = owner.b;
    const base = owner.read(insn.rn);
    insn.registers.forEach((register, slot) => {
      const value = owner.load(owner.u32(b.add(base, owner.num(slot * 4))), 4);
      owner.write(register, value);
    });
    if (!insn.registers.includes(insn.rn))
      owner.write(insn.rn, owner.u32(b.add(base, owner.num(insn.registers.length * 4))));
  },

  stm(owner, insn) {
    const b = owner.b;
    const base = owner.read(insn.rn);
    insn.registers.forEach((register, slot) => {
      owner.store(owner.u32(b.add(base, owner.num(slot * 4))), owner.read(register), 4);
    });
    if (!insn.registers.includes(insn.rn))
      owner.write(insn.rn, owner.u32(b.add(base, owner.num(insn.registers.length * 4))));
  },

  cps(owner, insn) {
    owner.b.writeState('primask', owner.num(insn.disable ? 1 : 0));
  },

  nop() {},

  it(owner, insn) {
    owner.b.writeState('itstate', owner.num(insn.itstate));
  },

  movw(owner, insn) {
    owner.write(insn.rd, owner.num(insn.imm));
  },

  movt(owner, insn) {
    const b = owner.b;
    owner.write(
      insn.rd,
      owner.u32(
        b.add(b.bitAnd(owner.read(insn.rd), owner.num(0xffff)), owner.num(insn.imm * 0x10000)),
      ),
    );
  },
};
/** BX / BLX: exception return for EXC_RETURN, interworking branch otherwise. */
function branchExchange(owner, insn, link) {
  const b = owner.b;
  const target = owner.readReg(insn, insn.rm);
  // Compute every outer value before the lazy region: callbacks may only emit on
  // the builder they receive.
  const aligned = owner.u32(b.bitAnd(target, owner.num(-2)));
  if (link) {
    owner.write(14, owner.num(insn.nextPc | 1));
    b.redirect(aligned, owner.context.cycles(CYCLE_TABLE.takenBranch));
    return { skipElapse: true };
  }
  b.if(
    b.equal(types.number, target, owner.num(EXC_RETURN)),
    (body) => emitExceptionReturn(new Body(body, owner.context)),
    (body) => body.redirect(aligned, owner.context.cycles(CYCLE_TABLE.takenBranch)),
  );
  return { skipElapse: true };
}

/** bx EXC_RETURN: pop the eight-word hardware frame and resume the thread. */
function emitExceptionReturn(owner) {
  const b = owner.b;
  const sp = owner.read(13);
  const word = (index) => owner.load(owner.u32(b.add(sp, owner.num(index * 4))), 4);
  const r0 = word(0);
  const r1 = word(1);
  const r2 = word(2);
  const r3 = word(3);
  const r12 = word(4);
  const lr = word(5);
  const returnPc = word(6);
  const xpsr = word(7);
  owner.write(13, owner.u32(b.add(sp, owner.num(32))));
  owner.write(0, r0);
  owner.write(1, r1);
  owner.write(2, r2);
  owner.write(3, r3);
  owner.write(12, r12);
  owner.write(14, lr);
  owner.setFlag('n', owner.bit(xpsr, 31));
  owner.setFlag('z', owner.bit(xpsr, 30));
  owner.setFlag('c', owner.bit(xpsr, 29));
  owner.setFlag('v', owner.bit(xpsr, 28));
  const high = b.bitAnd(b.shiftRightUnsigned(xpsr, owner.num(10)), owner.num(0x3f));
  const low = b.bitAnd(b.shiftRightUnsigned(xpsr, owner.num(25)), owner.num(3));
  b.writeState('itstate', owner.u32(b.bitOr(b.shiftLeft(high, owner.num(2)), low)));
  b.writeState('ipsr', b.bitAnd(xpsr, owner.num(0x1ff)));
  b.redirect(
    owner.u32(b.bitAnd(returnPc, owner.num(-2))),
    owner.context.cycles(CYCLE_TABLE.exception),
  );
}

/** Branch, conditional branch and CBZ/CBNZ; each terminates the block. */
function emitBranch(owner, insn) {
  const b = owner.b;
  if (insn.kind === 'bl') {
    owner.write(14, owner.num(insn.nextPc | 1));
    b.redirect(owner.num(insn.target), owner.context.cycles(CYCLE_TABLE.takenBranch));
    return;
  }
  if (insn.cond === null && insn.kind !== 'cbz') {
    b.redirect(owner.num(insn.target), owner.context.cycles(CYCLE_TABLE.takenBranch));
    return;
  }
  let condition;
  if (insn.kind === 'cbz') {
    const value = owner.read(insn.rn);
    const zero = b.equal(types.number, value, owner.num(0));
    const test = insn.nonzero ? b.notEqual(types.number, value, owner.num(0)) : zero;
    condition = insn.cond === null ? test : b.and(test, (inner) => emitCondition(inner, insn.cond));
  } else {
    condition = emitCondition(b, insn.cond);
  }
  if (insn.itstate) b.writeState('itstate', owner.num(insn.itstate.after));
  const target = b.select(
    types.number,
    condition,
    (body) => body.constant(types.number, insn.target),
    (body) => body.constant(types.number, insn.nextPc),
  );
  if (owner.context.exactBranchCycles) {
    const delay = b.select(
      types.number,
      condition,
      (body) => body.constant(types.number, owner.context.cycles(CYCLE_TABLE.takenBranch)),
      (body) => body.constant(types.number, owner.context.cycles(CYCLE_TABLE.notTaken)),
    );
    b.redirect(target, delay);
    return;
  }
  b.redirect(target, owner.context.cycles(CYCLE_TABLE.takenBranch));
}

function emitCore(owner, insn) {
  const handler = HANDLERS[insn.kind];
  if (!handler) throw new RangeError(`No lowering for Thumb instruction kind ${insn.kind}`);
  const plan = handler(owner, insn);
  if (plan && plan.skipElapse) return;
  owner.b.elapse(owner.context.cycles(insn.cycles));
  if (typeof plan === 'function') plan();
}

function emitInstructionBody(builder, context, insn) {
  const owner = new Body(builder, context);
  if (insn.terminal === 'branch') {
    emitBranch(owner, insn);
    return;
  }
  if (insn.cond !== null) {
    if (insn.itstate) builder.writeState('itstate', owner.num(insn.itstate.after));
    builder.if(
      emitCondition(builder, insn.cond),
      (body) => emitCore(new Body(body, context), insn),
      (body) => body.elapse(context.cycles(CYCLE_TABLE.notTaken)),
    );
    return;
  }
  emitCore(owner, insn);
}

// ---------------------------------------------------------------------------
// device registration
// ---------------------------------------------------------------------------

function checkCyclePs(cyclePs) {
  if (!Number.isSafeInteger(cyclePs) || cyclePs < 1 || cyclePs > 1_000_000)
    throw new RangeError('cyclePs must be an integer in [1, 1000000]');
  return cyclePs;
}

/** xPSR image of the interrupted context: NZCV, Thumb, ITSTATE and IPSR. */
function xpsrValue(owner) {
  const b = owner.b;
  const term = (flag, position) =>
    b.select(
      types.number,
      owner.flag(flag),
      (inner) => inner.constant(types.number, 1 << position),
      (inner) => inner.constant(types.number, 0),
    );
  const itstate = b.readState('itstate', types.number);
  const nz = b.add(term('n', 31), term('z', 30));
  const cv = b.add(term('c', 29), term('v', 28));
  const itHigh = b.multiply(
    b.bitAnd(b.shiftRightUnsigned(itstate, owner.num(2)), owner.num(0x3f)),
    owner.num(0x400),
  );
  const itLow = b.multiply(b.bitAnd(itstate, owner.num(3)), owner.num(0x2000000));
  return b.add(
    b.add(b.add(nz, cv), owner.num(1 << 24)),
    b.add(b.add(itHigh, itLow), b.readState('ipsr', types.number)),
  );
}

/**
 * Declare the CPU states, the `takeIrq` guard and the hardware exception entry.
 * The bus owns `irqPending`; declare it there before finishing the device.
 * @param {import('../../../device-model/dist/index.js').DeviceBuilder} d
 * @param {{ cyclePs: number, bus?: { emitLoad: Function, emitStore: Function } }} options
 */
export function registerCpu(d, { cyclePs, bus } = {}) {
  if (
    !d ||
    typeof d.state !== 'function' ||
    typeof d.derived !== 'function' ||
    typeof d.fn !== 'function'
  )
    throw new TypeError('registerCpu requires a device Builder');
  const clock = checkCyclePs(cyclePs);
  const access = resolveBusAccess(bus, 'bytes');
  for (let index = 0; index <= 14; index++)
    d.state({
      name: REGISTER_NAMES[index],
      type: types.number,
      initial: cpuInitialState[REGISTER_NAMES[index]],
    });
  d.state({ name: 'pc', type: types.number, initial: RESET_PC });
  for (const name of FLAG_NAMES) d.state({ name, type: types.bool, initial: false });
  d.state({ name: 'itstate', type: types.number, initial: 0 });
  d.state({ name: 'primask', type: types.number, initial: 0 });
  d.state({ name: 'ipsr', type: types.number, initial: 0 });

  d.derived({ name: 'takeIrq', type: types.bool }, (b) => {
    b.returnValue(
      b.and(b.readState('irqPending', types.bool), (inner) =>
        inner.and(
          inner.equal(types.number, inner.readState('primask', types.number), 0),
          (nested) => nested.equal(types.number, nested.readState('ipsr', types.number), 0),
        ),
      ),
    );
  });

  d.fn({ name: 'enterIrq', params: [] }, (b) => {
    const context = {
      cycles: (count) => count * clock,
      emitLoad: access.emitLoad,
      emitStore: access.emitStore,
    };
    const owner = new Body(b, context);
    const sp = owner.u32(b.subtract(b.readState('r13', types.number), owner.num(32)));
    b.writeState('r13', sp);
    const push = (index, value) =>
      owner.store(owner.u32(b.add(sp, owner.num(index * 4))), value, 4);
    for (const [index, register] of [0, 1, 2, 3].entries()) push(index, owner.read(register));
    push(4, owner.read(12));
    push(5, owner.read(14));
    push(6, b.readState('pc', types.number));
    push(7, xpsrValue(owner));
    b.writeState('r14', owner.num(EXC_RETURN));
    b.writeState('itstate', owner.num(0));
    b.writeState('ipsr', owner.num(15));
    b.writeState('irqPending', false);
    const vector = owner.u32(b.add(owner.load(owner.num(SCB_VTOR), 4), owner.num(15 * 4)));
    const handler = owner.load(vector, 4);
    b.redirect(owner.u32(b.bitAnd(handler, owner.num(-2))), context.cycles(CYCLE_TABLE.exception));
  });
}
// ---------------------------------------------------------------------------
// translation
// ---------------------------------------------------------------------------

/** Resolve the bus access helpers, preferring `createBusAccess({ memoryAccess })`. */
function resolveBusAccess(bus, memoryAccess) {
  let source = bus;
  if (source === undefined) {
    try {
      source = requireModule('./bus.mjs');
    } catch (error) {
      if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'))
        throw new Error(
          'The CPU needs ./bus.mjs (registerBus/emitLoad/emitStore) or an explicit bus option',
          { cause: error },
        );
      throw error;
    }
  }
  if (typeof source.createBusAccess === 'function')
    source = source.createBusAccess({ memoryAccess });
  if (!source || typeof source.emitLoad !== 'function' || typeof source.emitStore !== 'function')
    throw new TypeError(
      'The bus must expose emitLoad(b, address, width) and emitStore(b, address, value, width)',
    );
  return { emitLoad: source.emitLoad, emitStore: source.emitStore };
}

/**
 * Build the JIT translator for the STM32G431 Thumb core.
 * @param {{ cyclePs: number, blockSize?: number, memoryAccess?: 'bytes' | 'wide',
 *   exactBranchCycles?: boolean, bus?: { emitLoad: Function, emitStore: Function } }} options
 */
export function createThumbTranslator({
  cyclePs,
  blockSize = 8,
  memoryAccess = 'bytes',
  exactBranchCycles = true,
  bus,
} = {}) {
  const clock = checkCyclePs(cyclePs);
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 8)
    throw new RangeError('blockSize must be an integer in [1, 8]');
  if (memoryAccess !== 'bytes' && memoryAccess !== 'wide')
    throw new RangeError("memoryAccess must be 'bytes' or 'wide'");
  const access = resolveBusAccess(bus, memoryAccess);
  const context = Object.freeze({
    cycles: (count) => count * clock,
    emitLoad: access.emitLoad,
    emitStore: access.emitStore,
    exactBranchCycles: Boolean(exactBranchCycles),
  });
  return function translate({ pc, code }, block) {
    if (!Number.isSafeInteger(pc) || pc < FLASH_BASE)
      throw new TypeError('Translation requires an absolute flash address');
    let address = pc;
    for (let count = 0; count < blockSize; count++) {
      const insn = decodeThumb(code, address);
      block.instruction({ pc: address, nextPc: insn.nextPc }, (b) =>
        emitInstructionBody(b, context, insn),
      );
      if (insn.terminal) break;
      address = insn.nextPc;
    }
    return block.finish();
  };
}
