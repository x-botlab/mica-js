import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { APSR_C } from './layout';
import type { AccessSize } from './layout';
import type { CodeBytes } from './decode';
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
  syncIrqService,
  u32,
  u8,
  writeNz,
  writeReg,
  writeSp,
  readSp,
} from './ir';
import type { Body } from './ir';
import { conditional, loadRegister, readAnyReg, storeRegister, writeAnyReg } from './cpu';
import { atAddress, atAccessEffects, atSram, gpioReadsAsZero } from './memory';
import { codeLocalOffset } from './code-region';
import type { CodeRegion } from './code-region';
import type { AccessEffects } from './memory';
import {
  enterSvc,
  exceptionReturn,
  isExceptionReturn,
  writeFaultmask,
  writePrimask,
} from './nvic';
import { multiplyLow32 } from './dsp';
import { clearExclusiveMonitor } from './exclusive';
import type { KnownRegs } from './decode';

export interface Instruction16 {
  readonly size: 2;
  readonly cycles: number;
  readonly mayService: boolean;
  readonly dynamicMemory?: boolean;
  /** 静态 GPIO 输出写之后必须收块，使电气边界看到脉冲。 */
  readonly boundaryAfter?: boolean;
  /** 译码器确认该编码无法执行（会 halt），批处理/事实扫描必须就此停下。 */
  readonly terminates?: boolean;
  readonly emit: (b: Body, pc: number) => void;
}


const signed8 = (value: number): number => (value & 0x80 ? value - 0x100 : value);
const signed11 = (value: number): number => (value & 0x400 ? value - 0x800 : value);

const addFlags = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  addWithCarry(b, left, right, num(b, 0));

const subFlags = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  subtractWithCarry(b, left, right, num(b, 0));

const known = (regs: KnownRegs | undefined, index: number): number | undefined =>
  regs?.[index & 0xf];

const knownValue = known;

const remember = (regs: KnownRegs | undefined, index: number, value: number | undefined): void => {
  if (regs !== undefined) regs[index & 0xf] = value === undefined ? undefined : value >>> 0;
};

const staticAddress = (base: number | undefined, offset: number, value?: number) =>
  base === undefined ? undefined : atAddress((base + offset) >>> 0, value);

const shiftNumber = (value: number, amount: number, type: number): number => {
  const count = amount & 0xff;

  if (type === 0) return (value << count) >>> 0;
  if (type === 1) return value >>> count;
  if (type === 2) return (value >> count) >>> 0;

  return count === 0 ? value >>> 0 : ((value >>> count) | (value << (32 - count))) >>> 0;
};

const literalValue16 = (
  code: CodeBytes | undefined,
  pc: number,
  instr: number,
  firmwareLength: number,
  region?: CodeRegion,
): number | undefined => {
  if (code === undefined) return undefined;

  const address = (((pc + 4) & ~3) + ((instr & 0xff) << 2)) >>> 0;
  const offset = codeLocalOffset(region, address);

  if (offset === undefined || offset + 4 > Math.min(firmwareLength, code.byteLength)) return undefined;

  return (
    ((code[offset] ?? 0) |
      ((code[offset + 1] ?? 0) << 8) |
      ((code[offset + 2] ?? 0) << 16) |
      ((code[offset + 3] ?? 0) << 24)) >>>
    0
  );
};

const readConstant = (at: ReturnType<typeof atAddress> | undefined): number | undefined =>
  at?.address !== undefined && gpioReadsAsZero(at.address) ? 0 : undefined;

const immediateAt16 = (
  regs: KnownRegs | undefined,
  rn: number,
  offset: number,
  value?: number,
): ReturnType<typeof atAddress> | undefined => staticAddress(known(regs, rn), offset, value);

const registerAt16 = (
  regs: KnownRegs | undefined,
  rn: number,
  rm: number,
  value?: number,
): ReturnType<typeof atAddress> | undefined => {
  const base = known(regs, rn);
  const index = known(regs, rm);

  return base === undefined || index === undefined
    ? undefined
    : atAddress((base + index) >>> 0, value);
};

