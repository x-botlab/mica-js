import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import type { JitTranslateInput } from '@mica-js/sdk/device';
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
  shiftValue,
  signExtend,
  signExtendDynamic,
  signIsSet,
  subRaw,
  subtractWithCarry,
  syncIrqService,
  u32,
  writeLr,
  writeNz,
  writeReg,
  writeSp,
  readSp,
} from './ir';
import type { Body } from './ir';
import { conditional, loadRegister, readAnyReg, storeRegister, writeAnyReg } from './cpu';
import {
  atAddress,
  atCode,
  atMayService,
  atSram,
  CODE_MASK,
  gpioReadsAsZero,
  readMemory,
} from './memory';
import { halt } from './thumb16';
import type { KnownRegs } from './decode';

/** 32 位 Thumb-2 指令的子集；未覆盖的编码在 `decode32` 中报告故障。 */
export interface Instruction32 {
  readonly size: 4;
  readonly cycles: number;
  readonly mayService: boolean;
  readonly emit: (b: Body, pc: number) => void;
}

type CodeBytes = JitTranslateInput['code'];

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

const known = (regs: KnownRegs | undefined, index: number): number | undefined =>
  regs?.[index & 0xf];

const remember = (regs: KnownRegs | undefined, index: number, value: number | undefined): void => {
  if (regs !== undefined) regs[index & 0xf] = value === undefined ? undefined : value >>> 0;
};

const readConstant = (at: ReturnType<typeof atAddress> | undefined): number | undefined =>
  at?.address !== undefined && gpioReadsAsZero(at.address) ? 0 : undefined;

const shiftNumber = (value: number, amount: number, type: number): number => {
  const count = amount & 0xff;

  if (type === 0) return (value << count) >>> 0;
  if (type === 1) return value >>> count;
  if (type === 2) return (value >> count) >>> 0;

  return count === 0 ? value >>> 0 : ((value >>> count) | (value << (32 - count))) >>> 0;
};

const firmwareValue = (
  code: CodeBytes | undefined,
  address: number,
  size: number,
  firmwareLength: number,
  signed: boolean,
): number | undefined => {
  if (code === undefined) return undefined;

  const offset = (address >>> 0) & CODE_MASK;

  if (offset + size > Math.min(firmwareLength, code.byteLength)) return undefined;

  let value = 0;
  for (let index = 0; index < size; index += 1) value |= (code[offset + index] ?? 0) << (index * 8);

  if (!signed) return value >>> 0;

  const shift = 32 - size * 8;

  return (value << shift) >> shift;
};

const isBranch32 = (h1: number, h2: number): boolean =>
  (h1 & 0xf800) === 0xf000 &&
  ((h2 & 0xd000) === 0xd000 ||
    (h2 & 0xd000) === 0xc000 ||
    (h2 & 0xd000) === 0x9000 ||
    (h2 & 0xd000) === 0x8000);

const immediateAt = (
  regs: KnownRegs | undefined,
  rn: number,
  pc: number,
  offset: number,
  alignedPc = false,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 15) return atCode((((alignedPc ? (pc + 4) & ~3 : pc + 4) + offset) & CODE_MASK) >>> 0);
  if (rn === 13) return atSram();

  const base = known(regs, rn);

  return base === undefined ? undefined : atAddress((base + offset) >>> 0);
};

const registerAt = (
  regs: KnownRegs | undefined,
  rn: number,
  rm: number,
  pc: number,
  shift: number,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 13) return atSram();

  const index = known(regs, rm);
  if (rn === 15) {
    return index === undefined
      ? atCode()
      : atAddress((((pc + 4) >>> 0) + ((index << shift) >>> 0)) >>> 0);
  }

  const base = known(regs, rn);

  return base === undefined || index === undefined
    ? undefined
    : atAddress((base + ((index << shift) >>> 0)) >>> 0);
};

const multipleAt = (
  regs: KnownRegs | undefined,
  rn: number,
  offset: number,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 13) return atSram();
  if (rn === 15) return atCode();

  const base = known(regs, rn);

  return base === undefined ? undefined : atAddress((base + offset) >>> 0);
};

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

