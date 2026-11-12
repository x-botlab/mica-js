import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { APSR_C } from './layout';
import {
  addRaw,
  addWithCarry,
  asBody,
  flag,
  isZero,
  maskWidth,
  num,
  readReg,
  setPc,
  setPcConst,
  shiftRaw,
  signExtend,
  signExtendDynamic,
  signIsSet,
  subRaw,
  subtractWithCarry,
  u32,
  writeLr,
  writeNz,
  writeReg,
  writeSp,
  readSp,
} from './ir';
import type { Body } from './ir';
import { conditional, loadRegister, readAnyReg, storeRegister, writeAnyReg } from './cpu';
import { readMemory } from './memory';
import { halt } from './thumb16';

/** 32 位 Thumb-2 指令的子集；未覆盖的编码在 `decode32` 中报告故障。 */
export interface Instruction32 {
  readonly size: 4;
  readonly cycles: number;
  readonly emit: (b: Body, pc: number) => void;
}

const signExtendBits = (value: number, bits: number): number => {
  const shift = 32 - bits;

  return (value << shift) >> shift;
};

/** ThumbExpandImm：把 12 位编码展开为 32 位立即数。 */
function thumbExpandImm(imm12: number): number {
  const top = (imm12 >> 10) & 3;
  const byte = imm12 & 0xff;

  if (top === 0) {
    switch ((imm12 >> 8) & 3) {
      case 0:
        return byte;
      case 1:
        return ((byte << 16) | byte) >>> 0;
      case 2:
        return ((byte << 24) | (byte << 8)) >>> 0;
      default:
        return ((byte << 24) | (byte << 16) | (byte << 8) | byte) >>> 0;
    }
  }

  const value = 0x80 | (imm12 & 0x7f);
  const rotation = (imm12 >> 7) & 0x1f;

  return rotation === 0 ? value >>> 0 : ((value >>> rotation) | (value << (32 - rotation))) >>> 0;
}

function writeData(b: Body, rd: number, value: Value<number>, setFlags: boolean): void {
  if (setFlags) writeNz(b, signIsSet(b, value), isZero(b, value));
  writeAnyReg(b, rd, value);
}

function logicOperation(
  b: Body,
  op: number,
  left: Value<number>,
  right: Value<number>,
  rd: number,
  setFlags: boolean,
): void {
  let value: Value<number>;

  switch (op) {
    case 0:
      value = b.bitAnd(left, right);
      break;
    case 1:
      value = b.bitAnd(left, b.bitNot(right));
      break;
    case 2:
      value = b.bitOr(left, right);
      break;
    case 3:
      value = b.bitOr(left, b.bitNot(right));
      break;
    default:
      value = b.bitXor(left, right);
  }

  writeData(b, rd, value, setFlags);
}

function arithmeticOperation(
  b: Body,
  op: number,
  left: Value<number>,
  right: Value<number>,
  rd: number,
  setFlags: boolean,
): void {
  const carry = flag(b, APSR_C);
  const carryIn = b.select(
    types.number,
    carry,
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.constant(types.number, 0),
  );
  const borrowIn = b.select(
    types.number,
    carry,
    (inner) => inner.constant(types.number, 0),
    (inner) => inner.constant(types.number, 1),
  );
  let value: Value<number>;

  if (op === 8)
    value = setFlags ? addWithCarry(b, left, right, num(b, 0)) : addRaw(b, left, right, num(b, 0));
  else if (op === 10)
    value = setFlags ? addWithCarry(b, left, right, carryIn) : addRaw(b, left, right, carryIn);
  else if (op === 11)
    value = setFlags
      ? subtractWithCarry(b, left, right, borrowIn)
      : subRaw(b, left, right, borrowIn);
  else if (op === 13)
    value = setFlags
      ? subtractWithCarry(b, left, right, num(b, 0))
      : subRaw(b, left, right, num(b, 0));
  else
    value = setFlags
      ? subtractWithCarry(b, num(b, 0), right, num(b, 0))
      : subRaw(b, num(b, 0), right, num(b, 0));

  if (rd === 15 && setFlags && (op === 8 || op === 13)) return;
  writeData(b, rd, value, setFlags);
}

