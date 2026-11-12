import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { APSR_C, APSR_N, APSR_V, APSR_Z } from './layout';
import {
  asBody,
  boolAnd,
  boolBit,
  conditionHolds,
  num,
  readReg,
  setPc,
  signExtend,
  writeReg,
  u32,
} from './ir';
import type { Body } from './ir';
import { readMemory, writeMemory } from './memory';

/** 读取通用寄存器；R15 返回当前指令地址 + 4（Thumb 约定）。 */
export const readAnyReg = (b: Body, index: number, pc: number): Value<number> =>
  index === 15 ? num(b, (pc + 4) >>> 0) : readReg(b, index);

/** 写通用寄存器；写 R15 等价于跳转。 */
export const writeAnyReg = (b: Body, index: number, value: Value<number>): void => {
  if (index === 15) setPc(b, value);
  else writeReg(b, index, value);
};

export function loadRegister(
  b: Body,
  target: number,
  address: Value<number>,
  size: number,
  pc: number,
  signed = false,
): void {
  const raw = readMemory(b, address, size);
  const value = signed ? signExtend(b, raw, size * 8) : raw;

  writeAnyReg(b, target, value);
}

export function storeRegister(
  b: Body,
  source: number,
  address: Value<number>,
  size: number,
  pc: number,
): void {
  writeMemory(b, address, size, readAnyReg(b, source, pc));
}

export const mul = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  b.multiply(left, right);

export const align4 = (value: number): number => value & ~3;

/** 静态条件执行：条件成立时执行分支体。 */
export const conditional = (b: Body, condition: number, emit: (body: Body) => void): void => {
  if (condition >= 14) {
    emit(b);

    return;
  }

  b.if(conditionHolds(b, condition), (inner) => emit(asBody(inner)));
};

/**
 * 动态条件（IT 块）：把条件号映射为当前标志的组合。
 *
 * 条件码的 `bit0` 表示取反、`bit3..1` 选中 8 个基条件之一，因此只需要一条 7 深的条件
 * 选择链加一次取反，而不是 14 个逐值比较——后者会给每个 IT 条件展开 14 个 `select`
 * 块，是指令块 IR 体积的主要来源。`cond = 14/15`（AL/NV）不能编码进 IT 块，不处理。
 */
export function conditionValue(b: Body, condition: Value<number>): Value<boolean> {
  const apsr = b.readState('apsr', types.number);
  const z = boolBit(b, apsr, APSR_Z);
  const c = boolBit(b, apsr, APSR_C);
  const n = boolBit(b, apsr, APSR_N);
  const v = boolBit(b, apsr, APSR_V);
  const nEqualsV = b.equal(types.bool, n, v);
  const notZ = b.not(z);
  // 下标是条件码的 bit3..1：EQ / CS / MI / VS / HI / GE / GT / 未使用。
  const bases: readonly Value<boolean>[] = [
    z,
    c,
    n,
    v,
    boolAnd(b, c, notZ),
    nEqualsV,
    boolAnd(b, notZ, nEqualsV),
    b.constant(types.bool, true),
  ];
  const base = b.bitAnd(b.shiftRightUnsigned(condition, num(b, 1)), num(b, 7));
  let selected = bases[7]!;

  for (let index = 6; index >= 0; index -= 1)
    selected = b.select(
      types.bool,
      b.equal(types.number, base, num(b, index)),
      () => bases[index]!,
      () => selected,
    );

  return b.select(
    types.bool,
    boolBit(b, condition, 1),
    (inner) => inner.not(selected),
    () => selected,
  );
}

/** 32 位值的二进制补码取负。 */
export const negate = (b: Body, value: Value<number>): Value<number> =>
  u32(b, b.subtract(num(b, 0), value));