function updateConstants32(
  h1: number,
  h2: number,
  pc: number,
  code: CodeBytes | undefined,
  firmwareLength: number,
  regs: KnownRegs | undefined,
  snapshot: KnownRegs | undefined,
): void {
  if (regs === undefined) return;

  const any = (index: number): number | undefined =>
    index === 15 ? (pc + 4) >>> 0 : known(snapshot, index);

  if (isBranch32(h1, h2)) {
    if ((h2 & 0xd000) === 0xd000 || (h2 & 0xd000) === 0xc000) remember(regs, 14, undefined);

    return;
  }

  if ((h1 & 0xfbe0) === 0xf200 || (h1 & 0xfbe0) === 0xf2a0) {
    const sub = (h1 & 0x0080) !== 0;
    const left = any(h1 & 0xf);
    const rd = (h2 >> 8) & 0xf;
    const imm = (((h1 >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 0xff);

    remember(regs, rd, left === undefined ? undefined : sub ? left - imm : left + imm);

    return;
  }

  if ((h1 & 0xfbf0) === 0xf240 || (h1 & 0xfbf0) === 0xf2c0) {
    const rd = (h2 >> 8) & 0xf;
    const imm =
      (((h1 & 0xf) << 12) | (((h1 >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 0xff)) >>> 0;

    if ((h1 & 0x0080) === 0) remember(regs, rd, imm);
    else {
      const current = known(snapshot, rd);

      remember(regs, rd, current === undefined ? undefined : (current & 0xffff) | (imm << 16));
    }

    return;
  }

  if ((h1 & 0xfa00) === 0xf000 && (h1 & 0x0200) === 0) {
    const op = (h1 >> 5) & 0xf;
    const rd = (h2 >> 8) & 0xf;
    const immediate = thumbExpandImm(
      (((h1 >> 10) & 1) << 11) | (((h2 >> 12) & 7) << 8) | (h2 & 0xff),
    );
    const rn = h1 & 0xf;
    const left = any(h1 & 0xf);
    let value: number | undefined;

    if (left !== undefined) {
      if (rn === 15 && op === 2) value = immediate;
      else if (rn === 15 && op === 1) value = ~immediate;
      else if (op === 0) value = left & immediate;
      else if (op === 1) value = left & ~immediate;
      else if (op === 2) value = left | immediate;
      else if (op === 3) value = left | ~immediate;
      else if (op === 4) value = left ^ immediate;
      else if (op === 8) value = left + immediate;
      else if (op === 13) value = left - immediate;
      else if (op === 14) value = -immediate;
    }

    if (rd !== 15) remember(regs, rd, value);

    return;
  }

  if ((h1 & 0xfe00) === 0xea00) {
    const op = (h1 >> 5) & 0xf;
    const rn = h1 & 0xf;
    const rd = (h2 >> 8) & 0xf;
    const left = any(rn);
    const rightValue = any(h2 & 0xf);
    const right =
      rightValue === undefined
        ? undefined
        : shiftNumber(rightValue, (((h2 >> 12) & 7) << 2) | ((h2 >> 6) & 3), (h2 >> 4) & 3);
    let value: number | undefined;

    if (left !== undefined && right !== undefined) {
      if (rn === 15 && op === 2) value = right;
      else if (rn === 15 && op === 1) value = ~right;
      else if (op === 0) value = left & right;
      else if (op === 1) value = left & ~right;
      else if (op === 2) value = left | right;
      else if (op === 3) value = left | ~right;
      else if (op === 4) value = left ^ right;
      else if (op === 8) value = left + right;
      else if (op === 13) value = left - right;
      else if (op === 14) value = -right;
    }

    if (rd !== 15) remember(regs, rd, value);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3c0 || (h1 & 0xfff0) === 0xf340 || (h1 & 0xfff0) === 0xf360) {
    remember(regs, (h2 >> 8) & 0xf, undefined);
    return;
  }

  if ((h1 & 0xff80) === 0xfa00) {
    const source = known(snapshot, h1 & 0xf);
    const amount = known(snapshot, h2 & 0xf);

    remember(
      regs,
      (h2 >> 8) & 0xf,
      source === undefined || amount === undefined
        ? undefined
        : shiftNumber(source, amount, (h1 >> 5) & 3),
    );
    return;
  }

  if ((h1 & 0xfff0) === 0xfab0 || (h1 & 0xfff0) === 0xfa90) {
    remember(regs, (h2 >> 8) & 0xf, undefined);
    return;
  }

  if ((h1 & 0xfff0) === 0xfbb0 || (h1 & 0xfff0) === 0xfb90 || (h1 & 0xfff0) === 0xfb00) {
    remember(regs, (h2 >> 8) & 0xf, undefined);
    return;
  }

  if ((h1 & 0xfff0) === 0xf3e0) {
    const sysm = h2 & 0xff;

    remember(regs, (h2 >> 8) & 0xf, sysm === 0 || sysm === 16 ? undefined : 0);
    return;
  }

  if ((h1 & 0xfff0) === 0xf380) return;

  if (
    (h1 & 0xfff0) === 0xf8d0 ||
    (h1 & 0xfff0) === 0xf8c0 ||
    (h1 & 0xfff0) === 0xf890 ||
    (h1 & 0xfff0) === 0xf880 ||
    (h1 & 0xfff0) === 0xf8b0 ||
    (h1 & 0xfff0) === 0xf8a0
  ) {
    const kind = h1 & 0xfff0;
    const rn = h1 & 0xf;
    const rt = (h2 >> 12) & 0xf;
    const offset = h2 & 0xfff;
    const load = kind === 0xf8d0 || kind === 0xf890 || kind === 0xf8b0;
    const size =
      kind === 0xf890 || kind === 0xf880 ? 1 : kind === 0xf8b0 || kind === 0xf8a0 ? 2 : 4;

    if (load) {
      const at = immediateAt(snapshot, rn, pc, offset, true);
      const literal =
        rn === 15
          ? firmwareValue(code, (((pc + 4) & ~3) + offset) >>> 0, size, firmwareLength, false)
          : undefined;

      remember(regs, rt, literal ?? readConstant(at));
    }
    return;
  }

  if ((h1 & 0xfff0) === 0xf990 || (h1 & 0xfff0) === 0xf9b0) {
    const rn = h1 & 0xf;
    const rt = (h2 >> 12) & 0xf;
    const offset = h2 & 0xfff;
    const size = (h1 & 0xfff0) === 0xf990 ? 1 : 2;
    const at = immediateAt(snapshot, rn, pc, offset, true);
    const literal =
      rn === 15
        ? firmwareValue(code, (((pc + 4) & ~3) + offset) >>> 0, size, firmwareLength, true)
        : undefined;

    remember(regs, rt, literal ?? readConstant(at));
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
    const kind = h1 & 0xfff0;

    if (kind === 0xf850 || kind === 0xf810 || kind === 0xf830) {
      const at = registerAt(snapshot, h1 & 0xf, h2 & 0xf, pc, (h2 >> 4) & 3);

      remember(regs, (h2 >> 12) & 0xf, readConstant(at));
    }
    return;
  }

  if (h1 === 0xe92d || h1 === 0xe8bd) {
    if (h1 === 0xe8bd) {
      for (let register = 0; register < 15; register += 1)
        if ((h2 & (1 << register)) !== 0) remember(regs, register, undefined);
    }
    remember(regs, 13, undefined);
    return;
  }

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) {
    const load = (h1 & 0xffd0) === 0xe890;
    const writeBack = (h1 & 0x20) !== 0;
    const rn = h1 & 0xf;

    if (load) {
      for (let register = 0; register < 15; register += 1)
        if ((h2 & (1 << register)) !== 0) remember(regs, register, undefined);
    }
    if (writeBack && (!load || (h2 & (1 << rn)) === 0)) remember(regs, rn, undefined);
    return;
  }

  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) return;

  if ((h1 & 0xff40) === 0xe940) {
    if ((h1 & 0x20) !== 0) {
      remember(regs, (h2 >> 12) & 0xf, undefined);
      remember(regs, (h2 >> 8) & 0xf, undefined);
    }
    if ((h1 & 0x10) !== 0) remember(regs, h1 & 0xf, undefined);
    return;
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840) {
    if ((h1 & 0xfff0) === 0xe850) remember(regs, (h2 >> 12) & 0xf, undefined);
    else remember(regs, (h2 >> 8) & 0xf, 0);
    return;
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return;
  if (h1 === 0xf3af && h2 === 0x8000) return;

  regs.fill(undefined);
}

function mayService32(h1: number, h2: number, pc: number, regs: KnownRegs | undefined): boolean {
  const pure =
    isBranch32(h1, h2) ||
    (h1 & 0xfbe0) === 0xf200 ||
    (h1 & 0xfbe0) === 0xf2a0 ||
    (h1 & 0xfbf0) === 0xf240 ||
    (h1 & 0xfbf0) === 0xf2c0 ||
    ((h1 & 0xfa00) === 0xf000 && (h1 & 0x0200) === 0) ||
    (h1 & 0xfe00) === 0xea00 ||
    (h1 & 0xfff0) === 0xf3c0 ||
    (h1 & 0xfff0) === 0xf340 ||
    (h1 & 0xfff0) === 0xf360 ||
    (h1 & 0xff80) === 0xfa00 ||
    (h1 & 0xfff0) === 0xfab0 ||
    (h1 & 0xfff0) === 0xfa90 ||
    (h1 & 0xfff0) === 0xfbb0 ||
    (h1 & 0xfff0) === 0xfb90 ||
    (h1 & 0xfff0) === 0xfb00 ||
    (h1 & 0xfff0) === 0xf3e0;

  if (pure) return false;
  if ((h1 & 0xfff0) === 0xf380) return true;

  if (
    (h1 & 0xfff0) === 0xf8d0 ||
    (h1 & 0xfff0) === 0xf8c0 ||
    (h1 & 0xfff0) === 0xf890 ||
    (h1 & 0xfff0) === 0xf880 ||
    (h1 & 0xfff0) === 0xf8b0 ||
    (h1 & 0xfff0) === 0xf8a0 ||
    (h1 & 0xfff0) === 0xf990 ||
    (h1 & 0xfff0) === 0xf9b0
  )
    return atMayService(immediateAt(regs, h1 & 0xf, pc, h2 & 0xfff, true));

  if (
    (h1 & 0xfff0) === 0xf850 ||
    (h1 & 0xfff0) === 0xf840 ||
    (h1 & 0xfff0) === 0xf810 ||
    (h1 & 0xfff0) === 0xf800 ||
    (h1 & 0xfff0) === 0xf830 ||
    (h1 & 0xfff0) === 0xf820
  )
    return atMayService(registerAt(regs, h1 & 0xf, h2 & 0xf, pc, (h2 >> 4) & 3));

  if (h1 === 0xe92d || h1 === 0xe8bd) return false;

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) {
    if ((h2 & 0xffff) === 0) return false;
    for (let register = 0; register < 16; register += 1)
      if ((h2 & (1 << register)) !== 0 && atMayService(multipleAt(regs, h1 & 0xf, register * 4)))
        return true;
    return false;
  }

  if (h1 >= 0xe8d0 && h1 <= 0xe8d7)
    return atMayService(registerAt(regs, h1 & 0xf, h2 & 0xf, pc, 0));

  if ((h1 & 0xff40) === 0xe940) return atMayService(multipleAt(regs, h1 & 0xf, (h2 & 0xff) * 4));

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840)
    return atMayService(multipleAt(regs, h1 & 0xf, (h2 & 0xff) << 2));

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return false;
  if (h1 === 0xf3af && h2 === 0x8000) return false;

  // 未覆盖编码会 halt；保守进入完整守卫以截停后续指令。
  return true;
}

export function decode32(
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  pc = 0,
  code?: CodeBytes,
  firmwareLength = code?.byteLength ?? 0,
): Instruction32 {
  const snapshot = knownRegs?.slice();

  updateConstants32(h1, h2, pc, code, firmwareLength, knownRegs, snapshot);

  return {
    size: 4,
    cycles: 2,
    mayService: mayService32(h1, h2, pc, snapshot),
    emit: (b, currentPc) => emit32(b, currentPc, h1, h2, snapshot, code, firmwareLength),
  };
}

function emit32(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
): void {
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

  if ((h1 & 0xff80) === 0xfa00) {
    // LSL/LSR/ASR/ROR (register)：`lsl.w r6, r5, r3` / `lsrs.w r6, r2, r3`。
    // 编码是 `1111 1010 0<op2> S Rn | 1111 Rd 0000 Rm`：
    // - h1 的 bit6..5 选移位类型（00 LSL、01 LSR、10 ASR、11 ROR）；
    // - **Rn（h1 的低 4 位）是被移位的值，Rm（h2 的低 4 位）持有移位量**。
    const rd = (h2 >> 8) & 0xf;
    const value = readReg(b, h1 & 0xf);
    const amount = b.bitAnd(readReg(b, h2 & 0xf), num(b, 0xff));
    const type = (h1 >> 5) & 3;

    writeReg(b, rd, shiftValue(b, value, amount, type));

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
    loadStoreImmediate(b, pc, h1, h2, knownRegs, code, firmwareLength);

    return;
  }

  if ((h1 & 0xfff0) === 0xf990 || (h1 & 0xfff0) === 0xf9b0) {
    loadStoreSigned(b, pc, h1, h2, knownRegs, code, firmwareLength);

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
    loadStoreRegister(b, pc, h1, h2, knownRegs);

    return;
  }

  if (h1 === 0xe92d || h1 === 0xe8bd) {
    pushPopWide(b, pc, h1, h2);

    return;
  }

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) {
    loadStoreMultiple(b, pc, h1, h2, knownRegs);

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
    tableBranch(b, pc, h1, h2, knownRegs);

    return;
  }

  if ((h1 & 0xff40) === 0xe940) {
    // LDRD/STRD (immediate, pre-indexed)：`strd r0, r1, [sp, #36]` 一类。
    // bit5 选 load，bit4 是写回，bit7 选加/减，offset 以 4 字节为单位。
    dualLoadStore(b, pc, h1, h2, knownRegs);

    return;
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840) {
    exclusiveAccess(b, pc, h1, h2, knownRegs);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return;
  if (h1 === 0xf3af && h2 === 0x8000) return;

  halt(b, pc, 0x10);
}

function loadStoreImmediate(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  const load = kind === 0xf8d0 || kind === 0xf890 || kind === 0xf8b0;
  const size = kind === 0xf890 || kind === 0xf880 ? 1 : kind === 0xf8b0 || kind === 0xf8a0 ? 2 : 4;
  const literal =
    load && rn === 15 && rt !== 15
      ? firmwareValue(code, (((pc + 4) & ~3) + imm12) >>> 0, size, firmwareLength, false)
      : undefined;

  if (literal !== undefined) {
    writeAnyReg(b, rt, num(b, literal));
    return;
  }

  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));
  const at = immediateAt(knownRegs, rn, pc, imm12, true);

  if (load) loadRegister(b, rt, address, size, pc, false, at, rn !== 15 && rn !== 13);
  else storeRegister(b, rt, address, size, pc, at, rn !== 15 && rn !== 13);
}