function setFlagsOnly(b: Body, op: number, left: Value<number>, right: Value<number>): void {
  if (op === 0) {
    const value = b.bitAnd(left, right);

    writeNz(b, signIsSet(b, value), isZero(b, value));
  } else if (op === 4) {
    const value = b.bitXor(left, right);

    writeNz(b, signIsSet(b, value), isZero(b, value));
  } else if (op === 8) {
    addWithCarry(b, left, right, num(b, 0));
  } else {
    subtractWithCarry(b, left, right, num(b, 0));
  }
}

function dataProcessingRegister(b: Body, pc: number, h1: number, h2: number): void {
  const op = (h1 >> 5) & 0xf;
  const setFlags = (h1 & 0x10) !== 0;
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const rm = h2 & 0xf;
  const amount = (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3);
  const type = (h2 >> 4) & 3;
  const right = shiftRaw(b, readAnyReg(b, rm, pc), num(b, amount), type);
  const left = readAnyReg(b, rn, pc);

  if (rd === 15) {
    if (setFlags) setFlagsOnly(b, op, left, right);
    return;
  }

  if (op === 2 && rn === 15) {
    writeData(b, rd, right, setFlags);

    return;
  }

  if (op === 1 && rn === 15) {
    writeData(b, rd, b.bitNot(right), setFlags);

    return;
  }

  if (op === 0 || op === 1 || op === 2 || op === 3 || op === 4) {
    logicOperation(b, op, left, right, rd, setFlags);

    return;
  }

  arithmeticOperation(b, op, left, right, rd, setFlags);
}

function dataProcessingImmediate(b: Body, pc: number, h1: number, h2: number): void {
  const op = (h1 >> 5) & 0xf;
  const setFlags = (h1 & 0x10) !== 0;
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const i = (h1 >> 10) & 1;
  const imm3 = (h2 >> 12) & 7;
  const imm8 = h2 & 0xff;
  const immediate = (i << 11) | (imm3 << 8) | imm8;
  const right = num(b, thumbExpandImm(immediate));
  const left = readAnyReg(b, rn, pc);

  if (rd === 15) {
    if (setFlags) setFlagsOnly(b, op, left, right);
    return;
  }

  if (op === 2 && rn === 15) {
    writeData(b, rd, right, setFlags);

    return;
  }

  if (op === 1 && rn === 15) {
    writeData(b, rd, b.bitNot(right), setFlags);

    return;
  }

  if (op === 0 || op === 1 || op === 2 || op === 3 || op === 4) {
    logicOperation(b, op, left, right, rd, setFlags);

    return;
  }

  arithmeticOperation(b, op, left, right, rd, setFlags);
}

function branchAndMisc(b: Body, pc: number, h1: number, h2: number): boolean {
  const s = (h1 >> 10) & 1;
  const j1 = (h2 >> 13) & 1;
  const j2 = (h2 >> 11) & 1;
  const i1 = 1 - (j1 ^ s);
  const i2 = 1 - (j2 ^ s);

  if ((h2 & 0xd000) === 0xd000) {
    // BL
    const imm10 = h1 & 0x3ff;
    const imm11 = h2 & 0x7ff;
    const imm = signExtendBits(
      (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1),
      25,
    );
    const target = (pc + 4 + imm) >>> 0;

    writeLr(b, num(b, (pc + 4) | 1));
    setPcConst(b, target);

    return true;
  }

  if ((h2 & 0xd000) === 0xc000) {
    // BLX
    const imm10 = h1 & 0x3ff;
    const imm10l = h2 & 0x7fe;
    const imm = signExtendBits(
      (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm10l << 1),
      25,
    );
    const target = ((pc + 4) & ~3) + imm;

    writeLr(b, num(b, (pc + 4) | 1));
    setPcConst(b, target >>> 0);

    return true;
  }

  if ((h2 & 0xd000) === 0x9000) {
    // B.W
    const imm10 = h1 & 0x3ff;
    const imm11 = h2 & 0x7ff;
    const imm = signExtendBits(
      (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1),
      25,
    );

    setPcConst(b, (pc + 4 + imm) >>> 0);

    return true;
  }

  if ((h2 & 0xd000) === 0x8000) {
    // B<cond>.W
    const cond = (h1 >> 6) & 0xf;
    const imm6 = h1 & 0x3f;
    const imm11 = h2 & 0x7ff;
    const imm = signExtendBits(
      (s << 20) | (j2 << 19) | (j1 << 18) | (imm6 << 12) | (imm11 << 1),
      21,
    );
    const target = (pc + 4 + imm) >>> 0;

    conditional(b, cond, (body) => setPcConst(body, target));

    return true;
  }

  return false;
}