const writeResult = (b: Body, index: number, value: Value<number>): void => {
  writeReg(b, index, value);
};

export function halt(b: Body, pc: number, code: number): void {
  // halt 后必须停在固定 PC。中央块在进入前已把 pc 写成 nextPC；这里写回
  // faulting pc，避免下一次翻译继续把后续字节/数据当代码。中央对已 halted 的
  // 缓存块还要在块入口把 pc 固定回 faultPc（见 halt guard 合同）。
  b.writeState('pc', num(b, pc));
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

  // REV16：每个半字内部交换字节，不交换半字本身。
  return b.bitOr(
    b.shiftLeft(b.bitAnd(v, num(b, 0x00ff00ff)), num(b, 8)),
    b.shiftRightUnsigned(b.bitAnd(v, num(b, 0xff00ff00)), num(b, 8)),
  );
}

function updateConstants16(
  instr: number,
  pc: number,
  code: CodeBytes | undefined,
  firmwareLength: number,
  regs: KnownRegs | undefined,
  snapshot: KnownRegs | undefined,
  region?: CodeRegion,
): void {
  if (regs === undefined) return;

  if (instr < 0x1800) {
    const op = (instr >> 11) & 3;
    const rm = (instr >> 3) & 7;
    const rd = instr & 7;
    const amount = (instr >> 6) & 0x1f;
    const source = known(snapshot, rm);

    if (op === 3) return;
    if (source === undefined) remember(regs, rd, undefined);
    else if (op === 0 && amount === 0) remember(regs, rd, source);
    else if (op === 0) remember(regs, rd, source << amount);
    else if (op === 1) remember(regs, rd, amount === 0 ? 0 : source >>> amount);
    else
      remember(regs, rd, amount === 0 ? (source & 0x80000000 ? 0xffffffff : 0) : source >> amount);

    return;
  }

  if (instr < 0x2000) {
    const immediate = (instr & 0x0400) !== 0;
    const sub = (instr & 0x0200) !== 0;
    const rn = (instr >> 3) & 7;
    const rd = instr & 7;
    const left = known(snapshot, rn);
    const right = immediate ? (instr >> 6) & 7 : known(snapshot, (instr >> 6) & 7);

    remember(
      regs,
      rd,
      left === undefined || right === undefined ? undefined : sub ? left - right : left + right,
    );

    return;
  }

  if (instr < 0x4000) {
    const op = (instr >> 11) & 3;
    const rd = (instr >> 8) & 7;
    const imm = instr & 0xff;
    const current = known(snapshot, rd);

    if (op === 0) remember(regs, rd, imm);
    else if (op === 1) return;
    else
      remember(
        regs,
        rd,
        current === undefined ? undefined : op === 2 ? current + imm : current - imm,
      );

    return;
  }

  if (instr < 0x4400) {
    const op = (instr >> 6) & 0xf;
    const rm = (instr >> 3) & 7;
    const rdn = instr & 7;
    const left = known(snapshot, rdn);
    const right = known(snapshot, rm);
    let result: number | undefined;

    if (left !== undefined && right !== undefined) {
      switch (op) {
        case 0:
          result = left & right;
          break;
        case 1:
          result = left ^ right;
          break;
        case 2:
        case 3:
        case 4:
        case 7:
          result = shiftNumber(left, right, op === 2 ? 0 : op === 3 ? 1 : op === 4 ? 2 : 3);
          break;
        case 9:
          result = -right;
          break;
        case 12:
          result = left | right;
          break;
        case 13:
          result = Math.imul(left, right);
          break;
        case 14:
          result = left & ~right;
          break;
        case 15:
          result = ~right;
          break;
      }
    }

    if (op !== 8 && op !== 10 && op !== 11) remember(regs, rdn, result);

    return;
  }

  if (instr < 0x4800) {
    const op = (instr >> 8) & 3;
    const rd = (instr & 7) | ((instr >> 4) & 8);
    const rm = (instr >> 3) & 0xf;
    const left = rd === 15 ? (pc + 4) >>> 0 : known(snapshot, rd);
    const right = rm === 15 ? (pc + 4) >>> 0 : known(snapshot, rm);

    if (op === 0)
      remember(regs, rd, left === undefined || right === undefined ? undefined : left + right);
    else if (op === 2) remember(regs, rd, right);
    else if (op === 3 && (instr & 0x80) !== 0) remember(regs, 14, undefined);

    return;
  }

  if (instr < 0x5000) {
    remember(regs, (instr >> 8) & 7, literalValue16(code, pc, instr, firmwareLength, region));

    return;
  }

  if (instr < 0x6000) {
    const op = (instr >> 9) & 7;
    const rm = (instr >> 6) & 7;
    const rn = (instr >> 3) & 7;

    if (op >= 3) remember(regs, instr & 7, readConstant(registerAt16(snapshot, rn, rm)));

    return;
  }

  if (instr < 0x9000) {
    const kind = (instr >> 12) & 0xf;
    const load = (instr & 0x0800) !== 0;
    const size = kind === 6 ? 4 : kind === 7 ? 1 : 2;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;

    if (load)
      remember(
        regs,
        rt,
        readConstant(immediateAt16(snapshot, rn, (((instr >> 6) & 0x1f) * size) >>> 0)),
      );

    return;
  }

  if (instr < 0xa000) {
    if ((instr & 0x0800) !== 0) remember(regs, (instr >> 8) & 7, undefined);

    return;
  }

  if (instr < 0xb000) {
    const rd = (instr >> 8) & 7;
    const imm = (instr & 0xff) << 2;

    if ((instr & 0x0800) !== 0) {
      const sp = known(snapshot, 13);

      remember(regs, rd, sp === undefined ? undefined : sp + imm);
    } else remember(regs, rd, (((pc + 4) & ~3) + imm) >>> 0);

    return;
  }

  if (instr < 0xc000) {
    if ((instr & 0xff00) === 0xb000) {
      const sp = known(snapshot, 13);
      const imm = (instr & 0x7f) << 2;

      remember(regs, 13, sp === undefined ? undefined : (instr & 0x80) !== 0 ? sp - imm : sp + imm);
    } else if ((instr & 0xff00) === 0xb200 || (instr & 0xff00) === 0xba00) {
      remember(regs, instr & 7, undefined);
    } else if ((instr & 0xfe00) === 0xb400) {
      remember(regs, 13, undefined);
    } else if ((instr & 0xfe00) === 0xbc00) {
      const list = instr & 0xff;

      for (let register = 0; register < 8; register += 1)
        if ((list & (1 << register)) !== 0) remember(regs, register, undefined);
      if ((instr & 0x0100) !== 0) remember(regs, 15, undefined);
      remember(regs, 13, undefined);
    }

    return;
  }

  if (instr < 0xd000) {
    const load = (instr & 0x0800) !== 0;
    const rn = (instr >> 8) & 7;
    const list = instr & 0xff;

    if (load) {
      for (let register = 0; register < 8; register += 1)
        if ((list & (1 << register)) !== 0) remember(regs, register, undefined);
    }
    if (!load || (list & (1 << rn)) === 0) remember(regs, rn, undefined);

    return;
  }

  if (instr >= 0xf000) regs.fill(undefined);
}