function loadStoreSigned(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
): void {
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  const size = (h1 & 0xfff0) === 0xf990 ? 1 : 2;
  const literal =
    rn === 15 && rt !== 15
      ? firmwareValue(code, (((pc + 4) & ~3) + imm12) >>> 0, size, firmwareLength, true)
      : undefined;

  if (literal !== undefined) {
    writeAnyReg(b, rt, num(b, literal));
    return;
  }

  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));
  const at = immediateAt(knownRegs, rn, pc, imm12, true);

  loadRegister(b, rt, address, size, pc, true, at, rn !== 15 && rn !== 13);
}

function loadStoreRegister(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const rm = h2 & 0xf;
  const shift = (h2 >> 4) & 3;
  const address = b.add(readAnyReg(b, rn, pc), b.shiftLeft(readAnyReg(b, rm, pc), num(b, shift)));
  const load = kind === 0xf850 || kind === 0xf810 || kind === 0xf830;
  const size = kind === 0xf810 || kind === 0xf800 ? 1 : kind === 0xf830 || kind === 0xf820 ? 2 : 4;
  const at = registerAt(knownRegs, rn, rm, pc, shift);

  if (load) loadRegister(b, rt, address, size, pc, false, at, rn !== 13 && rn !== 15);
  else storeRegister(b, rt, address, size, pc, at, rn !== 13 && rn !== 15);
}

