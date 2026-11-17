import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { APSR_C } from './layout';
import type { AccessSize } from './layout';
import {
  addRaw,
  addWithCarry,
  asBody,
  boolAnd,
  boolBit,
  boolOr,
  flag,
  isZero,
  maskWidth,
  num,
  readReg,
  readWordAt,
  setPc,
  setPcConst,
  shiftRaw,
  shiftValue,
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
  writeWordAt,
  readSp,
} from './ir';
import type { Body } from './ir';
import { conditional, loadRegister, readAnyReg, storeRegister, writeAnyReg } from './cpu';
import {
  atAddress,
  atAccessEffects,
  atSram,
  gpioReadsAsZero,
  readMemory,
  writeMemory,
} from './memory';
import { codeLocalOffset } from './code-region';
import type { CodeRegion } from './code-region';
import type { AccessEffects } from './memory';
import {
  clearExclusiveMonitor,
  exclusiveMatch,
  noteGuestStore,
  recordExclusive,
} from './exclusive';
import { halt } from './thumb16';
import type { CodeBytes } from './decode';
import { classifyDsp, dspConstant, dspWrittenRegisters, emitDsp32 } from './dsp';
import { emitBarrier, emitMrs, emitMsr, isSystemRegisterSupported } from './system';
import {
  FPCCR_ASPEN,
  FPCCR_LSPACT,
  FPSCR_WRITE_MASK,
  FPU_FPSCR,
  FPU_MEMORY,
} from './fpu-layout';
import {
  isPrivileged,
  readCpacr,
  readFpca,
  readFpccr,
  requestUsageFault,
  setFpca,
  unsupportedFpContext,
} from './nvic';
/** VFP/协处理器编码空间；除窄 VMSR FPSCR 外统一显式 unsupported fault。 */
const isVfpEncoding = (h1: number, h2: number): boolean => {
  void h2;

  return (h1 & 0xfc00) === 0xec00;
};

/**
 * 唯一实现的 FP 指令：`VMSR FPSCR, Rt`。
 *
 * ARMv7-M VMSR 规定 Rt=13（SP）与 Rt=15（PC）为 UNPREDICTABLE；这里把这两种
 * 编码留在 unsupported 路径，避免把不可预测行为当成合法寄存器读写。
 */
const isVmsrFpscr = (h1: number, h2: number): boolean => {
  if (h1 !== 0xeee1 || (h2 & 0x0fff) !== 0x0a10) return false;

  const rt = (h2 >>> 12) & 0xf;

  return rt !== 13 && rt !== 15;
};

/**
 * VMSR 的 ExecuteFPCheck 可支持子集：
 * - CPACR 00 / 01+非特权 -> 真实 NOCP；
 * - CPACR 10/10、mismatch 是 UNPREDICTABLE，按模型 0x20 显式拒绝，不伪造 NOCP；
 * - CPACR 允许但 LSPACT=1 -> PreserveFPState 未实现，0x21 显式停止；
 * - LSPACT=0 时按 ASPEN 置 FPCA，然后写 FPSCR。
 */
function emitVmsrFpscr(b: Body, pc: number, h2: number): void {
  const rt = (h2 >>> 12) & 0xf;
  const cpacr = readCpacr(b);
  const cp10 = b.bitAnd(b.shiftRightUnsigned(cpacr, num(b, 20)), num(b, 3));
  const cp11 = b.bitAnd(b.shiftRightUnsigned(cpacr, num(b, 22)), num(b, 3));
  const same = b.equal(types.number, cp10, cp11);
  const privileged = isPrivileged(b);
  const enabled = boolAnd(
    b,
    same,
    boolOr(
      b,
      b.equal(types.number, cp10, num(b, 3)),
      boolAnd(b, b.equal(types.number, cp10, num(b, 1)), privileged),
    ),
  );
  const unsupported = boolOr(
    b,
    b.not(same),
    boolAnd(b, same, b.equal(types.number, cp10, num(b, 2))),
  );

  b.if(unsupported, (bad) => {
    // UNPREDICTABLE 编码：保持现有 0x20，不写 CFSR/FPSCR/FPCA。
    halt(asBody(bad), pc, 0x20);
  }, (defined) => {
    const body = asBody(defined);

    body.if(enabled, (allowed) => {
      const scope = asBody(allowed);

      scope.if(boolBit(scope, readFpccr(scope), FPCCR_LSPACT), (active) => {
        // 不执行 PreserveFPState、不清 LSPACT，也不改 FPSCR/FPCA。
        unsupportedFpContext(asBody(active), pc);
      }, (usable) => {
        const ok = asBody(usable);

        ok.if(
          boolAnd(
            ok,
            boolBit(ok, readFpccr(ok), FPCCR_ASPEN),
            ok.not(readFpca(ok)),
          ),
          (activate) => setFpca(asBody(activate)),
          () => {},
        );
        writeWordAt(
          ok,
          FPU_MEMORY,
          FPU_FPSCR,
          ok.bitAnd(u32(ok, readReg(ok, rt)), num(ok, FPSCR_WRITE_MASK)),
        );
      });
    }, (denied) => {
      const scope = asBody(denied);

      // NOCP 是同步 UsageFault：栈帧返回地址必须指回本条 VMSR，后继不能执行。
      scope.writeState('pc', num(scope, pc));
      requestUsageFault(scope, true);
    });
  });
}
import type { KnownRegs } from './decode';

/** 32 位 Thumb-2 指令的子集；未覆盖的编码在 `decode32` 中报告故障。 */
export interface Instruction32 {
  readonly size: 4;
  readonly cycles: number;
  readonly mayService: boolean;
  readonly dynamicMemory?: boolean;
  /** 静态 GPIO 输出写之后必须收块，使电气边界看到脉冲。 */
  readonly boundaryAfter?: boolean;
  /** 译码器确认该编码无法执行（会 halt），批处理/事实扫描必须就此停下。 */
  readonly terminates?: boolean;
  readonly emit: (b: Body, pc: number) => void;
}


