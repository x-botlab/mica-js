import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { FPU_ACTIVE, FPU_FPSCR, FPU_MEMORY, FPU_S_BASE } from './fpu-layout';
import type { Body } from './ir';
import {
  asBody,
  boolAnd,
  boolBit,
  boolOr,
  num,
  readReg,
  readSp,
  readWordAt,
  u32,
  writeNzcv,
  writeReg,
  writeSp,
  writeWordAt,
} from './ir';
import { atAddress, atSram, readMemory, writeMemory } from './memory';
import type { At } from './memory';
import { halt } from './thumb16';
import { readCpacr, requestUsageFault } from './nvic';
import {
  absF32,
  addF32,
  compareF32,
  decodeF32,
  divF32,
  flushInput,
  FPSCR_DN,
  FPSCR_FZ,
  FPSCR_IOC,
  FPSCR_IXC,
  FPSCR_NZCV_MASK,
  FPSCR_RMODE_SHIFT,
  fromSignedInteger,
  fromUnsignedInteger,
  mulF32,
  negF32,
  packF32,
  raiseFlag,
  sqrtF32,
  subF32,
  toInteger,
} from './softfloat';
import type { F32Environment, F32Parts } from './softfloat';
import type { CodeBytes, KnownRegs } from './decode';

/**
 * Cortex-M4F FPv4-SP-D16 的 VFP 执行层。
 *
 * 只实现单精度算术；D0–D15 只作为 S 寄存器对参与 64 位搬运，不实现 f64 运算。
 * S0–S31/FPSCR 存放在 `periph` 的隐藏高段（见 fpu-layout），不新增 DDL state。
 */

export const FPU_NOCP_FAULT = 0x20;

/** `0xEC00–0xEFFF` 是 ARMv7-M 的协处理器/Advanced SIMD/VFP 编码空间。 */
export function isVfpEncoding(h1: number, h2: number): boolean {
  void h2;

  return (h1 & 0xfc00) === 0xec00;
}

export function readSRegister(b: Body, index: number): Value<number> {
  return readWordAt(b, FPU_MEMORY, FPU_S_BASE + (index & 31) * 4);
}

export function writeSRegister(b: Body, index: number, value: Value<number>): void {
  writeWordAt(b, FPU_MEMORY, FPU_S_BASE + (index & 31) * 4, u32(b, value));
}

export function readFpscr(b: Body): Value<number> {
  return readWordAt(b, FPU_MEMORY, FPU_FPSCR);
}

export function writeFpscr(b: Body, value: Value<number>): void {
  writeWordAt(b, FPU_MEMORY, FPU_FPSCR, u32(b, value));
}

export function readFpuActive(b: Body): Value<boolean> {
  return b.notEqual(types.number, readWordAt(b, FPU_MEMORY, FPU_ACTIVE), num(b, 0));
}

function fpuEnvironment(b: Body): F32Environment {
  const fpscr = readFpscr(b);
  const rmode = b.bitAnd(b.shiftRightUnsigned(fpscr, num(b, FPSCR_RMODE_SHIFT)), num(b, 3));

  return {
    rmode,
    fz: boolBit(b, fpscr, FPSCR_FZ),
    dn: boolBit(b, fpscr, FPSCR_DN),
  };
}

function finishFlags(b: Body, flags: import('@mica-js/sdk/model').Local<number>): void {
  writeFpscr(b, b.bitOr(readFpscr(b), b.getLocal(flags)));
}

function markFpuActive(b: Body): void {
  writeWordAt(b, FPU_MEMORY, FPU_ACTIVE, num(b, 1));
}

function fpuAccessEnabled(b: Body): Value<boolean> {
  const cpacr = readCpacr(b);
  const cp10 = b.bitAnd(b.shiftRightUnsigned(cpacr, num(b, 20)), num(b, 3));
  const cp11 = b.bitAnd(b.shiftRightUnsigned(cpacr, num(b, 22)), num(b, 3));

  return boolAnd(b, b.equal(types.number, cp10, num(b, 3)), b.equal(types.number, cp11, num(b, 3)));
}

/** 静态读/写 At 提示；地址未知时返回 undefined，让 memory.ts 走动态分派树。 */
function memoryAt(knownRegs: KnownRegs | undefined, rn: number, offset: number): At | undefined {
  const base = knownRegs?.[rn & 0xf];

  return base === undefined ? undefined : atAddress((base + offset) >>> 0);
}

