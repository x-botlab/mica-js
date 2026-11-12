import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { APSR_C } from './layout';
import {
  addWithCarry,
  asBody,
  flag,
  isZero,
  num,
  readReg,
  setPc,
  setPcConst,
  shiftValue,
  signExtend,
  signIsSet,
  subtractWithCarry,
  u32,
  u8,
  writeNz,
  writeReg,
  writeSp,
  readSp,
} from './ir';
import type { Body } from './ir';
import { conditional, loadRegister, readAnyReg, storeRegister, writeAnyReg } from './cpu';
import { exceptionReturn, isExceptionReturn } from './nvic';

export interface Instruction16 {
  readonly size: 2;
  readonly cycles: number;
  readonly emit: (b: Body, pc: number) => void;
}

const signed8 = (value: number): number => (value & 0x80 ? value - 0x100 : value);
const signed11 = (value: number): number => (value & 0x400 ? value - 0x800 : value);

const addFlags = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  addWithCarry(b, left, right, num(b, 0));

const subFlags = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  subtractWithCarry(b, left, right, num(b, 0));

const writeResult = (b: Body, index: number, value: Value<number>): void => {
  writeReg(b, index, value);
};

export function halt(b: Body, pc: number, code: number): void {
  b.send('fault', num(b, (pc << 8) | code));
  b.writeState('faultPc', num(b, pc));
  b.writeState('halted', b.constant(types.bool, true));
}

function reverse32(b: Body, value: Value<number>): Value<number> {
  const v = u32(b, value);

  return b.bitOr(
    b.bitOr(
      b.shiftLeft(b.bitAnd(v, num(b, 0x000000ff)), num(b, 24)),
      b.shiftLeft(b.bitAnd(v, num(b, 0x0000ff00)), num(b, 8)),
    ),
    b.bitOr(
      b.shiftRightUnsigned(b.bitAnd(v, num(b, 0x00ff0000)), num(b, 8)),
      b.shiftRightUnsigned(b.bitAnd(v, num(b, 0xff000000)), num(b, 24)),
    ),
  );
}

function reverse16(b: Body, value: Value<number>): Value<number> {
  const v = u32(b, value);

  return b.bitOr(
    b.bitOr(
      b.shiftLeft(b.bitAnd(v, num(b, 0x000000ff)), num(b, 8)),
      b.bitAnd(v, num(b, 0x0000ff00)),
    ),
    b.bitOr(
      b.shiftRightUnsigned(b.bitAnd(v, num(b, 0x00ff0000)), num(b, 8)),
      b.shiftRightUnsigned(b.bitAnd(v, num(b, 0xff000000)), num(b, 24)),
    ),
  );
}

export function decode16(instr: number): Instruction16 {
  const emit = (b: Body, pc: number): void => emit16(b, pc, instr);
  const cycles = 1;

  return { size: 2, cycles, emit };
}