const signExtendBits = (value: number, bits: number): number => {
  const shift = 32 - bits;

  return (value << shift) >> shift;
};

/**
 * ADR.W 的 PC 基址：Align(PC, 4)，其中 PC 为当前指令地址 + 4。
 *
 * 只用于 ADDW/SUBW 的 Rn=PC 编码（ADR.W 别名）；普通 Rn 仍是原寄存器值。
 * 其它指令按各自的 PC 规则处理（LDR literal 同样做 Align(pc + 4, 4)，但属于独立语义），
 * 不更改全局 `readAnyReg`。
 */
const adrPcBase = (pc: number): number => ((pc + 4) & ~3) >>> 0;

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

const knownValue = known;

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
  region?: CodeRegion,
): number | undefined => {
  if (code === undefined) return undefined;

  const offset = codeLocalOffset(region, address);

  if (offset === undefined || offset + size > Math.min(firmwareLength, code.byteLength))
    return undefined;

  let value = 0;
  for (let index = 0; index < size; index += 1) value |= (code[offset + index] ?? 0) << (index * 8);

  if (!signed) return value >>> 0;

  const shift = 32 - size * 8;

  return (value << shift) >> shift;
};

export const isBranch32 = (h1: number, h2: number): boolean => {
  if ((h1 & 0xf800) !== 0xf000) return false;

  // B<cond>.W 与 BL/B.W/BLX.W 共享 h2 的高位；MRS/MSR/SSAT 等 f3xx 编码必须用条件码
  // 0..13 排除，否则 `mrs r0, apsr` 会被当成 cond=0xf 的 B.W 并写 PC。
  if ((h2 & 0xd000) === 0x8000 && ((h1 >> 6) & 0xf) >= 14) return false;

  return (
    (h2 & 0xd000) === 0xd000 ||
    (h2 & 0xd000) === 0xc000 ||
    (h2 & 0xd000) === 0x9000 ||
    (h2 & 0xd000) === 0x8000
  );
};

const immediateAt = (
  regs: KnownRegs | undefined,
  rn: number,
  pc: number,
  offset: number,
  alignedPc = false,
  value?: number,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 15)
    return atAddress((((alignedPc ? (pc + 4) & ~3 : pc + 4) + offset) >>> 0));
  if (rn === 13) return atSram();

  const base = known(regs, rn);

  return base === undefined ? undefined : atAddress((base + offset) >>> 0, value);
};

const registerAt = (
  regs: KnownRegs | undefined,
  rn: number,
  rm: number,
  pc: number,
  shift: number,
  value?: number,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 13) return atSram();

  const index = known(regs, rm);
  if (rn === 15) {
    return index === undefined
      ? atAddress((pc + 4) >>> 0)
      : atAddress((((pc + 4) >>> 0) + ((index << shift) >>> 0)) >>> 0, value);
  }

  const base = known(regs, rn);

  return base === undefined || index === undefined
    ? undefined
    : atAddress((base + ((index << shift) >>> 0)) >>> 0, value);
};

const multipleAt = (
  regs: KnownRegs | undefined,
  rn: number,
  offset: number,
  value?: number,
): ReturnType<typeof atAddress> | undefined => {
  if (rn === 13) return atSram();
  if (rn === 15) return undefined;

  const base = known(regs, rn);

  return base === undefined ? undefined : atAddress((base + offset) >>> 0, value);
};

function writeData(
  b: Body,
  rd: number,
  value: Value<number>,
  setFlags: boolean,
  pc: number,
): void {
  if (setFlags) writeNz(b, signIsSet(b, value), isZero(b, value));
  writeAnyReg(b, rd, value, pc);
}

function logicOperation(
  b: Body,
  op: number,
  left: Value<number>,
  right: Value<number>,
  rd: number,
  setFlags: boolean,
  pc: number,
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

  writeData(b, rd, value, setFlags, pc);
}

