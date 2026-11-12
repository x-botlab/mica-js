import { types } from '@mica-js/sdk/model';
import type { JitInstructionBuilder, Value } from '@mica-js/sdk/model';
import { APSR_C, APSR_N, APSR_T, APSR_V, APSR_Z, LR_STATE, SP_STATE, regState } from './layout';

export type Body = JitInstructionBuilder;

/** 惰性分支回调拿到的是更窄的计算视图；内核辅助只需要两者共有的取值与控制流能力。 */
export const asBody = (compute: unknown): Body => compute as Body;

export const num = (b: Body, value: number): Value<number> => b.constant(types.number, value);
export const bool = (b: Body, value: boolean): Value<boolean> => b.constant(types.bool, value);

/** 32 位无符号回绕（JavaScript ToUint32）。 */
export const u32 = (b: Body, value: Value<number>): Value<number> =>
  b.shiftRightUnsigned(value, num(b, 0));

/** 32 位有符号解释；用于算术右移和无符号比较之外的场合。 */
export const s32 = (b: Body, value: Value<number>): Value<number> => b.bitOr(value, num(b, 0));

const LOW = (b: Body, value: Value<number>, bits: number): Value<number> => {
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;

  return b.bitAnd(value, num(b, mask));
};

export const u8 = (b: Body, value: Value<number>): Value<number> => LOW(b, value, 8);
export const u16 = (b: Body, value: Value<number>): Value<number> => LOW(b, value, 16);

/**
 * 布尔与/或。direct 后端只编译 `if`/`select`，惰性 `and`/`or` 会让整块回退解释路径，
 * 因此统一用 `select` 表达（两侧求值都是纯的，提前求值没有副作用）。
 */
export const boolAnd = (b: Body, left: Value<boolean>, right: Value<boolean>): Value<boolean> =>
  b.select(
    types.bool,
    left,
    () => right,
    (inner) => inner.constant(types.bool, false),
  );

export const boolOr = (b: Body, left: Value<boolean>, right: Value<boolean>): Value<boolean> =>
  b.select(
    types.bool,
    left,
    (inner) => inner.constant(types.bool, true),
    () => right,
  );

export const boolBit = (b: Body, value: Value<number>, mask: number): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(value, num(b, mask)), num(b, 0));

/** 按位号取布尔值（`index` 是 0 起的位号，不是掩码）。 */
export const boolBitAt = (b: Body, value: Value<number>, index: number): Value<boolean> =>
  boolBit(b, value, 1 << index);

/*
 * 32/16 位访存一律拆成 8 位访问：direct 后端只接受 `load8`/`store8`，`load32le` 之类
 * 会让整块回退解释路径。语义与小端字访问一致（未对齐访问仍按字节序）。
 */

export const readByte = (b: Body, memory: string, offset: Value<number>): Value<number> =>
  b.load8(memory, offset);

export const writeByte = (
  b: Body,
  memory: string,
  offset: Value<number>,
  value: Value<number>,
): void => {
  b.store8(memory, offset, b.bitAnd(u32(b, value), num(b, 0xff)));
};

/** 读 32 位小端字；`offset` 运行期求值。 */
export function readWord(b: Body, memory: string, offset: Value<number>): Value<number> {
  const b0 = b.load8(memory, offset);
  const b1 = b.load8(memory, b.add(offset, num(b, 1)));
  const b2 = b.load8(memory, b.add(offset, num(b, 2)));
  const b3 = b.load8(memory, b.add(offset, num(b, 3)));

  return u32(
    b,
    b.bitOr(
      b.bitOr(b0, b.shiftLeft(b1, num(b, 8))),
      b.bitOr(b.shiftLeft(b2, num(b, 16)), b.shiftLeft(b3, num(b, 24))),
    ),
  );
}

/** 读常量偏移的 32 位小端字（外设寄存器）。 */
export function readWordAt(b: Body, memory: string, offset: number): Value<number> {
  return u32(
    b,
    b.bitOr(
      b.bitOr(
        b.load8(memory, num(b, offset)),
        b.shiftLeft(b.load8(memory, num(b, offset + 1)), num(b, 8)),
      ),
      b.bitOr(
        b.shiftLeft(b.load8(memory, num(b, offset + 2)), num(b, 16)),
        b.shiftLeft(b.load8(memory, num(b, offset + 3)), num(b, 24)),
      ),
    ),
  );
}