export function decode32(h1: number, h2: number): Instruction32 {
  return {
    size: 4,
    cycles: 2,
    emit: (b, pc) => emit32(b, pc, h1, h2),
  };
}

function emit32(b: Body, pc: number, h1: number, h2: number): void {
  if ((h1 & 0xf800) === 0xf000 && branchAndMisc(b, pc, h1, h2)) return;

  if ((h1 & 0xfbe0) === 0xf200 || (h1 & 0xfbe0) === 0xf2a0) {
    // ADDW / SUBW (含 ADR.W 的 ADDW PC 形式)
    const sub = (h1 & 0x0080) !== 0;
    const rn = h1 & 0xf;
    const rd = (h2 >> 8) & 0xf;
    const i = (h1 >> 10) & 1;
    const imm3 = (h2 >> 12) & 7;
    const imm8 = h2 & 0xff;
    const imm = (i << 11) | (imm3 << 8) | imm8;
    const left = readAnyReg(b, rn, pc);
    const value = sub
      ? subRaw(b, left, num(b, imm), num(b, 0))
      : addRaw(b, left, num(b, imm), num(b, 0));

    writeAnyReg(b, rd, value);

    return;
  }

  if ((h1 & 0xfbf0) === 0xf240 || (h1 & 0xfbf0) === 0xf2c0) {
    // MOVW / MOVT
    const top = (h1 & 0x0080) !== 0;
    const rd = (h2 >> 8) & 0xf;
    const imm4 = h1 & 0xf;
    const i = (h1 >> 10) & 1;
    const imm3 = (h2 >> 12) & 7;
    const imm8 = h2 & 0xff;
    const immediate = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8;

    if (top) {
      const current = readReg(b, rd);
      const value = b.bitOr(
        b.bitAnd(current, num(b, 0xffff)),
        b.shiftLeft(num(b, immediate), num(b, 16)),
      );

      writeReg(b, rd, value);
    } else writeReg(b, rd, num(b, immediate));

    return;
  }

  if ((h1 & 0xfa00) === 0xf000 && (h1 & 0x0200) === 0) {
    dataProcessingImmediate(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfe00) === 0xea00) {
    dataProcessingRegister(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3c0 || (h1 & 0xfff0) === 0xf340 || (h1 & 0xfff0) === 0xf360) {
    bitfieldOperation(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xfab0) {
    const rm = h2 & 0xf;
    const rd = (h2 >> 8) & 0xf;

    writeReg(b, rd, countLeadingZeros(b, readReg(b, rm)));

    return;
  }

  if ((h1 & 0xfff0) === 0xfa90) {
    const op = (h2 >> 4) & 0xf;
    const rm = h2 & 0xf;
    const rd = (h2 >> 8) & 0xf;
    const source = readReg(b, rm);
    const value =
      op === 0x8
        ? reverseBytes(b, source, 4)
        : op === 0x9
          ? reverseBytes(b, source, 2)
          : op === 0xa
            ? reverseBits(b, source)
            : signExtend(b, reverseBytes(b, source, 2), 16);

    writeReg(b, rd, value);

    return;
  }

  if ((h1 & 0xfff0) === 0xfbb0 || (h1 & 0xfff0) === 0xfb90) {
    divideOperation(b, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xfb00) {
    multiplyAccumulate(b, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3e0) {
    moveFromSpecial(b, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf380) {
    moveToSpecial(b, h2);

    return;
  }

  if (
    (h1 & 0xfff0) === 0xf8d0 ||
    (h1 & 0xfff0) === 0xf8c0 ||
    (h1 & 0xfff0) === 0xf890 ||
    (h1 & 0xfff0) === 0xf880 ||
    (h1 & 0xfff0) === 0xf8b0 ||
    (h1 & 0xfff0) === 0xf8a0
  ) {
    loadStoreImmediate(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf990 || (h1 & 0xfff0) === 0xf9b0) {
    loadStoreSigned(b, pc, h1, h2);

    return;
  }

  if (
    (h1 & 0xfff0) === 0xf850 ||
    (h1 & 0xfff0) === 0xf840 ||
    (h1 & 0xfff0) === 0xf810 ||
    (h1 & 0xfff0) === 0xf800 ||
    (h1 & 0xfff0) === 0xf830 ||
    (h1 & 0xfff0) === 0xf820
  ) {
    loadStoreRegister(b, pc, h1, h2);

    return;
  }

  if (h1 === 0xe92d || h1 === 0xe8bd) {
    pushPopWide(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) {
    loadStoreMultiple(b, pc, h1, h2);

    return;
  }

  if (
    h1 === 0xe8d0 ||
    h1 === 0xe8d1 ||
    h1 === 0xe8d2 ||
    h1 === 0xe8d3 ||
    h1 === 0xe8d4 ||
    h1 === 0xe8d5 ||
    h1 === 0xe8d6 ||
    h1 === 0xe8d7
  ) {
    tableBranch(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840) {
    exclusiveAccess(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return;
  if (h1 === 0xf3af && h2 === 0x8000) return;

  halt(b, pc, 0x10);
}

function loadStoreImmediate(b: Body, pc: number, h1: number, h2: number): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  const load = kind === 0xf8d0 || kind === 0xf890 || kind === 0xf8b0;
  const size = kind === 0xf890 || kind === 0xf880 ? 1 : kind === 0xf8b0 || kind === 0xf8a0 ? 2 : 4;
  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));

  if (load) loadRegister(b, rt, address, size, pc);
  else storeRegister(b, rt, address, size, pc);
}

function loadStoreSigned(b: Body, pc: number, h1: number, h2: number): void {
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  const size = (h1 & 0xfff0) === 0xf990 ? 1 : 2;
  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));

  loadRegister(b, rt, address, size, pc, true);
}

function loadStoreRegister(b: Body, pc: number, h1: number, h2: number): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const rm = h2 & 0xf;
  const shift = (h2 >> 4) & 3;
  const address = b.add(readAnyReg(b, rn, pc), b.shiftLeft(readAnyReg(b, rm, pc), num(b, shift)));
  const load = kind === 0xf850 || kind === 0xf810 || kind === 0xf830;
  const size = kind === 0xf810 || kind === 0xf800 ? 1 : kind === 0xf830 || kind === 0xf820 ? 2 : 4;

  if (load) loadRegister(b, rt, address, size, pc);
  else storeRegister(b, rt, address, size, pc);
}

function pushPopWide(b: Body, pc: number, h1: number, h2: number): void {
  const list = h2 & 0xffff;
  const registers: number[] = [];

  for (let index = 0; index < 16; index += 1) if (list & (1 << index)) registers.push(index);

  if (h1 === 0xe92d) {
    const base = b.subtract(readSp(b), num(b, registers.length * 4));

    registers.forEach((register, offset) =>
      storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc),
    );
    writeSp(b, base);
  } else {
    const base = readSp(b);

    registers.forEach((register, offset) =>
      loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc),
    );
    writeSp(b, b.add(base, num(b, registers.length * 4)));
  }
}

function loadStoreMultiple(b: Body, pc: number, h1: number, h2: number): void {
  const load = (h1 & 0xffd0) === 0xe890;
  const rn = h1 & 0xf;
  const list = h2 & 0xffff;
  const registers: number[] = [];

  for (let index = 0; index < 16; index += 1) if (list & (1 << index)) registers.push(index);
  const base = readAnyReg(b, rn, pc);

  registers.forEach((register, offset) => {
    const address = b.add(base, num(b, offset * 4));

    if (load) loadRegister(b, register, address, 4, pc);
    else storeRegister(b, register, address, 4, pc);
  });

  if (!load || !registers.includes(rn)) writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
}

function tableBranch(b: Body, pc: number, h1: number, h2: number): void {
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const half = (h2 & 0x10) !== 0;
  const indexAddress = b.add(readReg(b, rn), readAnyReg(b, rm, pc));
  const raw = readMemory(b, indexAddress, half ? 2 : 1);
  const target = b.add(num(b, (pc + 4) >>> 0), b.shiftLeft(raw, num(b, 1)));

  setPc(b, target);
}

function exclusiveAccess(b: Body, pc: number, h1: number, h2: number): void {
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const address = b.add(readReg(b, rn), num(b, (h2 & 0xff) << 2));

  if ((h1 & 0xfff0) === 0xe850) {
    loadRegister(b, rt, address, 4, pc);
  } else {
    const rd = (h2 >> 8) & 0xf;

    storeRegister(b, rt, address, 4, pc);
    writeReg(b, rd, num(b, 0));
  }
}

function bitfieldOperation(b: Body, pc: number, h1: number, h2: number): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const imm3 = (h2 >> 12) & 7;
  const imm2 = (h2 >> 6) & 3;
  const lsb = (imm3 << 2) | imm2;
  const width = (h2 & 0x1f) + 1;
  const source = readReg(b, rn);
  const mask = maskWidth(b, num(b, width));
  const shifted = b.shiftRightUnsigned(source, num(b, lsb));
  const extracted = b.bitAnd(shifted, mask);

  if (kind === 0xf3c0) {
    writeReg(b, rd, extracted);
  } else if (kind === 0xf340) {
    writeReg(b, rd, signExtendDynamic(b, extracted, num(b, width)));
  } else {
    const current = readReg(b, rd);
    const placed = b.shiftLeft(b.bitAnd(source, mask), num(b, lsb));
    const cleared = b.bitAnd(current, b.bitNot(b.shiftLeft(mask, num(b, lsb))));

    writeReg(b, rd, rn === 15 ? cleared : b.bitOr(cleared, placed));
  }
}

function countLeadingZeros(b: Body, value: Value<number>): Value<number> {
  const count = b.local(types.number, 0);
  const working = b.local(types.number, u32(b, value));

  for (const shift of [16, 8, 4, 2, 1]) {
    const high = b.shiftRightUnsigned(b.getLocal(working), num(b, 32 - shift));
    const empty = b.equal(types.number, high, num(b, 0));

    b.if(empty, (inner) => {
      const body = asBody(inner);

      body.setLocal(count, body.add(body.getLocal(count), body.constant(types.number, shift)));
      body.setLocal(
        working,
        body.shiftLeft(body.getLocal(working), body.constant(types.number, shift)),
      );
    });
  }

  return b.getLocal(count);
}

function reverseBytes(b: Body, value: Value<number>, width: number): Value<number> {
  const v = u32(b, value);

  if (width === 2) {
    return b.bitOr(
      b.shiftLeft(b.bitAnd(v, num(b, 0x00ff00ff)), num(b, 8)),
      b.shiftRightUnsigned(b.bitAnd(v, num(b, 0xff00ff00)), num(b, 8)),
    );
  }

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

function reverseBits(b: Body, value: Value<number>): Value<number> {
  const result = b.local(types.number, 0);
  const source = b.local(types.number, u32(b, value));

  for (let index = 0; index < 32; index += 1) {
    const bit = b.bitAnd(b.getLocal(source), num(b, 1));

    b.setLocal(result, b.bitOr(b.shiftLeft(b.getLocal(result), num(b, 1)), bit));
    b.setLocal(source, b.shiftRightUnsigned(b.getLocal(source), num(b, 1)));
  }

  return b.getLocal(result);
}

function divideOperation(b: Body, h1: number, h2: number): void {
  const signed = (h1 & 0xfff0) === 0xfb90;
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const rm = h2 & 0xf;
  const denominator = readReg(b, rm);
  const numerator = readReg(b, rn);
  const zero = b.equal(types.number, u32(b, denominator), num(b, 0));
  const result = signed
    ? b.trunc(b.divide(b.bitOr(numerator, num(b, 0)), b.bitOr(denominator, num(b, 0))))
    : b.floor(b.divide(u32(b, numerator), u32(b, denominator)));
  const normalized = u32(b, result);

  writeReg(
    b,
    rd,
    b.select(
      types.number,
      zero,
      (inner) => inner.constant(types.number, 0),
      () => normalized,
    ),
  );
}

function multiplyAccumulate(b: Body, h1: number, h2: number): void {
  const rn = h1 & 0xf;
  const ra = (h2 >> 12) & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const rm = h2 & 0xf;
  const value = u32(b, b.subtract(readReg(b, ra), b.multiply(readReg(b, rn), readReg(b, rm))));

  writeReg(b, rd, value);
}

function moveFromSpecial(b: Body, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const sysm = h2 & 0xff;

  if (sysm === 0) {
    writeReg(b, rd, b.bitAnd(b.readState('apsr', types.number), num(b, 0xf8000000)));
  } else if (sysm === 16) {
    writeReg(b, rd, b.readState('primask', types.number));
  } else {
    writeReg(b, rd, num(b, 0));
  }
}

function moveToSpecial(b: Body, h2: number): void {
  const rn = h2 & 0xf;
  const sysm = h2 & 0xff;

  if (sysm === 16) {
    b.writeState('primask', b.bitAnd(readReg(b, rn), num(b, 1)));
  }
}