function arithmeticOperation(
  b: Body,
  op: number,
  left: Value<number>,
  right: Value<number>,
  rd: number,
  setFlags: boolean,
  pc: number,
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
  writeData(b, rd, value, setFlags, pc);
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
    writeData(b, rd, right, setFlags, pc);

    return;
  }

  if (op === 1 && rn === 15) {
    writeData(b, rd, b.bitNot(right), setFlags, pc);

    return;
  }

  if (op === 0 || op === 1 || op === 2 || op === 3 || op === 4) {
    logicOperation(b, op, left, right, rd, setFlags, pc);

    return;
  }

  arithmeticOperation(b, op, left, right, rd, setFlags, pc);
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
    writeData(b, rd, right, setFlags, pc);

    return;
  }

  if (op === 1 && rn === 15) {
    writeData(b, rd, b.bitNot(right), setFlags, pc);

    return;
  }

  if (op === 0 || op === 1 || op === 2 || op === 3 || op === 4) {
    logicOperation(b, op, left, right, rd, setFlags, pc);

    return;
  }

  arithmeticOperation(b, op, left, right, rd, setFlags, pc);
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

    if (cond >= 14) return false;
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
  region?: CodeRegion,
): void {
  if (regs === undefined) return;

  const any = (index: number): number | undefined =>
    index === 15 ? (pc + 4) >>> 0 : known(snapshot, index);

  if (isBranch32(h1, h2)) {
    if ((h2 & 0xd000) === 0xd000 || (h2 & 0xd000) === 0xc000) remember(regs, 14, undefined);

    return;
  }

  if (classifyDsp(h1, h2) !== undefined) {
    const exact = dspConstant(h1, h2, (index) => known(snapshot, index));
    const dest = (h2 >> 8) & 0xf;

    for (const register of dspWrittenRegisters(h1, h2))
      remember(regs, register, register === dest ? exact : undefined);
    return;
  }

  // VMSR 只读通用寄存器、不写回，不能清空调用方已经证明的 GPR 常量。
  if (isVmsrFpscr(h1, h2)) return;

  if (isVfpEncoding(h1, h2)) {
    regs.fill(undefined);
    return;
  }

  if ((h1 & 0xfbe0) === 0xf200 || (h1 & 0xfbe0) === 0xf2a0) {
    const sub = (h1 & 0x0080) !== 0;
    const rn = h1 & 0xf;
    const left = rn === 15 ? adrPcBase(pc) : known(snapshot, rn);
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
    remember(regs, (h2 >> 8) & 0xf, undefined);
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

    if (load && isPrefetchHint(kind, rt)) return;

    if (load) {
      const at = immediateAt(snapshot, rn, pc, offset, true);
      const literal =
        rn === 15
          ? firmwareValue(code, (((pc + 4) & ~3) + offset) >>> 0, size, firmwareLength, false, region)
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
    if (isPrefetchHint(h1 & 0xfff0, rt)) return;
    const at = immediateAt(snapshot, rn, pc, offset, true);
    const literal =
      rn === 15
        ? firmwareValue(code, (((pc + 4) & ~3) + offset) >>> 0, size, firmwareLength, true, region)
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
    (h1 & 0xfff0) === 0xf820 ||
    (h1 & 0xfff0) === 0xf910 ||
    (h1 & 0xfff0) === 0xf930
  ) {
    const kind = h1 & 0xfff0;
    const rn = h1 & 0xf;
    const rt = (h2 >> 12) & 0xf;
    const signed = kind === 0xf910 || kind === 0xf930;
    const load = kind === 0xf850 || kind === 0xf810 || kind === 0xf830 || signed;
    if (load && isPrefetchHint(kind, rt)) return;
    const size: 1 | 2 | 4 = signed
      ? kind === 0xf910
        ? 1
        : 2
      : kind === 0xf810 || kind === 0xf800
        ? 1
        : kind === 0xf830 || kind === 0xf820
          ? 2
          : 4;

    if (rn === 15) {
      if (load) {
        const address = (((pc + 4) & ~3) - (h2 & 0xfff)) >>> 0;

        remember(
          regs,
          rt,
          firmwareValue(code, address, size, firmwareLength, signed, region) ?? readConstant(atAddress(address)),
        );
      }
      return;
    }

    if ((h2 & 0x0800) === 0) {
      const at = registerAt(snapshot, rn, h2 & 0xf, pc, (h2 >> 4) & 3);

      if (load) remember(regs, rt, readConstant(at));
      return;
    }

    const pre = (h2 & 0x0400) !== 0;
    const add = (h2 & 0x0200) !== 0;
    const at = immediateAt(snapshot, rn, pc, pre ? (add ? h2 & 0xff : -(h2 & 0xff)) : 0, true);

    if (load) remember(regs, rt, readConstant(at));
    if ((h2 & 0x0100) !== 0) remember(regs, rn, undefined);
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

  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) {
    if ((h2 & 0xffe0) === 0xf000) return; // TBB/TBH
    remember(regs, (h2 >> 12) & 0xf, undefined); // LDREXB/LDREXH
    return;
  }

  if (
    (h1 & 0xfe40) === 0xe840 &&
    ((h1 & 0x0100) !== 0 || (h1 & 0x20) !== 0 || (h1 & 0x10) !== 0) &&
    (h2 & 0x0f00) !== 0x0f00 &&
    (h2 & 0x00f0) !== 0x00f0
  ) {
    // LDRD/STRD (immediate)：P=bit8, U=bit7, W=bit5, L=bit4。
    const load = (h1 & 0x10) !== 0;
    const writeBack = (h1 & 0x20) !== 0;
    const rn = h1 & 0xf;

    if (load) {
      remember(regs, (h2 >> 12) & 0xf, undefined);
      remember(regs, (h2 >> 8) & 0xf, undefined);
    }
    if (writeBack) remember(regs, rn, undefined);
    return;
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840) {
    if ((h1 & 0xfff0) === 0xe850) remember(regs, (h2 >> 12) & 0xf, undefined);
    else remember(regs, (h2 >> 8) & 0xf, 0);
    return;
  }

  if ((h1 & 0xfff0) === 0xe8c0) {
    remember(regs, h2 & 0xf, 0); // STREXB/STREXH：状态总是 0
    return;
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return;
  if (h1 === 0xf3af && h2 === 0x8000) return;

  regs.fill(undefined);
}

function mayService32(
  h1: number,
  h2: number,
  pc: number,
  regs: KnownRegs | undefined,
  effects: AccessEffects,
): boolean {
  if (classifyDsp(h1, h2) !== undefined) return false;
  // VMSR 可能因 CPACR 权限触发同步 NOCP，必须让批末结算 service。
  if (isVmsrFpscr(h1, h2)) return true;
  if (isVfpEncoding(h1, h2)) return false;

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
  ) {
    const kind = h1 & 0xfff0;
    const load =
      kind === 0xf8d0 || kind === 0xf890 || kind === 0xf8b0 || kind === 0xf990 || kind === 0xf9b0;
    const size: AccessSize =
      kind === 0xf890 || kind === 0xf880 || kind === 0xf990
        ? 1
        : kind === 0xf8b0 || kind === 0xf8a0 || kind === 0xf9b0
          ? 2
          : 4;
    const rt = (h2 >> 12) & 0xf;
    if (load && isPrefetchHint(kind, rt)) return false;
    const at = immediateAt(
      regs,
      h1 & 0xf,
      pc,
      h2 & 0xfff,
      true,
      load ? undefined : knownValue(regs, rt),
    );

    return atAccessEffects(at, load ? 'read' : 'write', size, effects);
  }

  if (
    (h1 & 0xfff0) === 0xf850 ||
    (h1 & 0xfff0) === 0xf840 ||
    (h1 & 0xfff0) === 0xf810 ||
    (h1 & 0xfff0) === 0xf800 ||
    (h1 & 0xfff0) === 0xf830 ||
    (h1 & 0xfff0) === 0xf820 ||
    (h1 & 0xfff0) === 0xf910 ||
    (h1 & 0xfff0) === 0xf930
  ) {
    const kind = h1 & 0xfff0;
    const signed = kind === 0xf910 || kind === 0xf930;
    const load = kind === 0xf850 || kind === 0xf810 || kind === 0xf830 || signed;
    const size: AccessSize = signed
      ? kind === 0xf910
        ? 1
        : 2
      : kind === 0xf810 || kind === 0xf800
        ? 1
        : kind === 0xf830 || kind === 0xf820
          ? 2
          : 4;
    const rn = h1 & 0xf;
    const rt = (h2 >> 12) & 0xf;

    if (load && isPrefetchHint(kind, rt)) return false;

    if (rn === 15) {
      const at = atAddress(((((pc + 4) & ~3) - (h2 & 0xfff)) >>> 0));

      return atAccessEffects(at, 'read', size, effects);
    }

    if ((h2 & 0x0800) === 0) {
      const at = registerAt(
        regs,
        rn,
        h2 & 0xf,
        pc,
        (h2 >> 4) & 3,
        load ? undefined : knownValue(regs, rt),
      );

      return atAccessEffects(at, load ? 'read' : 'write', size, effects);
    }

    const pre = (h2 & 0x0400) !== 0;
    const add = (h2 & 0x0200) !== 0;
    const at = immediateAt(
      regs,
      rn,
      pc,
      pre ? (add ? h2 & 0xff : -(h2 & 0xff)) : 0,
      true,
      load ? undefined : knownValue(regs, rt),
    );

    return atAccessEffects(at, load ? 'read' : 'write', size, effects);
  }

  if (h1 === 0xe92d || h1 === 0xe8bd) return false;

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) {
    const load = (h1 & 0xffd0) === 0xe890;

    if ((h2 & 0xffff) === 0) return false;
    for (let register = 0; register < 16; register += 1)
      if (h2 & (1 << register)) {
        const at = multipleAt(
          regs,
          h1 & 0xf,
          register * 4,
          load ? undefined : knownValue(regs, register),
        );

        if (atAccessEffects(at, load ? 'read' : 'write', 4, effects)) return true;
      }
    return false;
  }

  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) {
    if ((h2 & 0xffe0) === 0xf000) {
      const at = registerAt(regs, h1 & 0xf, h2 & 0xf, pc, 0);

      return atAccessEffects(at, 'read', (h2 & 0x10) !== 0 ? 2 : 1, effects);
    }
    const at = multipleAt(regs, h1 & 0xf, 0);

    return atAccessEffects(at, 'read', (h2 & 0x10) !== 0 ? 2 : 1, effects);
  }

  if ((h1 & 0xfff0) === 0xe8c0) {
    const at = multipleAt(regs, h1 & 0xf, 0);

    return atAccessEffects(at, 'write', (h2 & 0x10) !== 0 ? 2 : 1, effects);
  }

  if (
    (h1 & 0xfe40) === 0xe840 &&
    ((h1 & 0x0100) !== 0 || (h1 & 0x20) !== 0 || (h1 & 0x10) !== 0) &&
    (h2 & 0x0f00) !== 0x0f00 &&
    (h2 & 0x00f0) !== 0x00f0
  ) {
    const load = (h1 & 0x10) !== 0;
    const add = (h1 & 0x80) !== 0;
    const pre = (h1 & 0x0100) !== 0;
    const offset = (h2 & 0xff) * 4;
    const firstAt = multipleAt(
      regs,
      h1 & 0xf,
      pre ? (add ? offset : -offset) : 0,
      load ? undefined : knownValue(regs, (h2 >> 12) & 0xf),
    );
    const secondAt = multipleAt(
      regs,
      h1 & 0xf,
      pre ? (add ? offset : -offset) + 4 : 4,
      load ? undefined : knownValue(regs, (h2 >> 8) & 0xf),
    );
    const access = load ? 'read' : 'write';

    return (
      atAccessEffects(firstAt, access, 4, effects) || atAccessEffects(secondAt, access, 4, effects)
    );
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840) {
    const load = (h1 & 0xfff0) === 0xe850;
    const at = multipleAt(
      regs,
      h1 & 0xf,
      (h2 & 0xff) << 2,
      load ? undefined : knownValue(regs, (h2 >> 12) & 0xf),
    );

    return atAccessEffects(at, load ? 'read' : 'write', 4, effects);
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return false;
  if (h1 === 0xf3af && h2 === 0x8000) return false;

  // 未覆盖编码会 halt；保守进入完整守卫以截停后续指令。
  return true;
}