/**
 * 0xB0xx–0xBxxx 的已实现编码。其余编码必须 halt 并终止批次；不能像以前那样让
 * `emitMisc16` 末尾静默穿过（REV 曾因此整体失效，CPSID f 也被吞掉）。
 */
function supportedMisc16(instr: number): boolean {
  if ((instr & 0xff00) === 0xb000) return true; // ADD/SUB SP, #imm
  if ((instr & 0xf500) === 0xb100) return true; // CBZ/CBNZ
  if ((instr & 0xff00) === 0xb200) return true; // SXTH/SXTB/UXTH/UXTB
  if ((instr & 0xff00) === 0xba00) return true; // REV/REV16/REVSH
  if ((instr & 0xfe00) === 0xb400) return true; // PUSH
  if ((instr & 0xfe00) === 0xbc00) return true; // POP
  if ((instr & 0xffef) === 0xb662) return true; // CPSIE/CPSID i
  if ((instr & 0xffef) === 0xb661) return true; // CPSIE/CPSID f

  return false;
}

function mayService16(instr: number, regs: KnownRegs | undefined, effects: AccessEffects): boolean {
  if (instr < 0x5000) return false;
  if (instr < 0x6000) {
    const op = (instr >> 9) & 7;
    const rm = (instr >> 6) & 7;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;
    const load = op >= 3;
    const size: AccessSize = op === 0 || op === 4 ? 4 : op === 1 || op === 5 || op === 7 ? 2 : 1;
    const at = registerAt16(regs, rn, rm, load ? undefined : knownValue(regs, rt));

    return atAccessEffects(at, load ? 'read' : 'write', size, effects);
  }

  if (instr < 0x9000) {
    const kind = (instr >> 12) & 0xf;
    const load = (instr & 0x0800) !== 0;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;
    const size = kind === 6 ? 4 : kind === 7 ? 1 : 2;
    const at = immediateAt16(
      regs,
      rn,
      (((instr >> 6) & 0x1f) * size) >>> 0,
      load ? undefined : knownValue(regs, rt),
    );

    return atAccessEffects(at, load ? 'read' : 'write', size as AccessSize, effects);
  }

  if (instr < 0xc000)
    return (
      (instr & 0xffef) === 0xb662 ||
      (instr & 0xffef) === 0xb661 ||
      !supportedMisc16(instr)
    );

  if (instr < 0xd000) {
    const load = (instr & 0x0800) !== 0;
    const rn = (instr >> 8) & 7;
    const list = instr & 0xff;

    if (list === 0) return false;
    const base = known(regs, rn);

    if (base === undefined) return true;
    for (let register = 0; register < 8; register += 1)
      if (list & (1 << register)) {
        const at = atAddress(
          (base + register * 4) >>> 0,
          load ? undefined : knownValue(regs, register),
        );

        if (atAccessEffects(at, load ? 'read' : 'write', 4, effects)) return true;
      }

    return false;
  }

  return false;
}