function pushPopWide(b: Body, pc: number, h1: number, h2: number): void {
  const list = h2 & 0xffff;
  const registers: number[] = [];

  for (let index = 0; index < 16; index += 1) if (list & (1 << index)) registers.push(index);

  if (h1 === 0xe92d) {
    const base = b.subtract(readSp(b), num(b, registers.length * 4));

    registers.forEach((register, offset) =>
      storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, atSram()),
    );
    writeSp(b, base);
  } else {
    const base = readSp(b);

    registers.forEach((register, offset) =>
      loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, false, atSram()),
    );
    writeSp(b, b.add(base, num(b, registers.length * 4)));
  }
}

function loadStoreMultiple(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
): void {
  const load = (h1 & 0xffd0) === 0xe890;
  // W 位（bit5）决定是否写回基址。LDM/STM 的 W=0 形式非常常见
  // （`ldmia.w r4, {r0,r1,r2}` 不写回），无条件写回会让后续地址全部错位。
  const writeBack = (h1 & 0x20) !== 0;
  const rn = h1 & 0xf;
  const list = h2 & 0xffff;
  const registers: number[] = [];

  for (let index = 0; index < 16; index += 1) if (list & (1 << index)) registers.push(index);
  const base = readAnyReg(b, rn, pc);
  registers.forEach((register, offset) => {
    const address = b.add(base, num(b, offset * 4));
    const at = multipleAt(knownRegs, rn, offset * 4);

    if (load) loadRegister(b, register, address, 4, pc, false, at, true);
    else storeRegister(b, register, address, 4, pc, at);
  });

  if (writeBack && !(load && registers.includes(rn)))
    writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
}