/** 是否需要在指令块内发射完整的动态内存分派树。 */
function dynamicMemory32(h1: number, h2: number, pc: number, regs: KnownRegs | undefined): boolean {
  if (
    (h1 & 0xfff0) === 0xf8d0 ||
    (h1 & 0xfff0) === 0xf8c0 ||
    (h1 & 0xfff0) === 0xf890 ||
    (h1 & 0xfff0) === 0xf880 ||
    (h1 & 0xfff0) === 0xf8b0 ||
    (h1 & 0xfff0) === 0xf8a0 ||
    (h1 & 0xfff0) === 0xf990 ||
    (h1 & 0xfff0) === 0xf9b0
  ) {
    const kind = h1 & 0xfff0;
    const rt = (h2 >> 12) & 0xf;

    if (isPrefetchHint(kind, rt)) return false;

    return immediateAt(regs, h1 & 0xf, pc, h2 & 0xfff, true) === undefined;
  }

  if (
    (h1 & 0xfff0) === 0xf850 ||
    (h1 & 0xfff0) === 0xf840 ||
    (h1 & 0xfff0) === 0xf810 ||
    (h1 & 0xfff0) === 0xf800 ||
    (h1 & 0xfff0) === 0xf830 ||
    (h1 & 0xfff0) === 0xf820 ||
    (h1 & 0xfff0) === 0xf910 ||
    (h1 & 0xfff0) === 0xf930
  ) {
    const kind = h1 & 0xfff0;
    const rt = (h2 >> 12) & 0xf;
    const rn = h1 & 0xf;

    if (isPrefetchHint(kind, rt)) return false;
    if (rn === 15) return false;
    if ((h2 & 0x0800) === 0)
      return registerAt(regs, rn, h2 & 0xf, pc, (h2 >> 4) & 3) === undefined;
    const pre = (h2 & 0x0400) !== 0;
    const add = (h2 & 0x0200) !== 0;

    return immediateAt(regs, rn, pc, pre ? (add ? h2 & 0xff : -(h2 & 0xff)) : 0, true) === undefined;
  }

  if (h1 === 0xe92d || h1 === 0xe8bd) return false;

  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890)
    return (h2 & 0xffff) !== 0 && multipleAt(regs, h1 & 0xf, 0) === undefined;

  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) {
    if ((h2 & 0xffe0) === 0xf000) return registerAt(regs, h1 & 0xf, h2 & 0xf, pc, 0) === undefined;
    return multipleAt(regs, h1 & 0xf, 0) === undefined;
  }

  if ((h1 & 0xfff0) === 0xe8c0) return multipleAt(regs, h1 & 0xf, 0) === undefined;

  if (
    (h1 & 0xfe40) === 0xe840 &&
    ((h1 & 0x0100) !== 0 || (h1 & 0x20) !== 0 || (h1 & 0x10) !== 0) &&
    (h2 & 0x0f00) !== 0x0f00 &&
    (h2 & 0x00f0) !== 0x00f0
  )
    return multipleAt(regs, h1 & 0xf, 0) === undefined;

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840)
    return multipleAt(regs, h1 & 0xf, 0) === undefined;

  return false;
}