/** 写 32 位小端字；`offset` 运行期求值。 */
export function writeWord(
  b: Body,
  memory: string,
  offset: Value<number>,
  value: Value<number>,
): void {
  const word = u32(b, value);

  b.store8(memory, offset, b.bitAnd(word, num(b, 0xff)));
  b.store8(
    memory,
    b.add(offset, num(b, 1)),
    b.bitAnd(b.shiftRightUnsigned(word, num(b, 8)), num(b, 0xff)),
  );
  b.store8(
    memory,
    b.add(offset, num(b, 2)),
    b.bitAnd(b.shiftRightUnsigned(word, num(b, 16)), num(b, 0xff)),
  );
  b.store8(memory, b.add(offset, num(b, 3)), b.shiftRightUnsigned(word, num(b, 24)));
}

/** 写常量偏移的 32 位小端字（外设寄存器）。 */
export function writeWordAt(b: Body, memory: string, offset: number, value: Value<number>): void {
  const word = u32(b, value);

  b.store8(memory, num(b, offset), b.bitAnd(word, num(b, 0xff)));
  b.store8(
    memory,
    num(b, offset + 1),
    b.bitAnd(b.shiftRightUnsigned(word, num(b, 8)), num(b, 0xff)),
  );
  b.store8(
    memory,
    num(b, offset + 2),
    b.bitAnd(b.shiftRightUnsigned(word, num(b, 16)), num(b, 0xff)),
  );
  b.store8(memory, num(b, offset + 3), b.shiftRightUnsigned(word, num(b, 24)));
}

export function readHalf(b: Body, memory: string, offset: Value<number>): Value<number> {
  const low = b.load8(memory, offset);
  const high = b.load8(memory, b.add(offset, num(b, 1)));

  return b.bitOr(low, b.shiftLeft(high, num(b, 8)));
}

export function writeHalf(
  b: Body,
  memory: string,
  offset: Value<number>,
  value: Value<number>,
): void {
  const half = b.bitAnd(u32(b, value), num(b, 0xffff));

  b.store8(memory, offset, b.bitAnd(half, num(b, 0xff)));
  b.store8(memory, b.add(offset, num(b, 1)), b.shiftRightUnsigned(half, num(b, 8)));
}

export const readReg = (b: Body, index: number): Value<number> =>
  b.readState(regState(index), types.number);

export const writeReg = (b: Body, index: number, value: Value<number>): void => {
  b.writeState(regState(index), u32(b, value));
};

export const readSp = (b: Body): Value<number> => b.readState(SP_STATE, types.number);
export const writeSp = (b: Body, value: Value<number>): void => {
  b.writeState(SP_STATE, u32(b, value));
};
export const readLr = (b: Body): Value<number> => b.readState(LR_STATE, types.number);
export const writeLr = (b: Body, value: Value<number>): void => {
  b.writeState(LR_STATE, u32(b, value));
};

export const readApsr = (b: Body): Value<number> => b.readState('apsr', types.number);

/** 条件成立时取 `mask` 位，否则取 0。 */
const flagValue = (b: Body, set: Value<boolean>, mask: number): Value<number> =>
  b.select(
    types.number,
    set,
    (inner) => inner.constant(types.number, mask),
    (inner) => inner.constant(types.number, 0),
  );

/** 写入 N/Z/C/V；同一条指令内的四个标志共用一次 APSR 读改写。 */
export function writeNzcv(
  b: Body,
  n: Value<boolean>,
  z: Value<boolean>,
  c: Value<boolean>,
  v: Value<boolean>,
): void {
  const cleared = b.bitAnd(readApsr(b), num(b, 0x0fffffff));
  const flags = b.bitOr(
    b.bitOr(flagValue(b, n, APSR_N), flagValue(b, z, APSR_Z)),
    b.bitOr(flagValue(b, c, APSR_C), flagValue(b, v, APSR_V)),
  );

  b.writeState('apsr', b.bitOr(b.bitOr(cleared, flags), num(b, APSR_T)));
}

/** 逻辑运算只更新 N/Z，保留 C/V（ARM 对 AND/ORR/EOR/BIC/MOV 的约定）。 */
export function writeNz(b: Body, n: Value<boolean>, z: Value<boolean>): void {
  const cleared = b.bitAnd(readApsr(b), num(b, 0x3fffffff));
  const flags = b.bitOr(flagValue(b, n, APSR_N), flagValue(b, z, APSR_Z));

  b.writeState('apsr', b.bitOr(b.bitOr(cleared, flags), num(b, APSR_T)));
}