/* ---------------- FPSCR 比较标志 ---------------- */

function writeComparisonFlags(
  b: Body,
  compare: ReturnType<typeof compareF32>,
  flags: import('@mica-js/sdk/model').Local<number>,
): void {
  const current = readFpscr(b);
  const n = compare.less;
  const z = compare.equal;
  const c = b.not(compare.less);
  const v = compare.unordered;
  const set = (value: Value<boolean>, mask: number): Value<number> =>
    b.select(
      types.number,
      value,
      (inner) => inner.constant(types.number, mask),
      (inner) => inner.constant(types.number, 0),
    );

  writeFpscr(
    b,
    b.bitOr(
      b.bitAnd(current, num(b, ~FPSCR_NZCV_MASK)),
      b.bitOr(
        b.bitOr(set(n, 0x80000000), set(z, 0x40000000)),
        b.bitOr(set(c, 0x20000000), set(v, 0x10000000)),
      ),
    ),
  );
  finishFlags(b, flags);
}

/* ---------------- 译码 ---------------- */

interface VfpInstruction {
  readonly size: 4;
  readonly cycles: number;
  readonly mayService: boolean;
  readonly dynamicMemory?: boolean;
  readonly boundaryAfter?: boolean;
  readonly terminates?: boolean;
  readonly emit: (b: Body, pc: number) => void;
}

type VfpOperation =
  | {
      readonly kind: 'vldr' | 'vstr';
      readonly double: boolean;
      readonly register: number;
      readonly base: number;
      readonly offset: number;
    }
  | {
      readonly kind: 'vldm' | 'vstm' | 'vpush' | 'vpop';
      readonly double: boolean;
      readonly first: number;
      readonly count: number;
      readonly base: number;
      readonly writeback: boolean;
    }
  | {
      readonly kind: 'vmov-core-single';
      readonly toCore: boolean;
      readonly sd: number;
      readonly rt: number;
    }
  | {
      readonly kind: 'vmov-core-double';
      readonly toCore: boolean;
      readonly dm: number;
      readonly rt: number;
      readonly rt2: number;
    }
  | { readonly kind: 'vmov-single'; readonly vd: number; readonly vm: number }
  | { readonly kind: 'vmov-imm'; readonly vd: number; readonly value: number }
  | {
      readonly kind:
        | 'vadd'
        | 'vsub'
        | 'vmul'
        | 'vnmul'
        | 'vdiv'
        | 'vmla'
        | 'vmls'
        | 'vnmla'
        | 'vnmls'
        | 'vfma'
        | 'vfms'
        | 'vfnma'
        | 'vfnms';
      readonly vd: number;
      readonly vn: number;
      readonly vm: number;
    }
  | { readonly kind: 'vabs' | 'vneg' | 'vsqrt'; readonly vd: number; readonly vm: number }
  | {
      readonly kind: 'vcmp';
      readonly vd: number;
      readonly vm: number;
      readonly zero: boolean;
      readonly signal: boolean;
    }
  | {
      readonly kind: 'vcvt-from-int' | 'vcvt-to-int';
      readonly vd: number;
      readonly vm: number;
      readonly unsigned: boolean;
    }
  | { readonly kind: 'vmrs'; readonly rt: number }
  | { readonly kind: 'vmsr'; readonly rt: number }
  | { readonly kind: 'unsupported' };

const unsupported = (): VfpOperation => ({ kind: 'unsupported' });

const vdOf = (h1: number, h2: number): number => (((h2 >>> 12) & 0xf) << 1) | ((h1 >>> 6) & 1);
const vmOf = (h2: number): number => ((h2 & 0xf) << 1) | ((h2 >>> 5) & 1);
const vnOf = (h1: number, h2: number): number => ((h1 & 0xf) << 1) | ((h2 >>> 7) & 1);

const registerListFits = (first: number, count: number, double: boolean): boolean =>
  count > 0 && first + count <= (double ? 16 : 32);