/** MRS/MSR 的非法/未实现编码必须在译码期标记终止，否则后续指令会在 fault 后继续执行。 */
function terminatesSystemInstruction(h1: number, h2: number): boolean {
  if ((h1 & 0xfff0) === 0xf3e0) {
    const sysm = h2 & 0xff;

    return (h2 & 0xf000) !== 0x8000 || !isSystemRegisterSupported(sysm);
  }

  if ((h1 & 0xfff0) === 0xf380) {
    const sysm = h2 & 0xff;
    const mask = (h2 >> 10) & 3;

    return (
      (h2 & 0xf300) !== 0x8000 ||
      !isSystemRegisterSupported(sysm) ||
      (sysm === 0 && mask === 0)
    );
  }

  return false;
}

/** 是否命中 `emit32` 的任一处理分支；未命中的编码会 halt，必须终止批处理/事实扫描。 */
function isSupported32(h1: number, h2: number): boolean {
  if (isBranch32(h1, h2)) return true;
  if (isVfpEncoding(h1, h2)) return true;
  if (classifyDsp(h1, h2) !== undefined) return true;

  const group = h1 & 0xfff0;

  if (
    (h1 & 0xfbe0) === 0xf200 ||
    (h1 & 0xfbe0) === 0xf2a0 ||
    (h1 & 0xfbf0) === 0xf240 ||
    (h1 & 0xfbf0) === 0xf2c0 ||
    ((h1 & 0xfa00) === 0xf000 && (h1 & 0x0200) === 0) ||
    (h1 & 0xfe00) === 0xea00 ||
    group === 0xf3c0 ||
    group === 0xf340 ||
    group === 0xf360 ||
    (h1 & 0xff80) === 0xfa00 ||
    group === 0xfab0 ||
    group === 0xfa90 ||
    group === 0xfbb0 ||
    group === 0xfb90 ||
    group === 0xf3e0 ||
    group === 0xf380
  )
    return true;

  if (
    group === 0xf8d0 ||
    group === 0xf8c0 ||
    group === 0xf890 ||
    group === 0xf880 ||
    group === 0xf8b0 ||
    group === 0xf8a0 ||
    group === 0xf990 ||
    group === 0xf9b0 ||
    group === 0xf850 ||
    group === 0xf840 ||
    group === 0xf810 ||
    group === 0xf800 ||
    group === 0xf830 ||
    group === 0xf820 ||
    group === 0xf910 ||
    group === 0xf930
  )
    return true;

  if (h1 === 0xe92d || h1 === 0xe8bd) return true;
  if ((h1 & 0xffd0) === 0xe880 || (h1 & 0xffd0) === 0xe890) return true;
  if (h1 >= 0xe8d0 && h1 <= 0xe8d7) return true;
  if (group === 0xe850 || group === 0xe840 || group === 0xe8c0) return true;
  if (
    (h1 & 0xfe40) === 0xe840 &&
    ((h1 & 0x0100) !== 0 || (h1 & 0x20) !== 0 || (h1 & 0x10) !== 0) &&
    (h2 & 0x0f00) !== 0x0f00 &&
    (h2 & 0x00f0) !== 0x00f0
  )
    return true;
  if (group === 0xf3b0 && (h2 & 0xff00) === 0x8f00) return true;
  if (h1 === 0xf3af && h2 === 0x8000) return true;

  return false;
}