/** 移位类指令更新 N/Z/C，保留 V。 */
export function writeNzc(b: Body, n: Value<boolean>, z: Value<boolean>, c: Value<boolean>): void {
  const cleared = b.bitAnd(readApsr(b), num(b, 0x1fffffff));
  const flags = b.bitOr(
    b.bitOr(flagValue(b, n, APSR_N), flagValue(b, z, APSR_Z)),
    flagValue(b, c, APSR_C),
  );

  b.writeState('apsr', b.bitOr(b.bitOr(cleared, flags), num(b, APSR_T)));
}

export const flag = (b: Body, mask: number): Value<boolean> => boolBit(b, readApsr(b), mask);

export const signIsSet = (b: Body, result: Value<number>): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(result, num(b, APSR_N)), num(b, 0));

export const isZero = (b: Body, result: Value<number>): Value<boolean> =>
  b.equal(types.number, u32(b, result), num(b, 0));

/** 带进位加法：a、b 与 carryIn 都是 32 位无符号值，返回回绕后的结果。 */
export const addRaw = (
  b: Body,
  left: Value<number>,
  right: Value<number>,
  carryIn: Value<number>,
): Value<number> => u32(b, b.add(b.add(left, right), carryIn));

export const subRaw = (
  b: Body,
  left: Value<number>,
  right: Value<number>,
  borrowIn: Value<number>,
): Value<number> => u32(b, b.subtract(b.subtract(left, right), borrowIn));

/** 无标志位移，供 32 位数据处理的主运算先取操作数。 */
export function shiftRaw(
  b: Body,
  value: Value<number>,
  amount: Value<number>,
  type: number,
): Value<number> {
  const src = u32(b, value);

  if (type === 0) return u32(b, b.shiftLeft(src, amount));
  if (type === 1) return b.shiftRightUnsigned(src, amount);
  if (type === 2) return u32(b, b.shiftRight(s32(b, src), amount));

  return u32(
    b,
    b.bitOr(b.shiftRightUnsigned(src, amount), b.shiftLeft(src, b.subtract(num(b, 32), amount))),
  );
}

/** `width` 位的低位掩码；width=32 时返回全 1。 */
export function maskWidth(b: Body, width: Value<number>): Value<number> {
  const shifted = b.subtract(b.shiftLeft(num(b, 1), width), num(b, 1));
  const all = b.constant(types.number, 0xffffffff);

  return b.select(
    types.number,
    b.equal(types.number, width, num(b, 32)),
    () => all,
    () => shifted,
  );
}

export function addWithCarry(
  b: Body,
  left: Value<number>,
  right: Value<number>,
  carryIn: Value<number>,
): Value<number> {
  const sum = b.add(b.add(left, right), carryIn);
  const result = u32(b, sum);
  const carry = b.greaterThan(sum, num(b, 0xffffffff));
  const overflow = b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(b.bitXor(left, result), b.bitXor(right, result)), num(b, APSR_N)),
    num(b, 0),
  );

  writeNzcv(b, signIsSet(b, result), isZero(b, result), carry, overflow);

  return result;
}

/** 带借位减法；C 表示「无借位」。 */
export function subtractWithCarry(
  b: Body,
  left: Value<number>,
  right: Value<number>,
  borrowIn: Value<number>,
): Value<number> {
  const diff = b.subtract(b.subtract(left, right), borrowIn);
  const result = u32(b, diff);
  const carry = b.greaterThanOrEqual(left, b.add(right, borrowIn));
  const overflow = b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(b.bitXor(left, result), b.bitXor(right, result)), num(b, APSR_N)),
    num(b, 0),
  );

  writeNzcv(b, signIsSet(b, result), isZero(b, result), carry, overflow);

  return result;
}

export function conditionHolds(b: Body, condition: number): Value<boolean> {
  const apsr = readApsr(b);
  const z = boolBit(b, apsr, APSR_Z);
  const c = boolBit(b, apsr, APSR_C);
  const n = boolBit(b, apsr, APSR_N);
  const v = boolBit(b, apsr, APSR_V);

  switch (condition & 0xf) {
    case 0x0:
      return z;
    case 0x1:
      return b.not(z);
    case 0x2:
      return c;
    case 0x3:
      return b.not(c);
    case 0x4:
      return n;
    case 0x5:
      return b.not(n);
    case 0x6:
      return v;
    case 0x7:
      return b.not(v);
    case 0x8:
      return boolAnd(b, c, b.not(z));
    case 0x9:
      return boolOr(b, b.not(c), z);
    case 0xa:
      return b.equal(types.bool, n, v);
    case 0xb:
      return b.notEqual(types.bool, n, v);
    case 0xc:
      return boolAnd(b, b.not(z), b.equal(types.bool, n, v));
    case 0xd:
      return boolOr(b, z, b.notEqual(types.bool, n, v));
    default:
      return bool(b, true);
  }
}