function decodeOperation(h1: number, h2: number): VfpOperation {
  // VPUSH/VPOP 是 SP 专门的 VLDM/VSTM 别名，必须先于普通 VLDM/VSTM 匹配。
  // bit6 是单精度的 D 位（S16–S31）；双精度 D16+ 不存在，必须拒绝。
  if ((h1 & 0xffbf) === 0xed2d || (h1 & 0xffbf) === 0xecbd) {
    const double = (h2 & 0x0f00) === 0x0b00;

    if (!double && (h2 & 0x0f00) !== 0x0a00) return unsupported();
    if (double && (h1 & 0x40) !== 0) return unsupported();

    const words = h2 & 0xff;

    if (words === 0 || (double && (words & 1) !== 0)) return unsupported();

    const first = double ? (h2 >>> 12) & 0xf : (((h2 >>> 12) & 0xf) << 1) | ((h1 >>> 6) & 1);
    const count = double ? words >>> 1 : words;

    if (!registerListFits(first, count, double)) return unsupported();

    return {
      kind: (h1 & 0xffbf) === 0xed2d ? 'vpush' : 'vpop',
      double,
      first,
      count,
      base: 13,
      writeback: true,
    };
  }

  // VLDR/VSTR 的 `0xED` 前缀。
  if ((h1 & 0xff00) === 0xed00) {
    const single = (h2 & 0x0f00) === 0x0a00;
    const double = (h2 & 0x0f00) === 0x0b00;

    if (!single && !double) return unsupported();
    if (double && (h1 & 0x40) !== 0) return unsupported();

    const immediate = (h2 & 0xff) * 4;
    const offset = (h1 & 0x80) !== 0 ? immediate : -immediate;
    const register = single ? (((h2 >>> 12) & 0xf) << 1) | ((h1 >>> 6) & 1) : (h2 >>> 12) & 0xf;

    return {
      kind: (h1 & 0x10) !== 0 ? 'vldr' : 'vstr',
      double,
      register,
      base: h1 & 0xf,
      offset,
    };
  }

  // 普通 VLDM/VSTM：0xEC80–0xECFF，bit4=L，bit5=W，bit6=D 高位。
  if ((h1 & 0xff80) === 0xec80) {
    const single = (h2 & 0x0f00) === 0x0a00;
    const double = (h2 & 0x0f00) === 0x0b00;

    if (!single && !double) return unsupported();
    if ((h1 & 0xf) === 15) return unsupported();
    if (double && (h1 & 0x40) !== 0) return unsupported();

    const words = h2 & 0xff;

    if (words === 0 || (double && (words & 1) !== 0)) return unsupported();

    const first = single ? (((h2 >>> 12) & 0xf) << 1) | ((h1 >>> 6) & 1) : (h2 >>> 12) & 0xf;
    const count = double ? words >>> 1 : words;

    if (!registerListFits(first, count, double)) return unsupported();

    return {
      kind: (h1 & 0x10) !== 0 ? 'vldm' : 'vstm',
      double,
      first,
      count,
      base: h1 & 0xf,
      writeback: (h1 & 0x20) !== 0,
    };
  }

  // VMOV Dm, Rt, Rt2 / VMOV Rt, Rt2, Dm。
  // h1[3:0] = Rt2，h1[4] = 方向，h1[6] 不在该编码中；h2[15:12] = Rt，
  // h2[3:0] = Dm，h2[11:4] = 0b1011_0001。Rt2 不要求与 Rt 相邻。
  if ((h1 & 0xffe0) === 0xec40 && (h2 & 0x0ff0) === 0x0b10) {
    const rt = h2 >>> 12;
    const rt2 = h1 & 0xf;

    if (rt === 15 || rt2 === 15) return unsupported();

    return {
      kind: 'vmov-core-double',
      toCore: (h1 & 0x10) !== 0,
      dm: h2 & 0xf,
      rt,
      rt2,
    };
  }

  // VMOV core↔single：h2 bit4=1、低字节 0x10；h1 低 5 位是 Vd>>1 与方向位。
  if ((h1 & 0xffe0) === 0xee00 && (h2 & 0x0f7f) === 0x0a10) {
    const sd = ((h1 & 0xf) << 1) | ((h2 >>> 7) & 1);
    const rt = h2 >>> 12;

    if (rt === 15) return unsupported();

    return {
      kind: 'vmov-core-single',
      toCore: (h1 & 0x10) !== 0,
      sd,
      rt,
    };
  }

  // VMRS/VMSR FPSCR。
  if (h1 === 0xeef1 || h1 === 0xeee1) {
    if ((h2 & 0x0fff) !== 0x0a10) return unsupported();

    const rt = h2 >>> 12;

    // VMRS Rt=15 是 APSR_nzcv；VMSR 没有 PC 源形式。
    if (h1 === 0xeee1 && rt === 15) return unsupported();

    return { kind: h1 === 0xeef1 ? 'vmrs' : 'vmsr', rt };
  }

  // VMOV immediate：h1 的 bit6 是 Vd 高位，h1 低 4 位是 imm8 高半字节；
  // h2 的 bit7..4 固定为 0，低 4 位是 imm8 低半字节。
  if ((h1 & 0xffb0) === 0xeeb0 && (h2 & 0x0ff0) === 0x0a00) {
    const imm8 = ((h1 & 0xf) << 4) | (h2 & 0xf);
    const sign = imm8 >>> 7;
    const exponentNibble = (imm8 >>> 4) & 7;
    const exponent = 128 + (exponentNibble < 4 ? exponentNibble : exponentNibble - 8);
    const value = ((sign << 31) | (exponent << 23) | ((imm8 & 0xf) << 19)) >>> 0;

    return { kind: 'vmov-imm', vd: vdOf(h1, h2), value };
  }

  // VMOV/VABS：0xEEB0/0xEEF0；h2 bit7 区分，h2 bit6 固定 1。
  if ((h1 & 0xffbf) === 0xeeb0 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    const vd = vdOf(h1, h2);
    const vm = vmOf(h2);

    return (h2 & 0x80) !== 0 ? { kind: 'vabs', vd, vm } : { kind: 'vmov-single', vd, vm };
  }

  // VNEG/VSQRT：0xEEB1/0xEEF1；h2 bit7 区分，h2 bit6 固定 1。
  if ((h1 & 0xffbf) === 0xeeb1 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    const vd = vdOf(h1, h2);
    const vm = vmOf(h2);

    return (h2 & 0x80) !== 0 ? { kind: 'vsqrt', vd, vm } : { kind: 'vneg', vd, vm };
  }

  // VCMP/VCMPE 寄存器形式。
  if ((h1 & 0xffbf) === 0xeeb4 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    return {
      kind: 'vcmp',
      vd: vdOf(h1, h2),
      vm: vmOf(h2),
      zero: false,
      signal: (h2 & 0x80) !== 0,
    };
  }

  // VCMP/VCMPE #0。
  if ((h1 & 0xffbf) === 0xeeb5 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    return {
      kind: 'vcmp',
      vd: vdOf(h1, h2),
      vm: 0,
      zero: true,
      signal: (h2 & 0x80) !== 0,
    };
  }

  // VCVT.F32.{S32,U32}：0xEEB8/0xEEF8，h2 bit7 区分 signed。
  if ((h1 & 0xffbf) === 0xeeb8 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    return {
      kind: 'vcvt-from-int',
      vd: vdOf(h1, h2),
      vm: vmOf(h2),
      unsigned: (h2 & 0x80) === 0,
    };
  }

  // VCVT.{S32,U32}.F32：0xEEBC/0xEEBD，h1 最低位区分 signed。
  if ((h1 & 0xffbe) === 0xeebc && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x40) !== 0) {
    return {
      kind: 'vcvt-to-int',
      vd: vdOf(h1, h2),
      vm: vmOf(h2),
      unsigned: (h1 & 1) === 0,
    };
  }

  // VFP data-processing：h1 的 bit6 是 D 高位，不能用固定 opcode 匹配。
  if ((h1 & 0xff00) === 0xee00 && (h2 & 0x0f00) === 0x0a00 && (h2 & 0x10) === 0) {
    const opcode = h1 & 0xb0;
    const variant = (h2 & 0x40) !== 0;
    const vd = vdOf(h1, h2);
    const vn = vnOf(h1, h2);
    const vm = vmOf(h2);

    switch (opcode) {
      case 0x00:
        return { kind: variant ? 'vmls' : 'vmla', vd, vn, vm };
      case 0x10:
        return { kind: variant ? 'vnmla' : 'vnmls', vd, vn, vm };
      case 0x20:
        return { kind: variant ? 'vnmul' : 'vmul', vd, vn, vm };
      case 0x30:
        return { kind: variant ? 'vsub' : 'vadd', vd, vn, vm };
      case 0x80:
        return variant ? unsupported() : { kind: 'vdiv', vd, vn, vm };
      // VFMA/VFMS/VFNMA/VFNMS 是融合乘加，无法用两次 f32 舍入准确表达；
      // 不静默近似，按未实现编码显式 fault。VMLA/VMLS 仍按 ARM 的非融合语义实现。
      case 0x90:
      case 0xa0:
      default:
        return unsupported();
    }
  }

  return unsupported();
}