export function decode32(
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  pc = 0,
  code?: CodeBytes,
  firmwareLength = code?.byteLength ?? 0,
  region?: CodeRegion,
): Instruction32 {
  const snapshot = knownRegs?.slice();

  updateConstants32(h1, h2, pc, code, firmwareLength, knownRegs, snapshot, region);

  const effects: AccessEffects = { boundaryAfter: false };
  const vmsr = isVmsrFpscr(h1, h2);

  return {
    size: 4,
    cycles: 2,
    mayService: mayService32(h1, h2, pc, snapshot, effects),
    dynamicMemory: dynamicMemory32(h1, h2, pc, snapshot),
    // 合法 VMSR 不是终止指令；收块只为让可能的同步 NOCP 及时进入 service。
    boundaryAfter: vmsr || effects.boundaryAfter,
    ...((isVfpEncoding(h1, h2) && !vmsr) ||
    terminatesSystemInstruction(h1, h2) ||
    !isSupported32(h1, h2)
      ? { terminates: true }
      : {}),
    emit: (b, currentPc) => emit32(b, currentPc, h1, h2, snapshot, code, firmwareLength, region),
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
  region?: CodeRegion,
): void {
  if ((h1 & 0xf800) === 0xf000 && branchAndMisc(b, pc, h1, h2)) return;

  if (isVmsrFpscr(h1, h2)) {
    emitVmsrFpscr(b, pc, h2);
    return;
  }

  if (isVfpEncoding(h1, h2)) {
    // 其余 FPU/VFP 未实现；0x20 是模型 unsupported fault，不等同于架构 NOCP。
    halt(b, pc, 0x20);
    return;
  }

  if (emitDsp32(b, h1, h2)) return;

  if ((h1 & 0xfbe0) === 0xf200 || (h1 & 0xfbe0) === 0xf2a0) {
    // ADDW / SUBW (含 ADR.W 的 ADDW PC 形式)
    const sub = (h1 & 0x0080) !== 0;
    const rn = h1 & 0xf;
    const rd = (h2 >> 8) & 0xf;
    const i = (h1 >> 10) & 1;
    const imm3 = (h2 >> 12) & 7;
    const imm8 = h2 & 0xff;
    const imm = (i << 11) | (imm3 << 8) | imm8;
    const left = rn === 15 ? num(b, adrPcBase(pc)) : readAnyReg(b, rn, pc);
    const value = sub
      ? subRaw(b, left, num(b, imm), num(b, 0))
      : addRaw(b, left, num(b, imm), num(b, 0));

    writeAnyReg(b, rd, value, pc);

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

      remember(knownRegs, rd, known(knownRegs, rd) === undefined
        ? undefined
        : ((known(knownRegs, rd)! & 0xffff) | (immediate << 16)) >>> 0);
      writeReg(b, rd, value);
    } else {
      remember(knownRegs, rd, immediate);
      writeReg(b, rd, num(b, immediate));
    }

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

  if ((h1 & 0xfff0) === 0xfb00 || (h1 & 0xfff0) === 0xfb10 || (h1 & 0xfff0) === 0xfb30) {
    // 未命中 classifyDsp 的 op2 组合：显式 fault，不执行旧的无条件 MLS。
    halt(b, pc, 0x10);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3e0) {
    moveFromSpecial(b, pc, h2);

    return;
  }

  if ((h1 & 0xfff0) === 0xf380) {
    moveToSpecial(b, pc, h1, h2);

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
    loadStoreImmediate(b, pc, h1, h2, knownRegs, code, firmwareLength, region);

    return;
  }

  if ((h1 & 0xfff0) === 0xf990 || (h1 & 0xfff0) === 0xf9b0) {
    loadStoreSigned(b, pc, h1, h2, knownRegs, code, firmwareLength, region);

    return;
  }

  if (
    (h1 & 0xfff0) === 0xf850 ||
    (h1 & 0xfff0) === 0xf840 ||
    (h1 & 0xfff0) === 0xf810 ||
    (h1 & 0xfff0) === 0xf800 ||
    (h1 & 0xfff0) === 0xf830 ||
    (h1 & 0xfff0) === 0xf820 ||
    (h1 & 0xfff0) === 0xf910 ||
    (h1 & 0xfff0) === 0xf930
  ) {
    loadStoreOffset(b, pc, h1, h2, knownRegs, code, firmwareLength, region);

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
    if ((h2 & 0xffe0) === 0xf000) tableBranch(b, pc, h1, h2, knownRegs);
    else exclusiveAccess(b, pc, h1, h2, knownRegs);

    return;
  }

  if (
    (h1 & 0xfe40) === 0xe840 &&
    ((h1 & 0x0100) !== 0 || (h1 & 0x20) !== 0 || (h1 & 0x10) !== 0) &&
    (h2 & 0x0f00) !== 0x0f00 &&
    (h2 & 0x00f0) !== 0x00f0
  ) {
    // LDRD/STRD (immediate, pre/post-indexed)：P=bit8, U=bit7, W=bit5, L=bit4。
    dualLoadStore(b, pc, h1, h2, knownRegs);

    return;
  }

  if ((h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840 || (h1 & 0xfff0) === 0xe8c0) {
    exclusiveAccess(b, pc, h1, h2, knownRegs);

    return;
  }

  if ((h1 & 0xfff0) === 0xf3b0 && (h2 & 0xff00) === 0x8f00) {
    if (h2 === 0x8f2f) clearExclusiveMonitor(b);
    emitBarrier(b);
    return;
  }
  if (h1 === 0xf3af && h2 === 0x8000) {
    emitBarrier(b);
    return;
  }

  halt(b, pc, 0x10);
}

export const isPrefetchHint = (kind: number, rt: number): boolean =>
  rt === 15 && (kind === 0xf890 || kind === 0xf810 || kind === 0xf990 || kind === 0xf910);

function loadStoreImmediate(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
  region?: CodeRegion,
): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  if (isPrefetchHint(kind, rt)) {
    emitBarrier(b);
    return;
  }
  const load = kind === 0xf8d0 || kind === 0xf890 || kind === 0xf8b0;
  const size = kind === 0xf890 || kind === 0xf880 ? 1 : kind === 0xf8b0 || kind === 0xf8a0 ? 2 : 4;
  const literal =
    load && rn === 15 && rt !== 15
      ? firmwareValue(code, (((pc + 4) & ~3) + imm12) >>> 0, size, firmwareLength, false, region)
      : undefined;

  if (literal !== undefined) {
    writeAnyReg(b, rt, num(b, literal), pc);
    return;
  }

  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));
  const at = immediateAt(
    knownRegs,
    rn,
    pc,
    imm12,
    true,
    load ? undefined : knownValue(knownRegs, rt),
  );

  if (load) loadRegister(b, rt, address, size, pc, false, at, rn !== 15 && rn !== 13);
  else {
    storeRegister(b, rt, address, size, pc, at, rn !== 15 && rn !== 13);
  }
}