/** `ldrd`/`strd` 立即数寻址（前索引，可选写回）。 */
function dualLoadStore(b: Body, pc: number, h1: number, h2: number, knownRegs?: KnownRegs): void {
  const load = (h1 & 0x20) !== 0;
  const writeBack = (h1 & 0x10) !== 0;
  const add = (h1 & 0x80) !== 0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const rt2 = (h2 >> 8) & 0xf;
  const offset = (h2 & 0xff) * 4;
  const base = readAnyReg(b, rn, pc);
  const address = add ? b.add(base, num(b, offset)) : b.subtract(base, num(b, offset));
  const second = b.add(address, num(b, 4));
  const firstAt = multipleAt(knownRegs, rn, add ? offset : -offset);
  const secondAt = multipleAt(knownRegs, rn, add ? offset + 4 : -offset + 4);

  if (load) {
    loadRegister(b, rt, address, 4, pc, false, firstAt, true);
    loadRegister(b, rt2, second, 4, pc, false, secondAt, true);
  } else {
    storeRegister(b, rt, address, 4, pc, firstAt);
    storeRegister(b, rt2, second, 4, pc, secondAt);
  }
  if (writeBack) writeAnyReg(b, rn, address);
}

function tableBranch(b: Body, pc: number, h1: number, h2: number, knownRegs?: KnownRegs): void {
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const half = (h2 & 0x10) !== 0;
  const indexAddress = b.add(readReg(b, rn), readAnyReg(b, rm, pc));
  const at = registerAt(knownRegs, rn, rm, pc, 0);
  const raw = readMemory(b, indexAddress, half ? 2 : 1, undefined, at);
  const target = b.add(num(b, (pc + 4) >>> 0), b.shiftLeft(raw, num(b, 1)));

  setPc(b, target);
}

function exclusiveAccess(b: Body, pc: number, h1: number, h2: number, knownRegs?: KnownRegs): void {
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const address = b.add(readReg(b, rn), num(b, (h2 & 0xff) << 2));
  const at = multipleAt(knownRegs, rn, (h2 & 0xff) << 2);

  if ((h1 & 0xfff0) === 0xe850) {
    loadRegister(b, rt, address, 4, pc, false, at, rn !== 13);
  } else {
    const rd = (h2 >> 8) & 0xf;

    storeRegister(b, rt, address, 4, pc, at, rn !== 13);
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
    syncIrqService(b);
  }
}