function cyclesOf(operation: VfpOperation): number {
  switch (operation.kind) {
    case 'vadd':
    case 'vsub':
    case 'vmul':
    case 'vnmul':
    case 'vmla':
    case 'vmls':
    case 'vnmla':
    case 'vnmls':
    case 'vfma':
    case 'vfms':
    case 'vfnma':
    case 'vfnms':
      return 3;
    case 'vdiv':
    case 'vsqrt':
      return 14;
    case 'vldm':
    case 'vstm':
    case 'vpush':
    case 'vpop':
      return 1 + operation.count * (operation.double ? 2 : 1);
    case 'vldr':
    case 'vstr':
    case 'vmov-core-double':
      return 2;
    case 'unsupported':
      return 1;
    default:
      return 1;
  }
}

function isMemoryOperation(operation: VfpOperation): boolean {
  return (
    operation.kind === 'vldr' ||
    operation.kind === 'vstr' ||
    operation.kind === 'vldm' ||
    operation.kind === 'vstm' ||
    operation.kind === 'vpush' ||
    operation.kind === 'vpop'
  );
}

/* ---------------- emit 辅助 ---------------- */

function readD(b: Body, index: number): { low: Value<number>; high: Value<number> } {
  return {
    low: readSRegister(b, index * 2),
    high: readSRegister(b, index * 2 + 1),
  };
}

