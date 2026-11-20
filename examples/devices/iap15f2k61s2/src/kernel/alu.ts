import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  PSW_AC,
  boolean,
  byte,
  carryIs,
  carryValue,
  number,
  readAcc,
  readPsw,
  writeAcc,
  writeFlags,
} from './ir';
import type { Body } from './ir';

/** PSW 与累加器的算术数据通路：ADD/ADDC/SUBB/DA/MUL/DIV 的公共部分。 */

export const emitAdd = (
  b: Body,
  acc: Value<number>,
  operand: Value<number>,
  withCarry: boolean,
): void => {
  const carry = withCarry ? carryValue(b) : number(b, 0);
  const sum = b.add(b.add(acc, operand), carry);
  const result = byte(b, sum);
  const lowSum = b.add(
    b.add(b.bitAnd(acc, number(b, 0x0f)), b.bitAnd(operand, number(b, 0x0f))),
    carry,
  );
  const overflow = b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(b.bitXor(acc, result), b.bitXor(operand, result)), number(b, 0x80)),
    number(b, 0),
  );

  writeFlags(
    b,
    b.greaterThan(sum, number(b, 0xff)),
    b.greaterThan(lowSum, number(b, 0x0f)),
    overflow,
  );
  writeAcc(b, result);
};

export const emitSubtract = (b: Body, acc: Value<number>, operand: Value<number>): void => {
  const carry = carryValue(b);
  const subtrahend = b.add(operand, carry);
  const difference = byte(b, b.subtract(acc, subtrahend));
  const borrow = b.lessThan(acc, subtrahend);
  const lowBorrow = b.lessThan(
    b.bitAnd(acc, number(b, 0x0f)),
    b.add(b.bitAnd(operand, number(b, 0x0f)), carry),
  );
  const overflow = b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(b.bitXor(acc, operand), b.bitXor(acc, difference)), number(b, 0x80)),
    number(b, 0),
  );

  writeFlags(b, borrow, lowBorrow, overflow);
  writeAcc(b, difference);
};

export const emitAlu = (b: Body, group: number, operand: Value<number>): void => {
  const acc = readAcc(b);

  switch (group) {
    case 0x20:
      return emitAdd(b, acc, operand, false);

    case 0x30:
      return emitAdd(b, acc, operand, true);

    case 0x40:
      return writeAcc(b, b.bitOr(acc, operand));

    case 0x50:
      return writeAcc(b, b.bitAnd(acc, operand));

    case 0x60:
      return writeAcc(b, b.bitXor(acc, operand));

    case 0x90:
      return emitSubtract(b, acc, operand);

    default:
      throw new Error(`iap15f2k61s2: 未实现的 ALU 组 ${group.toString(16)}`);
  }
};

/** DA A：先行修正低半字节，再按进位或大于 99H 修正高半字节。 */
export const emitDecimalAdjust = (b: Body): void => {
  const value = readAcc(b);
  const carry = carryIs(b);
  const auxiliary = b.notEqual(types.number, b.bitAnd(readPsw(b), number(b, PSW_AC)), number(b, 0));
  const lowOverflow = b.greaterThan(b.bitAnd(value, number(b, 0x0f)), number(b, 9));
  const lowBroken = b.or(auxiliary, () => lowOverflow);
  const six = number(b, 6);
  const zero = number(b, 0);
  const lowFix = b.select(
    types.number,
    lowBroken,
    () => six,
    () => zero,
  );
  const adjusted = b.add(value, lowFix);
  const wrapped = b.lessThan(adjusted, value);
  const carried = b.or(carry, () => wrapped);
  const highOverflow = b.greaterThan(adjusted, number(b, 0x99));
  const highBroken = b.or(carried, () => highOverflow);
  const sixty = number(b, 0x60);
  const highFix = b.select(
    types.number,
    highBroken,
    () => sixty,
    () => zero,
  );
  const result = b.add(adjusted, highFix);
  const carriedAgain = b.lessThan(result, adjusted);
  const overflow = b.or(carried, () => carriedAgain);

  writeFlags(b, overflow, boolean(b, false), boolean(b, false));
  writeAcc(b, result);
};