/** 条件为真时执行；用于条件分支与 IT 块。 */
export const when = (b: Body, condition: Value<boolean>, emit: (body: Body) => void): void => {
  b.if(condition, (inner) => emit(asBody(inner)));
};

export const setPcConst = (b: Body, target: number): void => {
  b.writeState('pc', num(b, target & 0xfffffffe));
};

export const setPc = (b: Body, target: Value<number>): void => {
  b.writeState('pc', b.bitAnd(target, num(b, 0xfffffffe)));
};

/** 取指地址的 PC 读值：当前指令地址 + 4。 */
export const pcValue = (pc: number): number => (pc + 4) >>> 0;

/** 位段提取（LSB 为最低位）。 */
export function bitField(b: Body, value: Value<number>, lsb: number, width: number): Value<number> {
  const shifted = width >= 32 ? value : b.shiftRightUnsigned(value, num(b, lsb));

  return LOW(b, shifted, width);
}

/** 符号扩展 `width` 位。 */
export function signExtend(b: Body, value: Value<number>, width: number): Value<number> {
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  const truncated = b.bitAnd(value, num(b, mask));
  const sign = 1 << (width - 1);
  const negative = b.notEqual(types.number, b.bitAnd(truncated, num(b, sign)), num(b, 0));

  return u32(
    b,
    b.select(
      types.number,
      negative,
      (inner) => inner.bitOr(truncated, inner.constant(types.number, 0xffffffff & ~mask)),
      () => truncated,
    ),
  );
}

/** 运行时宽度的符号扩展。 */
export function signExtendDynamic(
  b: Body,
  value: Value<number>,
  width: Value<number>,
): Value<number> {
  const mask = maskWidth(b, width);
  const truncated = b.bitAnd(value, mask);
  const sign = b.shiftLeft(num(b, 1), b.subtract(width, num(b, 1)));
  const negative = b.notEqual(types.number, b.bitAnd(truncated, sign), num(b, 0));
  const extension = b.bitNot(mask);

  return u32(
    b,
    b.select(
      types.number,
      negative,
      (inner) => inner.bitOr(truncated, extension),
      () => truncated,
    ),
  );
}

/** 逻辑移位：type 0=LSL、1=LSR、2=ASR、3=ROR；返回结果并写 C/N/Z。 */
export function shiftValue(
  b: Body,
  value: Value<number>,
  amount: Value<number>,
  type: number,
): Value<number> {
  const src = u32(b, value);

  if (type === 0) {
    const result = u32(b, b.shiftLeft(src, amount));
    const carry = b.notEqual(
      types.number,
      b.bitAnd(b.shiftRightUnsigned(src, b.subtract(num(b, 32), amount)), num(b, 1)),
      num(b, 0),
    );

    writeNzc(b, signIsSet(b, result), isZero(b, result), carry);

    return result;
  }

  if (type === 1) {
    const result = b.shiftRightUnsigned(src, amount);
    const carry = b.notEqual(
      types.number,
      b.bitAnd(b.shiftRightUnsigned(src, b.subtract(amount, num(b, 1))), num(b, 1)),
      num(b, 0),
    );

    writeNzc(b, signIsSet(b, result), isZero(b, result), carry);

    return result;
  }

  if (type === 2) {
    const result = b.shiftRight(s32(b, src), amount);
    const carry = b.notEqual(
      types.number,
      b.bitAnd(b.shiftRightUnsigned(src, b.subtract(amount, num(b, 1))), num(b, 1)),
      num(b, 0),
    );

    writeNzc(b, signIsSet(b, result), isZero(b, result), carry);

    return result;
  }

  const result = b.bitOr(
    b.shiftRightUnsigned(src, amount),
    b.shiftLeft(src, b.subtract(num(b, 32), amount)),
  );
  const carry = b.notEqual(
    types.number,
    b.bitAnd(b.shiftRightUnsigned(src, b.subtract(amount, num(b, 1))), num(b, 1)),
    num(b, 0),
  );

  writeNzc(b, signIsSet(b, result), isZero(b, result), carry);

  return u32(b, result);
}