function writeD(b: Body, index: number, low: Value<number>, high: Value<number>): void {
  writeSRegister(b, index * 2, low);
  writeSRegister(b, index * 2 + 1, high);
}

function memoryAddress(
  b: Body,
  operation: { readonly base: number; readonly offset: number },
  pc: number,
): Value<number> {
  if (operation.base === 15) return num(b, (((pc + 4) & ~3) + operation.offset) >>> 0);

  return b.add(readReg(b, operation.base), num(b, operation.offset));
}

function staticAddress(
  operation: { readonly base: number; readonly offset: number },
  knownRegs: KnownRegs | undefined,
  pc: number,
): At | undefined {
  if (operation.base === 15) return atAddress((((pc + 4) & ~3) + operation.offset) >>> 0);

  return memoryAt(knownRegs, operation.base, operation.offset);
}

function emitLoadStore(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vldr' | 'vstr' }>,
  pc: number,
  knownRegs: KnownRegs | undefined,
): void {
  const address = memoryAddress(b, operation, pc);
  const at = staticAddress(operation, knownRegs, pc);

  if (operation.kind === 'vldr') {
    if (!operation.double) {
      writeSRegister(b, operation.register, readMemory(b, address, 4, false, at));

      return;
    }

    const low = readMemory(b, address, 4, false, at);
    const high = readMemory(
      b,
      b.add(address, num(b, 4)),
      4,
      false,
      at?.address === undefined ? undefined : atAddress((at.address + 4) >>> 0),
    );

    writeD(b, operation.register, low, high);

    return;
  }

  const low = operation.double
    ? readSRegister(b, operation.register * 2)
    : readSRegister(b, operation.register);
  const high = operation.double ? readSRegister(b, operation.register * 2 + 1) : undefined;

  writeMemory(b, address, 4, low, false, at);
  if (high !== undefined)
    writeMemory(
      b,
      b.add(address, num(b, 4)),
      4,
      high,
      false,
      at?.address === undefined ? undefined : atAddress((at.address + 4) >>> 0),
    );
}