function emit16(b: Body, pc: number, instr: number): void {
  if (instr < 0x1800) {
    // LSL/LSR/ASR immediate.
    const op = (instr >> 11) & 3;
    const rm = (instr >> 3) & 7;
    const rd = instr & 7;
    const amount = (instr >> 6) & 0x1f;
    const source = readReg(b, rm);

    if (op === 0 && amount === 0) {
      writeNz(b, signIsSet(b, source), isZero(b, source));
      writeResult(b, rd, source);
    } else if (op === 3) {
      halt(b, pc, 0x01);
    } else {
      const value = shiftValue(
        b,
        source,
        num(b, op === 0 ? amount : amount === 0 ? 32 : amount),
        op,
      );
      writeResult(b, rd, value);
    }

    return;
  }

  if (instr < 0x2000) {
    // ADD/SUB register or 3-bit immediate.
    const immediate = (instr & 0x0400) !== 0;
    const sub = (instr & 0x0200) !== 0;
    const rn = (instr >> 3) & 7;
    const rd = instr & 7;
    const rhs = immediate ? num(b, (instr >> 6) & 7) : readReg(b, (instr >> 6) & 7);
    const value = sub ? subFlags(b, readReg(b, rn), rhs) : addFlags(b, readReg(b, rn), rhs);

    writeResult(b, rd, value);

    return;
  }

  if (instr < 0x4000) {
    // MOV/CMP/ADD/SUB immediate 8.
    const op = (instr >> 11) & 3;
    const rd = (instr >> 8) & 7;
    const imm = instr & 0xff;

    if (op === 0) {
      const value = num(b, imm);

      writeNz(b, signIsSet(b, value), isZero(b, value));
      writeResult(b, rd, value);
    } else if (op === 1) {
      subFlags(b, readReg(b, rd), num(b, imm));
    } else if (op === 2) {
      writeResult(b, rd, addFlags(b, readReg(b, rd), num(b, imm)));
    } else {
      writeResult(b, rd, subFlags(b, readReg(b, rd), num(b, imm)));
    }

    return;
  }

  if (instr < 0x4400) {
    // Data processing.
    const op = (instr >> 6) & 0xf;
    const rm = (instr >> 3) & 7;
    const rdn = instr & 7;
    const left = readReg(b, rdn);
    const right = readReg(b, rm);
    const carry = flag(b, APSR_C);
    const carryValue = b.select(
      types.number,
      carry,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    );
    const borrow = b.select(
      types.number,
      carry,
      (inner) => inner.constant(types.number, 0),
      (inner) => inner.constant(types.number, 1),
    );

    switch (op) {
      case 0: {
        const value = b.bitAnd(left, right);

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
        break;
      }
      case 1: {
        const value = b.bitXor(left, right);

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
        break;
      }
      case 2:
      case 3:
      case 4:
      case 7: {
        const amount = b.bitAnd(right, num(b, 0xff));
        const type = op === 2 ? 0 : op === 3 ? 1 : op === 4 ? 2 : 3;
        const value = shiftValue(b, left, amount, type);

        writeResult(b, rdn, value);
        break;
      }
      case 5:
        writeResult(b, rdn, addWithCarry(b, left, right, carryValue));
        break;
      case 6:
        writeResult(b, rdn, subtractWithCarry(b, left, right, borrow));
        break;
      case 8: {
        const value = b.bitAnd(left, right);

        writeNz(b, signIsSet(b, value), isZero(b, value));
        break;
      }
      case 9:
        writeResult(b, rdn, subtractWithCarry(b, num(b, 0), right, num(b, 0)));
        break;
      case 10:
        subtractWithCarry(b, left, right, num(b, 0));
        break;
      case 11:
        addWithCarry(b, left, right, num(b, 0));
        break;
      case 12: {
        const value = b.bitOr(left, right);

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
        break;
      }
      case 13: {
        const value = u32(b, b.multiply(left, right));

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
        break;
      }
      case 14: {
        const value = b.bitAnd(left, b.bitNot(right));

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
        break;
      }
      default: {
        const value = b.bitNot(right);

        writeNz(b, signIsSet(b, value), isZero(b, value));
        writeResult(b, rdn, value);
      }
    }

    return;
  }

  if (instr < 0x4800) {
    // Hi register operations / BX / BLX.
    const op = (instr >> 8) & 3;
    const rd = (instr & 7) | ((instr >> 4) & 8);
    const rm = (instr >> 3) & 0xf;

    if (op === 0) {
      const value = b.add(readAnyReg(b, rd, pc), readAnyReg(b, rm, pc));

      writeAnyReg(b, rd, u32(b, value));
    } else if (op === 1) {
      const left = readAnyReg(b, rd, pc);
      const right = readAnyReg(b, rm, pc);

      subFlags(b, left, right);
    } else if (op === 2) {
      writeAnyReg(b, rd, readAnyReg(b, rm, pc));
    } else {
      const target = readAnyReg(b, rm, pc);

      if (instr & 0x80) {
        writeReg(b, 14, num(b, (pc + 2) | 1));
        b.if(
          isExceptionReturn(b, target),
          (inner) => exceptionReturn(asBody(inner)),
          (normal) => {
            const body = asBody(normal);
            const low = body.bitAnd(target, body.constant(types.number, 1));

            body.if(
              body.equal(types.number, low, body.constant(types.number, 0)),
              (broken) => halt(asBody(broken), pc, 0x02),
              (valid) => setPc(asBody(valid), target),
            );
          },
        );
      } else {
        b.if(
          isExceptionReturn(b, target),
          (inner) => exceptionReturn(asBody(inner)),
          (normal) => {
            const body = asBody(normal);

            setPc(body, target);
          },
        );
      }
    }

    return;
  }

  if (instr < 0x5000) {
    // LDR literal.
    const rt = (instr >> 8) & 7;
    const address = (pc + 4 + ((instr & 0xff) << 2)) >>> 0;

    loadRegister(b, rt, num(b, address & ~3), 4, pc);

    return;
  }

  if (instr < 0x6000) {
    // Load/store register offset.
    const op = (instr >> 9) & 7;
    const rm = (instr >> 6) & 7;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;
    const address = b.add(readReg(b, rn), readReg(b, rm));

    switch (op) {
      case 0:
        storeRegister(b, rt, address, 4, pc);
        break;
      case 1:
        storeRegister(b, rt, address, 2, pc);
        break;
      case 2:
        storeRegister(b, rt, address, 1, pc);
        break;
      case 3:
        loadRegister(b, rt, address, 1, pc, true);
        break;
      case 4:
        loadRegister(b, rt, address, 4, pc);
        break;
      case 5:
        loadRegister(b, rt, address, 2, pc);
        break;
      case 6:
        loadRegister(b, rt, address, 1, pc);
        break;
      default:
        loadRegister(b, rt, address, 2, pc, true);
    }

    return;
  }

  if (instr < 0x9000) {
    // Load/store immediate offset: word, byte, halfword.
    const kind = (instr >> 12) & 0xf;
    const load = (instr & 0x0800) !== 0;
    const imm = (instr >> 6) & 0x1f;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;
    const size = kind === 6 ? 4 : kind === 7 ? 1 : 2;
    const address = b.add(readReg(b, rn), num(b, imm * size));

    if (load) loadRegister(b, rt, address, size, pc);
    else storeRegister(b, rt, address, size, pc);

    return;
  }

  if (instr < 0xa000) {
    // SP-relative load/store.
    const load = (instr & 0x0800) !== 0;
    const rt = (instr >> 8) & 7;
    const address = b.add(readSp(b), num(b, (instr & 0xff) << 2));

    if (load) loadRegister(b, rt, address, 4, pc);
    else storeRegister(b, rt, address, 4, pc);

    return;
  }

  if (instr < 0xb000) {
    // ADR / ADD SP.
    const rd = (instr >> 8) & 7;
    const imm = (instr & 0xff) << 2;

    if (instr & 0x0800) writeSp(b, b.add(readSp(b), num(b, imm)));
    else writeResult(b, rd, num(b, (((pc + 4) & ~3) + imm) >>> 0));

    return;
  }

  if (instr < 0xc000) {
    emitMisc16(b, pc, instr);

    return;
  }

  if (instr < 0xd000) {
    // LDM/STM.
    const load = (instr & 0x0800) !== 0;
    const rn = (instr >> 8) & 7;
    const list = instr & 0xff;
    const registers: number[] = [];

    for (let index = 0; index < 8; index += 1) if (list & (1 << index)) registers.push(index);

    const base = readAnyReg(b, rn, pc);

    if (load) {
      registers.forEach((register, offset) =>
        loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc),
      );
      if (!registers.includes(rn)) writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
    } else {
      registers.forEach((register, offset) =>
        storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc),
      );
      writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
    }

    return;
  }

  if (instr < 0xe000) {
    // Conditional branch / SVC / UDF.
    const condition = (instr >> 8) & 0xf;
    const offset = signed8(instr & 0xff);

    if (condition === 0xe) {
      halt(b, pc, 0x03);
    } else if (condition === 0xf) {
      halt(b, pc, 0x04);
    } else {
      const target = (pc + 4 + offset * 2) >>> 0;

      conditional(b, condition, (body) => setPcConst(body, target));
    }

    return;
  }

  if (instr < 0xf000) {
    // Unconditional branch.
    const target = (pc + 4 + signed11(instr & 0x7ff) * 2) >>> 0;

    setPcConst(b, target);

    return;
  }

  halt(b, pc, 0x05);
}