/** 是否需要在指令块内发射完整的动态内存分派树。 */
function dynamicMemory16(instr: number, regs: KnownRegs | undefined): boolean {
  if (instr >= 0x5000 && instr < 0x6000) {
    const rn = (instr >> 3) & 7;
    const rm = (instr >> 6) & 7;

    return registerAt16(regs, rn, rm) === undefined;
  }

  if (instr >= 0x6000 && instr < 0x9000) {
    const kind = (instr >> 12) & 0xf;
    const rn = (instr >> 3) & 7;
    const size = kind === 6 ? 4 : kind === 7 ? 1 : 2;

    return immediateAt16(regs, rn, (((instr >> 6) & 0x1f) * size) >>> 0) === undefined;
  }

  if (instr >= 0xc000 && instr < 0xd000) {
    const rn = (instr >> 8) & 7;

    return (instr & 0xff) !== 0 && rn !== 13 && rn !== 15 && known(regs, rn) === undefined;
  }

  return false;
}

export function decode16(
  instr: number,
  knownRegs?: KnownRegs,
  pc = 0,
  code?: CodeBytes,
  firmwareLength = code?.byteLength ?? 0,
  region?: CodeRegion,
): Instruction16 {
  const snapshot = knownRegs?.slice();

  updateConstants16(instr, pc, code, firmwareLength, knownRegs, snapshot, region);

  const effects: AccessEffects = { boundaryAfter: false };

  return {
    size: 2,
    cycles: 1,
    mayService: mayService16(instr, snapshot, effects),
    dynamicMemory: dynamicMemory16(instr, snapshot),
    boundaryAfter: effects.boundaryAfter,
    ...(instr >= 0xb000 && instr < 0xc000 && !supportedMisc16(instr)
      ? { terminates: true }
      : {}),
    emit: (b, currentPc) => emit16(b, currentPc, instr, snapshot, code, firmwareLength, region),
  };
}