function emitLoadMultiple(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vldm' | 'vstm' | 'vpush' | 'vpop' }>,
  knownRegs: KnownRegs | undefined,
): void {
  const words = operation.count * (operation.double ? 2 : 1);
  const bytes = words * 4;
  const isPush = operation.kind === 'vpush';
  const isPop = operation.kind === 'vpop';
  const load = operation.kind === 'vldm' || isPop;
  const baseValue = isPush
    ? b.subtract(readSp(b), num(b, bytes))
    : isPush || isPop
      ? readSp(b)
      : readReg(b, operation.base);
  const baseKnown = isPush || isPop ? undefined : knownRegs?.[operation.base & 0xf];

  for (let index = 0; index < operation.count; index += 1) {
    const offset = index * (operation.double ? 8 : 4);
    const address = b.add(baseValue, num(b, offset));
    const at =
      isPush || isPop
        ? atSram()
        : baseKnown === undefined
          ? undefined
          : atAddress((baseKnown + offset) >>> 0);

    if (operation.double) {
      if (load) {
        const low = readMemory(b, address, 4, false, at);
        const high = readMemory(
          b,
          b.add(address, num(b, 4)),
          4,
          false,
          at?.address === undefined ? undefined : atAddress((at.address + 4) >>> 0),
        );

        writeD(b, operation.first + index, low, high);
      } else {
        writeMemory(b, address, 4, readSRegister(b, operation.first * 2 + index * 2), false, at);
        writeMemory(
          b,
          b.add(address, num(b, 4)),
          4,
          readSRegister(b, operation.first * 2 + index * 2 + 1),
          false,
          at?.address === undefined ? undefined : atAddress((at.address + 4) >>> 0),
        );
      }
    } else if (load) {
      writeSRegister(b, operation.first + index, readMemory(b, address, 4, false, at));
    } else {
      writeMemory(b, address, 4, readSRegister(b, operation.first + index), false, at);
    }
  }

  if (isPush) writeSp(b, b.subtract(readSp(b), num(b, bytes)));
  else if (isPop) writeSp(b, b.add(readSp(b), num(b, bytes)));
  else if (operation.writeback) {
    const next = b.add(baseValue, num(b, bytes));

    if (operation.base !== 13) writeReg(b, operation.base, next);
    else writeSp(b, next);
  }
}

function emitTransfer(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vmov-core-single' | 'vmov-core-double' }>,
): void {
  if (operation.kind === 'vmov-core-single') {
    if (operation.toCore) writeReg(b, operation.rt, readSRegister(b, operation.sd));
    else writeSRegister(b, operation.sd, readReg(b, operation.rt));

    return;
  }

  if (operation.toCore) {
    const value = readD(b, operation.dm);

    writeReg(b, operation.rt, value.low);
    writeReg(b, operation.rt2, value.high);
  } else {
    writeD(b, operation.dm, readReg(b, operation.rt), readReg(b, operation.rt2));
  }
}

function emitDataProcessing(
  b: Body,
  operation: Extract<
    VfpOperation,
    {
      kind:
        | 'vadd'
        | 'vsub'
        | 'vmul'
        | 'vnmul'
        | 'vdiv'
        | 'vmla'
        | 'vmls'
        | 'vnmla'
        | 'vnmls'
        | 'vfma'
        | 'vfms'
        | 'vfnma'
        | 'vfnms';
    }
  >,
  env: F32Environment,
  flags: import('@mica-js/sdk/model').Local<number>,
): void {
  const left = readSRegister(b, operation.vn);
  const right = readSRegister(b, operation.vm);
  let result: Value<number>;

  switch (operation.kind) {
    case 'vadd':
      result = addF32(b, left, right, false, env, flags);
      break;
    case 'vsub':
      result = subF32(b, left, right, env, flags);
      break;
    case 'vmul':
      result = mulF32(b, left, right, false, env, flags);
      break;
    case 'vnmul':
      result = mulF32(b, left, right, true, env, flags);
      break;
    case 'vdiv':
      result = divF32(b, left, right, env, flags);
      break;
    case 'vmla':
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, false, env, flags),
        false,
        env,
        flags,
      );
      break;
    case 'vmls':
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, false, env, flags),
        true,
        env,
        flags,
      );
      break;
    case 'vnmla':
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, true, env, flags),
        false,
        env,
        flags,
      );
      break;
    case 'vnmls':
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, true, env, flags),
        true,
        env,
        flags,
      );
      break;
    case 'vfma':
    case 'vfms':
      // FPv4-SP 的 fused 语义在 f32 上与本实现的两步乘加不同；M4F 不提供
      // 额外的 f32 精度，这里按“先乘后加”实现并在文档中注明非融合。
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, false, env, flags),
        operation.kind === 'vfms',
        env,
        flags,
      );
      break;
    case 'vfnma':
    case 'vfnms':
      result = addF32(
        b,
        readSRegister(b, operation.vd),
        mulF32(b, left, right, true, env, flags),
        operation.kind === 'vfnms',
        env,
        flags,
      );
      break;
  }

  writeSRegister(b, operation.vd, result);
}