function loadStoreSigned(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
  region?: CodeRegion,
): void {
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const imm12 = h2 & 0xfff;
  const size = (h1 & 0xfff0) === 0xf990 ? 1 : 2;
  if (isPrefetchHint(h1 & 0xfff0, rt)) {
    emitBarrier(b);
    return;
  }
  const literal =
    rn === 15 && rt !== 15
      ? firmwareValue(code, (((pc + 4) & ~3) + imm12) >>> 0, size, firmwareLength, true, region)
      : undefined;

  if (literal !== undefined) {
    writeAnyReg(b, rt, num(b, literal), pc);
    return;
  }

  const address =
    rn === 15 ? num(b, (((pc + 4) & ~3) + imm12) >>> 0) : b.add(readReg(b, rn), num(b, imm12));
  const at = immediateAt(knownRegs, rn, pc, imm12, true);

  loadRegister(b, rt, address, size, pc, true, at, rn !== 15 && rn !== 13);
}

function loadStoreOffset(
  b: Body,
  pc: number,
  h1: number,
  h2: number,
  knownRegs?: KnownRegs,
  code?: CodeBytes,
  firmwareLength = 0,
  region?: CodeRegion,
): void {
  const kind = h1 & 0xfff0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const signed = kind === 0xf910 || kind === 0xf930;
  const load = kind === 0xf850 || kind === 0xf810 || kind === 0xf830 || signed;
  if (load && isPrefetchHint(kind, rt)) {
    emitBarrier(b);
    return;
  }
  const size: AccessSize = signed ? (kind === 0xf910 ? 1 : 2) : kind === 0xf810 || kind === 0xf800 ? 1 : kind === 0xf830 || kind === 0xf820 ? 2 : 4;

  // `ldr.w pc-relative, #-imm` 是 literal 形式：rn=15 时 h2 的 bit11 是 imm12 的一部分，
  // 不能按 T4 的 P/U/W 解释。
  if (rn === 15) {
    if (!load) {
      halt(b, pc, 0x0c);
      return;
    }
    const imm12 = h2 & 0xfff;
    const address = (((pc + 4) & ~3) - imm12) >>> 0;
    const literal = firmwareValue(code, address, size, firmwareLength, signed, region);

    if (literal !== undefined) {
      writeAnyReg(b, rt, num(b, literal), pc);
      return;
    }
    loadRegister(b, rt, num(b, address), size, pc, signed, atAddress(address));
    return;
  }

  if ((h2 & 0x0800) === 0) {
    // LDR/STR (register)：h2 = Rt 000000 imm2 Rm。
    const rm = h2 & 0xf;
    const shift = (h2 >> 4) & 3;
    const address = b.add(readAnyReg(b, rn, pc), b.shiftLeft(readAnyReg(b, rm, pc), num(b, shift)));
    const at = registerAt(knownRegs, rn, rm, pc, shift, load ? undefined : knownValue(knownRegs, rt));

    if (load) loadRegister(b, rt, address, size, pc, signed, at, rn !== 13);
    else {
      storeRegister(b, rt, address, size, pc, at, rn !== 13);
      }
    return;
  }

  // LDR/STR (immediate) T4：h2 = Rt 1 P U W imm8。
  const pre = (h2 & 0x0400) !== 0;
  const add = (h2 & 0x0200) !== 0;
  const writeBack = (h2 & 0x0100) !== 0;
  const imm8 = h2 & 0xff;
  const base = readAnyReg(b, rn, pc);
  const offsetAddress = add
    ? b.add(base, num(b, imm8))
    : b.subtract(base, num(b, imm8));
  const address = pre ? offsetAddress : base;
  const at = immediateAt(
    knownRegs,
    rn,
    pc,
    pre ? (add ? imm8 : -imm8) : 0,
    true,
    load ? undefined : knownValue(knownRegs, rt),
  );

  if (load) {
    // `ldr pc, [sp], #imm` / `ldr pc, [sp, #imm]!` 的 SP 写回必须先发生：
    // 异常返回从写回后的 SP 弹帧。
    if (rt === 15 && writeBack && rn === 13) {
      writeSp(b, offsetAddress);
      loadRegister(b, rt, address, size, pc, signed, at, false);
      return;
    }
    loadRegister(b, rt, address, size, pc, signed, at, rn !== 13);
    if (writeBack) writeAnyReg(b, rn, offsetAddress, pc);
    return;
  }

  storeRegister(b, rt, address, size, pc, at, rn !== 13);
  if (writeBack) writeAnyReg(b, rn, offsetAddress, pc);
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
    const pcIndex = registers.indexOf(15);

    if (pcIndex >= 0) {
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
  const pcIndex = registers.indexOf(15);

  if (load && writeBack && rn === 13 && pcIndex >= 0 && !registers.includes(13)) {
    registers.forEach((register, offset) => {
      if (register === 15) return;
      const address = b.add(base, num(b, offset * 4));
      const at = multipleAt(knownRegs, rn, offset * 4);

      loadRegister(b, register, address, 4, pc, false, at, true);
    });
    writeSp(b, b.add(base, num(b, registers.length * 4)));
    loadRegister(
      b,
      15,
      b.add(base, num(b, pcIndex * 4)),
      4,
      pc,
      false,
      multipleAt(knownRegs, rn, pcIndex * 4),
      false,
    );
    return;
  }

  // 动态基址的多字 STM 不能按寄存器逐个展开完整写树：未知地址的 `writeMemory`
  // 本身要覆盖 SRAM/Flash/CCM/外设/系统/别名六个区间，一条 14-word STM 会把同一棵
  // 树发射十几次，单个 JIT 块即可越过 V8 的 generator 创建上限。这里用运行期循环
  // 只保留一份写树，每轮按当前下标读取真实源寄存器（保持逐 word 的 live 读取时序），
  // 并逐 word 调用一次 `noteGuestStore` 以维持 exclusive monitor 合同。
  //
  // 静态基址（`multipleAt` 有结果，包括 SP 相对访问）仍走原展开路径；单字与空 list
  // 也保持原样，避免为它们引入无意义的循环。空 list 的 W 写回与原行为一致。
  if (!load && registers.length > 1 && multipleAt(knownRegs, rn, 0) === undefined) {
    const index = b.local(types.number, 0);
    const source = b.local(types.number, 0);

    b.while(
      (test) => test.lessThan(test.getLocal(index), test.constant(types.number, registers.length)),
      (loop) => {
        const body = asBody(loop);
        const current = body.getLocal(index);
        const address = body.add(base, body.shiftLeft(current, num(body, 2)));

        noteGuestStore(body, address, 4);

        // 按下标选择本轮要写的寄存器；叶节点才读取 live 寄存器值，避免为每个源
        // 寄存器各发射一份完整写树。list 升序去重，最后一个下标作为无分支兜底。
        const select = (scope: Body, position: number): void => {
          if (position === registers.length - 1) {
            scope.setLocal(source, readAnyReg(scope, registers[position]!, pc));
            return;
          }

          scope.if(
            scope.equal(types.number, current, num(scope, position)),
            (hit) => {
              const selected = asBody(hit);

              selected.setLocal(source, readAnyReg(selected, registers[position]!, pc));
            },
            (next) => select(asBody(next), position + 1),
          );
        };

        select(body, 0);
        writeMemory(body, address, 4, body.getLocal(source), false);
        body.setLocal(index, body.add(current, num(body, 1)));
      },
    );

    if (writeBack) writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
    return;
  }

  registers.forEach((register, offset) => {
    const address = b.add(base, num(b, offset * 4));
    const at = multipleAt(
      knownRegs,
      rn,
      offset * 4,
      load ? undefined : knownValue(knownRegs, register),
    );

    if (load) loadRegister(b, register, address, 4, pc, false, at, true);
    else storeRegister(b, register, address, 4, pc, at);
  });

  if (writeBack && !(load && registers.includes(rn)))
    writeReg(b, rn, b.add(base, num(b, registers.length * 4)));
}

/** `ldrd`/`strd` 立即数寻址（P=bit8, U=bit7, W=bit5, L=bit4）。 */
function dualLoadStore(b: Body, pc: number, h1: number, h2: number, knownRegs?: KnownRegs): void {
  const load = (h1 & 0x10) !== 0;
  const writeBack = (h1 & 0x20) !== 0;
  const pre = (h1 & 0x0100) !== 0;
  const add = (h1 & 0x80) !== 0;
  const rn = h1 & 0xf;
  const rt = (h2 >> 12) & 0xf;
  const rt2 = (h2 >> 8) & 0xf;
  const offset = (h2 & 0xff) * 4;
  const base = readAnyReg(b, rn, pc);
  const offsetAddress = add ? b.add(base, num(b, offset)) : b.subtract(base, num(b, offset));
  const address = pre ? offsetAddress : base;
  const second = b.add(address, num(b, 4));
  const firstAt = multipleAt(
    knownRegs,
    rn,
    pre ? (add ? offset : -offset) : 0,
    load ? undefined : knownValue(knownRegs, rt),
  );
  const secondAt = multipleAt(
    knownRegs,
    rn,
    pre ? (add ? offset : -offset) + 4 : 4,
    load ? undefined : knownValue(knownRegs, rt2),
  );

  if (load) {
    loadRegister(b, rt, address, 4, pc, false, firstAt, true);
    loadRegister(b, rt2, second, 4, pc, false, secondAt, true);
  } else {
    storeRegister(b, rt, address, 4, pc, firstAt);
    storeRegister(b, rt2, second, 4, pc, secondAt);
  }
  if (writeBack) writeAnyReg(b, rn, offsetAddress, pc);
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
  const word = (h1 & 0xfff0) === 0xe850 || (h1 & 0xfff0) === 0xe840;
  const size: AccessSize = word ? 4 : (h2 & 0x10) !== 0 ? 2 : 1;
  const offset = word ? (h2 & 0xff) << 2 : 0;
  const address = b.add(readReg(b, rn), num(b, offset));
  const load = word ? (h1 & 0xfff0) === 0xe850 : (h1 & 0xfff0) === 0xe8d0;
  const at = multipleAt(knownRegs, rn, offset, load ? undefined : knownValue(knownRegs, rt));

  if (load) {
    loadRegister(b, rt, address, size, pc, false, at, rn !== 13);
    recordExclusive(b, address, size);
  } else {
    // STREX 的 Rt 是被写值，状态寄存器 Rd 在 word 形式是 h2[11:8]，在 byte/half 形式
    // 是 h2[3:0]。只有 local monitor 记录的地址/宽度都匹配才写内存并返回 0；一次
    // STREX 尝试后（无论成功失败）监视器失效。
    const rd = word ? (h2 >> 8) & 0xf : h2 & 0xf;
    const status = b.local(types.number, 1);

    b.if(exclusiveMatch(b, address, size), (success) => {
      const body = asBody(success);

      writeMemory(body, address, size, readAnyReg(body, rt, pc), rn !== 13, at);
      body.setLocal(status, num(body, 0));
    });
    clearExclusiveMonitor(b);
    writeReg(b, rd, b.getLocal(status));
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

function moveFromSpecial(b: Body, pc: number, h2: number): void {
  if ((h2 & 0xf000) !== 0x8000 || !emitMrs(b, h2)) {
    halt(b, pc, 0x0b);
  }
}

function moveToSpecial(b: Body, pc: number, h1: number, h2: number): void {
  if ((h2 & 0xf300) !== 0x8000 || !emitMsr(b, h1, h2)) {
    halt(b, pc, 0x0b);
  }
}