function emit16(
  b: Body,
  pc: number,
  instr: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
  region?: CodeRegion,
): void {
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
        const value = multiplyLow32(b, left, right);

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

      writeAnyReg(b, rd, u32(b, value), pc);
    } else if (op === 1) {
      const left = readAnyReg(b, rd, pc);
      const right = readAnyReg(b, rm, pc);

      subFlags(b, left, right);
    } else if (op === 2) {
      writeAnyReg(b, rd, readAnyReg(b, rm, pc), pc);
    } else {
      const target = readAnyReg(b, rm, pc);

      if (instr & 0x80) {
        writeReg(b, 14, num(b, (pc + 2) | 1));
        b.if(
          b.lessThan(u32(b, target), num(b, 0xffffffe0)),
          (normal) => {
            const body = asBody(normal);
            const low = body.bitAnd(target, body.constant(types.number, 1));

            body.if(
              body.equal(types.number, low, body.constant(types.number, 0)),
              (broken) => halt(asBody(broken), pc, 0x02),
              (valid) => setPc(asBody(valid), target),
            );
          },
          (maybeExc) => {
            const scope = asBody(maybeExc);

            scope.if(
              isExceptionReturn(scope, target),
              (inner) => exceptionReturn(asBody(inner), undefined, pc),
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
          },
        );
      } else {
        b.if(
          b.lessThan(u32(b, target), num(b, 0xffffffe0)),
          (normal) => setPc(asBody(normal), target),
          (maybeExc) => {
            const scope = asBody(maybeExc);

            scope.if(
              isExceptionReturn(scope, target),
              (inner) => exceptionReturn(asBody(inner), undefined, pc),
              (normal) => setPc(asBody(normal), target),
            );
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
    const value = literalValue16(code, pc, instr, firmwareLength, region);

    if (value !== undefined) {
      writeResult(b, rt, num(b, value));

      return;
    }

    loadRegister(b, rt, num(b, address & ~3), 4, pc, false, atAddress((address & ~3) >>> 0));

    return;
  }

  if (instr < 0x6000) {
    // Load/store register offset.
    const op = (instr >> 9) & 7;
    const rm = (instr >> 6) & 7;
    const rn = (instr >> 3) & 7;
    const rt = instr & 7;
    const address = b.add(readReg(b, rn), readReg(b, rm));
    const at = registerAt16(knownRegs, rn, rm, op < 3 ? knownValue(knownRegs, rt) : undefined);

    switch (op) {
      case 0:
        storeRegister(b, rt, address, 4, pc, at, true);
        break;
      case 1:
        storeRegister(b, rt, address, 2, pc, at, true);
        break;
      case 2:
        storeRegister(b, rt, address, 1, pc, at, true);
        break;
      case 3:
        loadRegister(b, rt, address, 1, pc, true, at, true);
        break;
      case 4:
        loadRegister(b, rt, address, 4, pc, false, at, true);
        break;
      case 5:
        loadRegister(b, rt, address, 2, pc, false, at, true);
        break;
      case 6:
        loadRegister(b, rt, address, 1, pc, false, at, true);
        break;
      default:
        loadRegister(b, rt, address, 2, pc, true, at, true);
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
    const at = immediateAt16(
      knownRegs,
      rn,
      imm * size,
      load ? undefined : knownValue(knownRegs, rt),
    );

    if (load) loadRegister(b, rt, address, size, pc, false, at, true);
    else {
      storeRegister(b, rt, address, size, pc, at, true);
    }

    return;
  }

  if (instr < 0xa000) {
    // SP-relative load/store.
    const load = (instr & 0x0800) !== 0;
    const rt = (instr >> 8) & 7;
    const address = b.add(readSp(b), num(b, (instr & 0xff) << 2));

    if (load) loadRegister(b, rt, address, 4, pc, false, atSram());
    else storeRegister(b, rt, address, 4, pc, atSram());

    return;
  }

  if (instr < 0xb000) {
    // ADR / ADD rd, SP, #imm
    const rd = (instr >> 8) & 7;
    const imm = (instr & 0xff) << 2;

    // 0xA800–0xAFFF 是 `ADD rd, SP, #imm`：rd 只有 3 位，永远不可能是 SP，
    // 所以这里必须写 rd。把它当成「调整 SP」会让 `add r0, sp, #56` 之类的
    // 普通寻址把栈指针顶高，后续 pop 就会取到错位的返回地址。
    if (instr & 0x0800) writeResult(b, rd, b.add(readSp(b), num(b, imm)));
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
    const staticBase = known(knownRegs, rn);

    if (load) {
      // LDM 的地址逐字递增，最多只有一个寄存器会命中 IDR，因此延迟读可以共用同一槽位。
      registers.forEach((register, offset) => {
        const at = staticAddress(staticBase, offset * 4);

        loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, false, at, true);
      });
      if (!registers.includes(rn)) writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
    } else {
      registers.forEach((register, offset) => {
        const at = staticAddress(staticBase, offset * 4, knownValue(knownRegs, register));

        storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, at);
      });
      writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
    }

    return;
  }

  if (instr < 0xe000) {
    // Conditional branch / SVC / UDF.
    const condition = (instr >> 8) & 0xf;
    const offset = signed8(instr & 0xff);

    if (condition === 0xe) {
      // 0xDE00-0xDEFF: UDF（永久未定义）。
      halt(b, pc, 0x04);
    } else if (condition === 0xf) {
      // 0xDF00-0xDFFF: SVC。同步异常走 nvic.enterSvc：优先级/掩蔽/同级升级 HardFault
      // 与压栈规则都由 NVIC 维护，这里不复制第二份栈/PC 规则。
      clearExclusiveMonitor(b);
      enterSvc(b, (pc + 2) >>> 0);
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

  if ((instr & 0xf500) === 0xb100) {
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
    // 合法的 B3xx CBZ/CBNZ 已由上面的 f500 掩码处理；剩余 B3xx 才是保留编码，
    // 不能静默穿过，也不能把它当 REV（真正 REV 在 0xBAxx）。
    halt(b, pc, 0x09);
    return;
  }

  if ((instr & 0xff00) === 0xba00) {
    const op = (instr >> 6) & 3;
    const rm = (instr >> 3) & 7;
    const rd = instr & 7;
    const source = readReg(b, rm);

    if (op === 2) {
      halt(b, pc, 0x09);
      return;
    }

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
      storeRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, atSram()),
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
    const pcIndex = registers.indexOf(15);

    if (pcIndex >= 0) {
      // POP {..., pc} 的 SP 写回发生在分支之前；异常返回用写回后的 SP 弹帧，
      // 因此先把非 PC 寄存器装完、写 SP，再装 PC。
      registers.slice(0, pcIndex).forEach((register, offset) =>
        loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, false, atSram()),
      );
      writeSp(b, b.add(base, num(b, registers.length * 4)));
      loadRegister(b, 15, b.add(base, num(b, pcIndex * 4)), 4, pc, false, atSram());
    } else {
      registers.forEach((register, offset) =>
        loadRegister(b, register, b.add(base, num(b, offset * 4)), 4, pc, false, atSram()),
      );
      writeSp(b, b.add(base, num(b, registers.length * 4)));
    }

    return;
  }

  if ((instr & 0xffef) === 0xb662) {
    const disable = (instr & 0x10) !== 0;

    writePrimask(b, num(b, disable ? 1 : 0));
    syncIrqService(b);

    return;
  }

  if ((instr & 0xffef) === 0xb661) {
    // CPSIE/CPSID f：FAULTMASK 由 nvic 的隐藏状态维护。
    writeFaultmask(b, num(b, (instr & 0x10) !== 0 ? 1 : 0));

    return;
  }

  if ((instr & 0xff00) === 0xbe00) {
    halt(b, pc, 0x06);
    return;
  }

  // 其余 0xB0xx–0xBxxx（SETEND、保留编码等）一律显式 fault。
  halt(b, pc, 0x09);
}