function emitUnary(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vabs' | 'vneg' | 'vsqrt' }>,
  env: F32Environment,
  flags: import('@mica-js/sdk/model').Local<number>,
): void {
  const source = readSRegister(b, operation.vm);
  const result =
    operation.kind === 'vabs'
      ? absF32(b, source, flags)
      : operation.kind === 'vneg'
        ? negF32(b, source, flags)
        : sqrtF32(b, source, env, flags);

  writeSRegister(b, operation.vd, result);
}

function compareParts(
  b: Body,
  left: Value<number>,
  right: Value<number>,
): {
  readonly result: ReturnType<typeof compareF32>;
  readonly left: F32Parts;
  readonly right: F32Parts;
} {
  return {
    result: compareF32(b, left, right),
    left: decodeF32(b, left),
    right: decodeF32(b, right),
  };
}

function emitCompare(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vcmp' }>,
  env: F32Environment,
  flags: import('@mica-js/sdk/model').Local<number>,
): void {
  const leftSource = readSRegister(b, operation.vd);
  const rightSource = operation.zero ? num(b, 0) : readSRegister(b, operation.vm);
  const left = flushInput(b, decodeF32(b, leftSource), env.fz, flags);
  const right = flushInput(b, decodeF32(b, rightSource), env.fz, flags);
  const compare = compareParts(b, left, right);
  const invalid = operation.signal
    ? boolOr(b, compare.left.isNaN, compare.right.isNaN)
    : boolOr(b, compare.left.isSignalingNaN, compare.right.isSignalingNaN);

  b.if(invalid, (body) => raiseFlag(asBody(body), flags, FPSCR_IOC));
  writeComparisonFlags(b, compare.result, flags);
}

function emitConvert(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vcvt-from-int' | 'vcvt-to-int' }>,
  env: F32Environment,
  flags: import('@mica-js/sdk/model').Local<number>,
): void {
  if (operation.kind === 'vcvt-from-int') {
    const source = readSRegister(b, operation.vm);
    const parts = operation.unsigned
      ? fromUnsignedInteger(b, source)
      : fromSignedInteger(b, source);
    const result = packF32(b, parts.magnitude, parts.exponent, parts.sign, env, flags);

    writeSRegister(b, operation.vd, result);

    return;
  }

  const source = readSRegister(b, operation.vm);
  const adjusted = flushInput(b, decodeF32(b, source), env.fz, flags);
  const conversion = toInteger(b, adjusted, operation.unsigned, env);

  b.if(conversion.invalid, (body) => raiseFlag(asBody(body), flags, FPSCR_IOC));
  b.if(conversion.inexact, (body) => raiseFlag(asBody(body), flags, FPSCR_IXC));
  writeSRegister(b, operation.vd, conversion.value);
}

function emitFpscrTransfer(
  b: Body,
  operation: Extract<VfpOperation, { kind: 'vmrs' | 'vmsr' }>,
): void {
  if (operation.kind === 'vmsr') {
    writeFpscr(b, readReg(b, operation.rt));

    return;
  }

  const fpscr = readFpscr(b);

  if (operation.rt === 15) {
    writeNzcv(
      b,
      boolBit(b, fpscr, 0x80000000),
      boolBit(b, fpscr, 0x40000000),
      boolBit(b, fpscr, 0x20000000),
      boolBit(b, fpscr, 0x10000000),
    );

    return;
  }

  writeReg(b, operation.rt, fpscr);
}