function emitMisc16(b: Body, pc: number, instr: number): void {
  if ((instr & 0xff00) === 0xb000) {
    const sub = (instr & 0x80) !== 0;
    const imm = (instr & 0x7f) << 2;

    writeSp(b, sub ? b.subtract(readSp(b), num(b, imm)) : b.add(readSp(b), num(b, imm)));

    return;
  }

  if ((instr & 0xff00) === 0xb100) {
    const compareZero = (instr & 0x0800) === 0;
    const i = (instr >> 9) & 1;
    const imm5 = (instr >> 3) & 0x1f;
    const rn = instr & 7;
    const offset = (i << 6) | (imm5 << 1);
    const target = (pc + 4 + offset) >>> 0;
    const value = readReg(b, rn);
    const zero = b.equal(types.number, u32(b, value), num(b, 0));

    b.if(compareZero ? zero : b.not(zero), (body) => setPcConst(asBody(body), target));

    return;
  }

  if ((instr & 0xff00) === 0xb200) {
    const op = (instr >> 6) & 3;
    const rm = (instr >> 3) & 7;
    const rd = instr & 7;
    const source = readReg(b, rm);
    const value =
      op === 0
        ? signExtend(b, source, 16)
        : op === 1
          ? signExtend(b, source, 8)
          : op === 2
            ? b.bitAnd(source, num(b, 0xffff))
            : u8(b, source);

    writeReg(b, rd, value);

    return;
  }

  if ((instr & 0xff00) === 0xb300) {
    const op = (instr >> 6) & 3;
    const rm = (instr >> 3) & 7;
    const rd = instr & 7;
    const source = readReg(b, rm);
    const value =
      op === 0
        ? reverse32(b, source)
        : op === 1
          ? reverse16(b, source)
          : signExtend(
              b,
              b.bitOr(
                b.shiftLeft(b.bitAnd(source, num(b, 0xff)), num(b, 8)),
                b.shiftRightUnsigned(b.bitAnd(source, num(b, 0xff00)), num(b, 8)),
              ),
              16,
            );

    writeReg(b, rd, value);

    return;
  }

  if ((instr & 0xfe00) === 0xb400) {
    const includeLr = (instr & 0x0100) !== 0;
    const list = instr & 0xff;
    const registers: number[] = [];

    for (let index = 0; index < 8; index += 1) if (list & (1 << index)) registers.push(index);
    if (includeLr) registers.push(14);

    const size = registers.length * 4;
    const base = b.subtract(readSp(b), num(b, size));

    registers.forEach((register, offset) =>
      storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc),
    );
    writeSp(b, base);

    return;
  }

  if ((instr & 0xfe00) === 0xbc00) {
    const includePc = (instr & 0x0100) !== 0;
    const list = instr & 0xff;
    const registers: number[] = [];

    for (let index = 0; index < 8; index += 1) if (list & (1 << index)) registers.push(index);
    if (includePc) registers.push(15);

    const base = readSp(b);

    registers.forEach((register, offset) => {
      if (register === 15) loadRegister(b, 15, b.add(base, num(b, offset * 4)), 4, pc);
      else loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc);
    });
    writeSp(b, b.add(base, num(b, registers.length * 4)));

    return;
  }

  if ((instr & 0xfff7) === 0xb662) {
    b.writeState('primask', num(b, 0));

    return;
  }

  if ((instr & 0xfff7) === 0xb672) {
    b.writeState('primask', num(b, 1));

    return;
  }

  if ((instr & 0xff00) === 0xbe00) {
    halt(b, pc, 0x06);
  }
}