function emitOperation(
  b: Body,
  operation: VfpOperation,
  pc: number,
  knownRegs: KnownRegs | undefined,
): void {
  if (operation.kind === 'unsupported') {
    halt(b, pc, FPU_NOCP_FAULT);

    return;
  }

  markFpuActive(b);

  const env = fpuEnvironment(b);
  const flags = b.local(types.number, num(b, 0));

  switch (operation.kind) {
    case 'vldr':
    case 'vstr':
      emitLoadStore(b, operation, pc, knownRegs);
      break;
    case 'vldm':
    case 'vstm':
    case 'vpush':
    case 'vpop':
      emitLoadMultiple(b, operation, knownRegs);
      break;
    case 'vmov-core-single':
    case 'vmov-core-double':
      emitTransfer(b, operation);
      break;
    case 'vmov-single':
      writeSRegister(b, operation.vd, readSRegister(b, operation.vm));
      break;
    case 'vmov-imm':
      writeSRegister(b, operation.vd, num(b, operation.value));
      break;
    case 'vabs':
    case 'vneg':
    case 'vsqrt':
      emitUnary(b, operation, env, flags);
      break;
    case 'vcmp':
      emitCompare(b, operation, env, flags);
      break;
    case 'vcvt-from-int':
    case 'vcvt-to-int':
      emitConvert(b, operation, env, flags);
      break;
    case 'vmrs':
    case 'vmsr':
      emitFpscrTransfer(b, operation);
      break;
    default:
      emitDataProcessing(b, operation, env, flags);
      break;
  }

  finishFlags(b, flags);
}

/* ---------------- 异常帧钩子 ---------------- */

/* ---------------- 对外译码入口 ---------------- */

export function decodeVfp32(
  h1: number,
  h2: number,
  pc = 0,
  code?: CodeBytes,
  firmwareLength = code?.byteLength ?? 0,
  knownRegs?: KnownRegs,
): VfpInstruction {
  void code;
  void firmwareLength;
  void pc;
  const operation = decodeOperation(h1, h2);
  const memory = isMemoryOperation(operation);
  let dynamicMemory = false;

  if (memory) {
    if (operation.kind === 'vpush' || operation.kind === 'vpop') dynamicMemory = true;
    else if (operation.kind === 'vldm' || operation.kind === 'vstm')
      dynamicMemory = knownRegs?.[operation.base] === undefined;
    else if (operation.kind === 'vldr' || operation.kind === 'vstr')
      dynamicMemory = operation.base !== 15 && knownRegs?.[operation.base] === undefined;
  }

  return {
    size: 4,
    cycles: cyclesOf(operation),
    // VFP 指令都可能因 CPACR 触发 NOCP；边界收块让异常及时服务。
    mayService: true,
    ...(dynamicMemory ? { dynamicMemory: true } : {}),
    ...(operation.kind === 'unsupported' ? { terminates: true } : { boundaryAfter: true }),
    emit: (b, currentPc) => {
      b.if(
        fpuAccessEnabled(b),
        (enabled) => emitOperation(asBody(enabled), operation, currentPc, knownRegs),
        (disabled) => {
          const body = asBody(disabled);

          // NOCP 是同步 UsageFault：异常返回地址必须指回本条指令。
          body.writeState('pc', num(body, currentPc));
          requestUsageFault(body, true);
        },
      );
    },
  };
}

/** 给测试/诊断用的分类名称；只覆盖已实现的常用 VFP 指令。 */
export function vfpMnemonic(h1: number, h2: number): string | undefined {
  const operation = decodeOperation(h1, h2);

  switch (operation.kind) {
    case 'vldr':
      return operation.double ? 'vldr.64' : 'vldr.32';
    case 'vstr':
      return operation.double ? 'vstr.64' : 'vstr.32';
    case 'vldm':
      return 'vldm/vldmia';
    case 'vstm':
      return 'vstm/vstmia';
    case 'vpush':
      return 'vpush';
    case 'vpop':
      return 'vpop';
    case 'vmov-core-single':
      return 'vmov core,s';
    case 'vmov-core-double':
      return 'vmov core,d';
    case 'vmov-single':
      return 'vmov s,s';
    case 'vmov-imm':
      return 'vmov #imm';
    case 'vabs':
      return 'vabs';
    case 'vneg':
      return 'vneg';
    case 'vsqrt':
      return 'vsqrt';
    case 'vcmp':
      return operation.signal ? 'vcmpe' : 'vcmp';
    case 'vcvt-from-int':
      return 'vcvt.f32.int';
    case 'vcvt-to-int':
      return 'vcvt.int.f32';
    case 'vmrs':
      return 'vmrs';
    case 'vmsr':
      return 'vmsr';
    case 'unsupported':
      return (h1 & 0xfe00) === 0xec00 ? 'vfp/coprocessor' : 'vfp';
    default:
      return operation.kind;
  }
}

export { FPSCR_DN, FPSCR_FZ, FPSCR_IOC, FPSCR_IXC };
