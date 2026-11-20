import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { asBody, bool, boolAnd, boolOr, flag, num, readApsr, readReg, s32, signExtend, u32, writeReg } from './ir';
import type { Body } from './ir';

/**
 * Cortex-M4 DSP/SIMD 指令。
 *
 * 只实现 ARMv7-M 的 DSP 扩展（M4 有、M3 没有的那部分）：饱和加减、并行 SIMD 字节/半字
 * 运算、GE 标志与 SEL、SSAT/USAT、16×16 乘加、32×32 的高/低 32 位乘法。所有结果都用
 * 32 位整数 IR 表达，不经过宿主浮点；32×32 乘积用 16 位分肢计算，避免 JS double 在
 * 超过 2^53 后丢失低位。
 *
 * Q 标志是 APSR bit27 的粘滞位：只有饱和类指令和 MSR APSR 会置/清它，普通 NZCV 更新
 * 保留它（见 ir.ts 的 writeNzcv/writeNz/writeNzc 掩码）。GE 是 APSR bit19..16，由并行
 * 加减写、SEL 读，普通标志更新同样保留。
 */

const Q_FLAG = 0x08000000;
const GE_MASK = 0x000f0000;

const MASK16 = 0xffff;
const MASK8 = 0xff;

type DspKind =
  | 'ssat'
  | 'ssat16'
  | 'usat'
  | 'usat16'
  | 'qadd'
  | 'parallel'
  | 'sel'
  | 'pkh'
  | 'extend'
  | 'mul'
  | 'mulAcc'
  | 'mulWord'
  | 'dualMul'
  | 'dualAcc'
  | 'usad'
  | 'smmul';

export interface DspEncoding {
  readonly kind: DspKind;
  readonly h1: number;
  readonly h2: number;
}

const op1 = (h1: number): number => (h1 >> 4) & 0xf;
const op2 = (h2: number): number => (h2 >> 4) & 0xf;

/** 并行加减/交换的 op1：只有 8/9/a/c/d/e 是已分配编码。 */
const parallelOp1 = (value: number): boolean =>
  value === 0x8 || value === 0x9 || value === 0xa || value === 0xc || value === 0xd || value === 0xe;

const parallelOp2 = (value: number): boolean =>
  value === 0x0 || value === 0x1 || value === 0x2 || value === 0x4 || value === 0x5 || value === 0x6;

/** 识别一条 32 位 DSP 指令；返回 undefined 表示不属于本模块。 */
export function classifyDsp(h1: number, h2: number): DspEncoding | undefined {
  const high = h1 & 0xffe0;
  const rn = h1 & 0xf;

  if (
    high === 0xf300 &&
    rn !== 15 &&
    (h2 & 0x8000) === 0
  )
    return { kind: 'ssat', h1, h2 };

  if (high === 0xf320 && rn !== 15 && (h2 & 0xf000) === 0)
    return { kind: 'ssat16', h1, h2 };

  if (high === 0xf380 && rn !== 15 && (h2 & 0x8000) === 0)
    return { kind: 'usat', h1, h2 };

  if (high === 0xf3a0 && rn !== 15 && (h2 & 0xf000) === 0)
    return { kind: 'usat16', h1, h2 };

  if ((h1 & 0xfff0) === 0xeac0) return { kind: 'pkh', h1, h2 };

  if ((h1 & 0xff00) === 0xfa00) {
    const first = op1(h1);

    if (first === 0x8 && op2(h2) >= 0x8 && op2(h2) <= 0xb)
      return { kind: 'qadd', h1, h2 };

    if (first === 0xa && op2(h2) === 0x8) return { kind: 'sel', h1, h2 };

    if (parallelOp1(first) && parallelOp2(op2(h2))) return { kind: 'parallel', h1, h2 };

    // 0xFA0x–0xFA5x 的扩展/带加法扩展：h2 的 op nibble 是 8..b（低两位是 ROR 量）。
    if (first <= 0x5 && op2(h2) >= 0x8 && op2(h2) <= 0xb) return { kind: 'extend', h1, h2 };
  }

  if ((h1 & 0xfff0) === 0xfb00) {
    const second = op2(h2);

    if (second === 0x0 || second === 0x1) return { kind: 'mulAcc', h1, h2 };
  }

  if ((h1 & 0xfff0) === 0xfb10 && op2(h2) <= 0x3) return { kind: 'mulAcc', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb20 && op2(h2) <= 0x1) return { kind: 'dualMul', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb30 && op2(h2) <= 0x1) return { kind: 'mulWord', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb40 && op2(h2) <= 0x1) return { kind: 'dualMul', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb50 && op2(h2) <= 0x1) return { kind: 'smmul', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb60 && op2(h2) <= 0x1) return { kind: 'smmul', h1, h2 };
  if ((h1 & 0xfff0) === 0xfb70 && op2(h2) === 0x0) return { kind: 'usad', h1, h2 };
  if ((h1 & 0xfff0) === 0xfbc0) {
    const second = op2(h2);

    if (second >= 0x8 && second <= 0xb) return { kind: 'mul', h1, h2 };
    if (second === 0xc || second === 0xd) return { kind: 'dualAcc', h1, h2 };
  }

  return undefined;
}

/** 这条 DSP 指令写哪些寄存器；供 register-facts 同步 clobber。 */
export function dspWrittenRegisters(h1: number, h2: number): readonly number[] {
  const encoding = classifyDsp(h1, h2);

  if (encoding === undefined) return [];

  const rd = (h2 >> 8) & 0xf;

  switch (encoding.kind) {
    case 'mul':
    case 'dualAcc':
      // SMLALxy / SMLALDx 写 RdLo:RdHi（RdLo 在 h2 高半字节）。
      return [(h2 >> 12) & 0xf, (h2 >> 8) & 0xf];
    default:
      return [rd];
  }
}

const qFlag = (b: Body): Value<boolean> => flag(b, Q_FLAG);

function setQ(b: Body, saturated: Value<boolean>): void {
  const apsr = readApsr(b);

  b.writeState(
    'apsr',
    b.select(
      types.number,
      boolOr(b, qFlag(b), saturated),
      (inner) => inner.bitOr(apsr, inner.constant(types.number, Q_FLAG)),
      () => apsr,
    ),
  );
}

function setGe(b: Body, nibble: Value<number>): void {
  b.writeState(
    'apsr',
    b.bitOr(
      b.bitAnd(readApsr(b), num(b, ~GE_MASK)),
      b.shiftLeft(b.bitAnd(nibble, num(b, 0xf)), num(b, 16)),
    ),
  );
}

const geBit = (b: Body, value: Value<boolean>): Value<number> =>
  b.select(
    types.number,
    value,
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.constant(types.number, 0),
  );

/** 32 位有符号加法的溢出检测（结果仍在 JS 精确范围内）。 */
function signedOverflow(
  b: Body,
  left: Value<number>,
  right: Value<number>,
  result: Value<number>,
): Value<boolean> {
  const a = s32(b, left);
  const c = s32(b, right);
  const sum = s32(b, result);
  const sameSign = b.equal(types.bool, b.lessThan(a, num(b, 0)), b.lessThan(c, num(b, 0)));
  const changedSign = b.notEqual(types.bool, b.lessThan(sum, num(b, 0)), b.lessThan(a, num(b, 0)));

  return boolAnd(b, sameSign, changedSign);
}

/** 加法结果（可能超出 32 位）是否越过有符号 32 位范围。 */
function signedRangeOverflow(b: Body, value: Value<number>): Value<boolean> {
  return boolOr(
    b,
    b.greaterThan(value, num(b, 0x7fffffff)),
    b.lessThan(value, num(b, -0x80000000)),
  );
}

const pack16 = (b: Body, high: Value<number>, low: Value<number>): Value<number> =>
  b.bitOr(
    b.shiftLeft(b.bitAnd(high, num(b, MASK16)), num(b, 16)),
    b.bitAnd(low, num(b, MASK16)),
  );

const lane16 = (b: Body, value: Value<number>, index: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, index * 16)), num(b, MASK16));

const signedLane16 = (b: Body, value: Value<number>, index: number): Value<number> =>
  signExtend(b, lane16(b, value, index), 16);

const lane8 = (b: Body, value: Value<number>, index: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, index * 8)), num(b, MASK8));

const signedLane8 = (b: Body, value: Value<number>, index: number): Value<number> =>
  signExtend(b, lane8(b, value, index), 8);

/** 有符号 32 位饱和到 [-2^(bits-1), 2^(bits-1)-1]。 */
function saturateSigned(
  b: Body,
  value: Value<number>,
  bits: number,
): { readonly value: Value<number>; readonly saturated: Value<boolean> } {
  if (bits >= 32) return { value: u32(b, value), saturated: bool(b, false) };
  const signed = s32(b, value);
  const max = 2 ** (bits - 1) - 1;
  const min = -(2 ** (bits - 1));
  const high = b.greaterThan(signed, num(b, max));
  const low = b.lessThan(signed, num(b, min));
  const result = b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, max),
    (inner) =>
      inner.select(
        types.number,
        low,
        (lowBody) => lowBody.constant(types.number, min >>> 0),
        () => signed,
      ),
  );

  return { value: u32(b, result), saturated: boolOr(b, high, low) };
}

/** 无符号饱和到 [0, 2^bits-1]；输入按有符号 32 位解释（负值饱和到 0）。 */
function saturateUnsigned(
  b: Body,
  value: Value<number>,
  bits: number,
): { readonly value: Value<number>; readonly saturated: Value<boolean> } {
  const signed = s32(b, value);

  if (bits <= 0) {
    return {
      value: num(b, 0),
      saturated: b.notEqual(types.number, signed, num(b, 0)),
    };
  }

  const max = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
  const low = b.lessThan(signed, num(b, 0));
  const high: Value<boolean> =
    bits < 32 ? b.greaterThan(signed, num(b, max)) : bool(b, false);
  const result = b.select(
    types.number,
    low,
    (inner) => inner.constant(types.number, 0),
    (inner) =>
      inner.select(
        types.number,
        high,
        (highBody) => highBody.constant(types.number, max),
        () => signed,
      ),
  );

  return { value: u32(b, result), saturated: boolOr(b, low, high) };
}

/** 32 位有符号饱和加法；操作数按有符号 32 位解释。 */
function saturatingAdd32(
  b: Body,
  left: Value<number>,
  right: Value<number>,
): { readonly value: Value<number>; readonly saturated: Value<boolean> } {
  const sum = b.add(s32(b, left), s32(b, right));
  const high = b.greaterThan(sum, num(b, 0x7fffffff));
  const low = b.lessThan(sum, num(b, -0x80000000));
  const result = b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, 0x7fffffff),
    (inner) =>
      inner.select(
        types.number,
        low,
        (lowBody) => lowBody.constant(types.number, 0x80000000),
        () => sum,
      ),
  );

  return { value: u32(b, result), saturated: boolOr(b, high, low) };
}

function saturatingSub32(
  b: Body,
  left: Value<number>,
  right: Value<number>,
): { readonly value: Value<number>; readonly saturated: Value<boolean> } {
  const difference = b.subtract(s32(b, left), s32(b, right));
  const high = b.greaterThan(difference, num(b, 0x7fffffff));
  const low = b.lessThan(difference, num(b, -0x80000000));
  const result = b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, 0x7fffffff),
    (inner) =>
      inner.select(
        types.number,
        low,
        (lowBody) => lowBody.constant(types.number, 0x80000000),
        () => difference,
      ),
  );

  return { value: u32(b, result), saturated: boolOr(b, high, low) };
}

/** 32×32 低 32 位：用 16 位分肢，避免宿主 double 丢失低位。 */
export function multiplyLow32(b: Body, left: Value<number>, right: Value<number>): Value<number> {
  const a = u32(b, left);
  const c = u32(b, right);
  const a0 = b.bitAnd(a, num(b, MASK16));
  const a1 = b.shiftRightUnsigned(a, num(b, 16));
  const c0 = b.bitAnd(c, num(b, MASK16));
  const c1 = b.shiftRightUnsigned(c, num(b, 16));
  const p00 = b.multiply(a0, c0);
  const cross = b.add(b.multiply(a0, c1), b.multiply(a1, c0));

  return u32(b, b.add(p00, b.shiftLeft(cross, num(b, 16))));
}

/** 32×32 高 32 位（算术右移 32 后的有符号值）。`round` 加 0x80000000 后取高。 */
export function multiplyHigh32(
  b: Body,
  left: Value<number>,
  right: Value<number>,
  round: boolean,
): Value<number> {
  const a = u32(b, left);
  const c = u32(b, right);
  const a0 = b.bitAnd(a, num(b, MASK16));
  const a1 = b.shiftRightUnsigned(a, num(b, 16));
  const c0 = b.bitAnd(c, num(b, MASK16));
  const c1 = b.shiftRightUnsigned(c, num(b, 16));
  const p00 = b.multiply(a0, c0);
  const p01 = b.multiply(a0, c1);
  const p10 = b.multiply(a1, c0);
  const p11 = b.multiply(a1, c1);
  const mid = b.add(b.add(p01, p10), b.floor(b.divide(p00, num(b, 65536))));
  const unsignedHigh = b.add(p11, b.floor(b.divide(mid, num(b, 65536))));
  const low = u32(
    b,
    b.add(
      b.shiftLeft(b.bitAnd(mid, num(b, MASK16)), num(b, 16)),
      b.bitAnd(p00, num(b, MASK16)),
    ),
  );
  const carry = round ? b.greaterThanOrEqual(low, num(b, 0x80000000)) : bool(b, false);
  // 无符号分肢乘积要扣除两个操作数各自的符号扩展项，才能得到有符号 64 位积的高 32 位。
  const negativeA = b.notEqual(
    types.number,
    b.bitAnd(a, num(b, 0x80000000)),
    num(b, 0),
  );
  const negativeC = b.notEqual(
    types.number,
    b.bitAnd(c, num(b, 0x80000000)),
    num(b, 0),
  );
  const corrected = b.subtract(
    b.subtract(
      unsignedHigh,
      b.select(types.number, negativeA, () => c, (inner) => inner.constant(types.number, 0)),
    ),
    b.select(types.number, negativeC, () => a, (inner) => inner.constant(types.number, 0)),
  );

  return s32(b, b.add(corrected, geBit(b, carry)));
}

/** 16×16 有符号乘积分肢：`high` 选高半字、`low` 选低半字。 */
function multiply16(
  b: Body,
  left: Value<number>,
  right: Value<number>,
  leftHigh: boolean,
  rightHigh: boolean,
): Value<number> {
  const a = leftHigh ? signedLane16(b, left, 1) : signedLane16(b, left, 0);
  const c = rightHigh ? signedLane16(b, right, 1) : signedLane16(b, right, 0);

  return u32(b, b.multiply(a, c));
}

/** 64 位累加：`(hi:lo) += value`，其中 `value` 按有符号 32 位解释。 */
function addSigned32To64(
  b: Body,
  lo: Value<number>,
  hi: Value<number>,
  value: Value<number>,
): { readonly lo: Value<number>; readonly hi: Value<number> } {
  const signed = s32(b, value);
  const sum = b.add(u32(b, lo), signed);
  const nextLo = u32(b, sum);
  const carry = b.greaterThan(sum, num(b, 0xffffffff));
  const sign = b.shiftRight(signed, num(b, 31));

  return {
    lo: nextLo,
    hi: u32(b, b.add(b.add(u32(b, hi), sign), geBit(b, carry))),
  };
}

/** 64 位累加一个有符号 48 位值（两个 16×16 乘积之和）。 */
function addSignedWideTo64(
  b: Body,
  lo: Value<number>,
  hi: Value<number>,
  value: Value<number>,
): { readonly lo: Value<number>; readonly hi: Value<number> } {
  // 乘积和落在 [-2^31, 2^31)，先拆成低 32 位与符号扩展高位。
  const low = u32(b, value);
  const high = b.shiftRight(s32(b, value), num(b, 31));
  const sum = b.add(u32(b, lo), low);
  const nextLo = u32(b, sum);
  const carry = b.greaterThan(sum, num(b, 0xffffffff));

  return { lo: nextLo, hi: u32(b, b.add(b.add(u32(b, hi), high), geBit(b, carry))) };
}

function rotateRight(b: Body, value: Value<number>, amount: number): Value<number> {
  const by = amount & 31;

  if (by === 0) return u32(b, value);

  return u32(
    b,
    b.bitOr(
      b.shiftRightUnsigned(u32(b, value), num(b, by)),
      b.shiftLeft(u32(b, value), num(b, 32 - by)),
    ),
  );
}

function saturateOperation(b: Body, h1: number, h2: number, kind: DspKind): void {
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const source = readReg(b, rn);

  if (kind === 'ssat16' || kind === 'usat16') {
    const bits = (h2 & 0xf) + (kind === 'ssat16' ? 1 : 0);
    const lowSource = signedLane16(b, source, 0);
    const highSource = signedLane16(b, source, 1);
    const low =
      kind === 'ssat16' ? saturateSigned(b, lowSource, bits) : saturateUnsigned(b, lowSource, bits);
    const high =
      kind === 'ssat16'
        ? saturateSigned(b, highSource, bits)
        : saturateUnsigned(b, highSource, bits);

    setQ(b, boolOr(b, low.saturated, high.saturated));
    writeReg(b, rd, pack16(b, high.value, low.value));
    return;
  }

  const sh = (h1 & 0x20) !== 0;
  const imm2 = (h2 >> 12) & 7;
  const bit7 = (h2 >> 7) & 1;
  const bit6 = (h2 >> 6) & 1;
  const shift = (imm2 << 2) | (bit7 << 1) | bit6;
  const shifted = sh
    ? shift === 0
      ? b.shiftRight(s32(b, source), num(b, 31))
      : b.shiftRight(s32(b, source), num(b, shift))
    : u32(b, b.shiftLeft(u32(b, source), num(b, shift)));

  if (kind === 'ssat') {
    const bits = (h2 & 0x1f) + 1;
    const result = saturateSigned(b, shifted, bits);

    setQ(b, result.saturated);
    writeReg(b, rd, result.value);
    return;
  }

  const bits = h2 & 0x1f;
  const result = saturateUnsigned(b, shifted, bits);

  setQ(b, result.saturated);
  writeReg(b, rd, result.value);
}

function parallelOperation(b: Body, h1: number, h2: number, kind: DspKind): void {
  const rn = h1 & 0xf;
  const rd = (h2 >> 8) & 0xf;
  const rm = h2 & 0xf;
  const left = readReg(b, rn);
  const right = readReg(b, rm);
  const first = op1(h1);
  const second = op2(h2);

  if (kind === 'sel') {
    const ge = b.bitAnd(b.shiftRightUnsigned(readApsr(b), num(b, 16)), num(b, 0xf));
    let result = num(b, 0);

    for (let index = 0; index < 4; index += 1) {
      const chooseLeft = b.notEqual(types.number, b.bitAnd(ge, num(b, 1 << index)), num(b, 0));
      const byte = b.select(
        types.number,
        chooseLeft,
        (inner) => lane8(asBody(inner), left, index),
        (inner) => lane8(asBody(inner), right, index),
      );

      result = b.bitOr(result, b.shiftLeft(byte, num(b, index * 8)));
    }
    writeReg(b, rd, result);
    return;
  }

  // first: 8/9/a/c/d/e = add8/add16/asx/sub8/sub16/sax。
  const wide = first === 0x9 || first === 0xd || first === 0xa || first === 0xe;
  const exchange = first === 0xa || first === 0xe;
  const subtract = first === 0xc || first === 0xd || first === 0xe;
  const saturating = second === 0x1 || second === 0x5;
  const unsigned = second === 0x4 || second === 0x5 || second === 0x6;
  const halving = second === 0x2 || second === 0x6;
  const lanes = wide ? 2 : 4;
  const bits = wide ? 16 : 8;
  const umax = 2 ** bits - 1;

  let geNibble = num(b, 0);
  let result = num(b, 0);

  for (let lane = 0; lane < lanes; lane += 1) {
    const leftSigned = wide ? signedLane16(b, left, lane) : signedLane8(b, left, lane);
    const leftUnsigned = wide ? lane16(b, left, lane) : lane8(b, left, lane);
    const other = lane === 0 ? 1 : 0;
    // SASX: 低半字减对方高半字、高半字加对方低半字；SSAX 反之。
    const laneSubtract = exchange ? (lane === 0 ? !subtract : subtract) : subtract;
    const rightSigned = wide
      ? signedLane16(b, right, exchange ? other : lane)
      : signedLane8(b, right, lane);
    const rightUnsigned = wide
      ? lane16(b, right, exchange ? other : lane)
      : lane8(b, right, lane);
    const signedSum = laneSubtract
      ? b.subtract(leftSigned, rightSigned)
      : b.add(leftSigned, rightSigned);
    const unsignedSum = laneSubtract
      ? b.subtract(leftUnsigned, rightUnsigned)
      : b.add(leftUnsigned, rightUnsigned);
    let laneResult: Value<number>;

    if (halving) {
      laneResult = unsigned
        ? b.shiftRightUnsigned(unsignedSum, num(b, 1))
        : b.shiftRight(s32(b, signedSum), num(b, 1));
    } else if (saturating) {
      const saturated = unsigned
        ? saturateUnsigned(b, unsignedSum, bits)
        : saturateSigned(b, signedSum, bits);

      laneResult = saturated.value;
    } else {
      laneResult = unsigned ? unsignedSum : signedSum;
    }

    const masked = b.bitAnd(laneResult, num(b, wide ? MASK16 : MASK8));

    result = b.bitOr(result, b.shiftLeft(masked, num(b, lane * bits)));

    if (!saturating && !halving) {
      const ge = unsigned
        ? laneSubtract
          ? b.greaterThanOrEqual(leftUnsigned, rightUnsigned)
          : b.greaterThan(unsignedSum, num(b, umax))
        : b.greaterThanOrEqual(signedSum, num(b, 0));
      const bit = geBit(b, ge);

      if (wide) {
        // 16 位变体的每个半字占一对 GE 位（GE[3:2]/GE[1:0]）。
        geNibble = b.bitOr(geNibble, b.shiftLeft(b.multiply(bit, num(b, 3)), num(b, lane * 2)));
      } else geNibble = b.bitOr(geNibble, b.shiftLeft(bit, num(b, lane)));
    }
  }

  if (!saturating && !halving) setGe(b, geNibble);
  writeReg(b, rd, result);
}

function qaddOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h2 & 0xf;
  const rm = h1 & 0xf;
  const operation = op2(h2);

  if (operation === 0x8) {
    const result = saturatingAdd32(b, readReg(b, rn), readReg(b, rm));

    setQ(b, result.saturated);
    writeReg(b, rd, result.value);
    return;
  }

  if (operation === 0xa) {
    const result = saturatingSub32(b, readReg(b, rn), readReg(b, rm));

    setQ(b, result.saturated);
    writeReg(b, rd, result.value);
    return;
  }

  const doubled = saturatingAdd32(b, readReg(b, rm), readReg(b, rm));
  const result =
    operation === 0x9
      ? saturatingAdd32(b, readReg(b, rn), doubled.value)
      : saturatingSub32(b, readReg(b, rn), doubled.value);

  setQ(b, boolOr(b, doubled.saturated, result.saturated));
  writeReg(b, rd, result.value);
}

function pkhOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const shift = ((h2 >> 12) & 7) * 4;
  const top = (h2 & 0x20) !== 0;
  const left = readReg(b, rn);
  const right = readReg(b, rm);

  if (top) {
    const shifted =
      shift === 0 ? b.shiftRight(s32(b, right), num(b, 31)) : b.shiftRight(s32(b, right), num(b, shift));

    writeReg(b, rd, pack16(b, b.shiftRightUnsigned(left, num(b, 16)), shifted));
  } else {
    const shifted = u32(b, b.shiftLeft(u32(b, right), num(b, shift)));

    writeReg(b, rd, pack16(b, b.shiftRightUnsigned(shifted, num(b, 16)), left));
  }
}

function extendOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const operation = op1(h1);
  const rotation = (h2 & 0x30) >> 4;
  const rotated = rotateRight(b, readReg(b, rm), rotation * 8);
  const add = rn !== 15;

  if (operation === 0x2 || operation === 0x3) {
    const signed = operation === 0x2;
    const low = signed
      ? signExtend(b, b.bitAnd(rotated, num(b, 0xff)), 8)
      : b.bitAnd(rotated, num(b, 0xff));
    const highByte = b.bitAnd(b.shiftRightUnsigned(rotated, num(b, 16)), num(b, 0xff));
    const high = signed ? signExtend(b, highByte, 8) : highByte;
    const added = add ? readReg(b, rn) : num(b, 0);

    writeReg(
      b,
      rd,
      pack16(
        b,
        b.add(high, b.shiftRightUnsigned(added, num(b, 16))),
        b.add(low, b.bitAnd(added, num(b, MASK16))),
      ),
    );
    return;
  }

  const signed = operation === 0x0 || operation === 0x4;
  const byte = operation === 0x4 || operation === 0x5;
  const raw = byte ? b.bitAnd(rotated, num(b, 0xff)) : b.bitAnd(rotated, num(b, MASK16));
  const extended = signed ? signExtend(b, raw, byte ? 8 : 16) : raw;

  writeReg(b, rd, add ? u32(b, b.add(extended, readReg(b, rn))) : extended);
}

function mulAccOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const ra = (h2 >> 12) & 0xf;
  const second = op2(h2);
  const low = h1 & 0xfff0;

  if (low === 0xfb00) {
    const product = multiplyLow32(b, readReg(b, rn), readReg(b, rm));
    const accumulated =
      second === 0x0
        ? b.add(readReg(b, ra), product)
        : b.subtract(readReg(b, ra), product);

    writeReg(b, rd, u32(b, accumulated));
    return;
  }

  if (low === 0xfb10) {
    // SMULxy / SMLAxy: x=bit5 of op2? 编码 op2 0..3 依次是 bb/bt/tb/tt。
    const leftHigh = (second & 0x2) !== 0;
    const rightHigh = (second & 0x1) !== 0;
    const product = multiply16(b, readReg(b, rn), readReg(b, rm), leftHigh, rightHigh);

    if (ra === 15) {
      writeReg(b, rd, product);
      return;
    }

    const accumulator = readReg(b, ra);
    const sum = u32(b, b.add(accumulator, product));

    setQ(b, signedOverflow(b, accumulator, product, sum));
    writeReg(b, rd, sum);
    return;
  }

  if (low === 0xfb30) {
    const left = readReg(b, rn);
    const right =
      second === 0x0 ? signedLane16(b, readReg(b, rm), 0) : signedLane16(b, readReg(b, rm), 1);
    const product = b.multiply(s32(b, left), right);
    const shifted = b.floor(b.divide(product, num(b, 65536)));

    if (ra === 15) {
      writeReg(b, rd, u32(b, shifted));
      return;
    }

    const accumulator = readReg(b, ra);
    const sum = u32(b, b.add(accumulator, shifted));

    setQ(b, signedOverflow(b, accumulator, shifted, sum));
    writeReg(b, rd, sum);
    return;
  }

  // 兜底：不认识的组合按零写，绝不静默保留旧值。调用方只在 classify 命中后进入。
  writeReg(b, rd, num(b, 0));
}

function dualMulOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const ra = (h2 >> 12) & 0xf;
  const crossed = op2(h2) === 0x1;
  const left = readReg(b, rn);
  const right = readReg(b, rm);
  const first = multiply16(b, left, right, false, crossed);
  const second = multiply16(b, left, right, true, !crossed);
  const sum = b.add(first, second);
  const result = h1 & 0xfff0;

  if (result === 0xfb20) {
    // SMLAD / SMLADX / SMUAD / SMUADX：两个乘积之和再加 Ra。
    if (ra === 15) {
      writeReg(b, rd, u32(b, sum));
      return;
    }

    const total = b.add(
      b.add(s32(b, first), s32(b, second)),
      s32(b, readReg(b, ra)),
    );

    // ARM 只为最终累加结果溢出置 Q；两个乘积的中间和超出 32 位但最后拉回范围内不算。
    setQ(b, signedRangeOverflow(b, total));
    writeReg(b, rd, u32(b, total));
    return;
  }

  if (result === 0xfb40) {
    // SMUSD / SMUSDX：两个乘积之差（Ra=15 固定）。
    writeReg(b, rd, u32(b, b.subtract(first, second)));
    return;
  }
}

function dualAccOperation(b: Body, h1: number, h2: number): void {
  const rdLo = (h2 >> 12) & 0xf;
  const rdHi = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const second = op2(h2);
  const left = readReg(b, rn);
  const right = readReg(b, rm);

  if ((h1 & 0xfff0) === 0xfbc0 && second >= 0x8 && second <= 0xb) {
    // SMLALxy: 16×16 → 64 位累加。
    const leftHigh = (second & 0x2) !== 0;
    const rightHigh = (second & 0x1) !== 0;
    const product = multiply16(b, left, right, leftHigh, rightHigh);
    const added = addSigned32To64(b, readReg(b, rdLo), readReg(b, rdHi), product);

    writeReg(b, rdLo, added.lo);
    writeReg(b, rdHi, added.hi);
    return;
  }

  // SMLALD/SMLALDX：两个 16×16 乘积之和累加进 64 位。
  const crossed = second === 0xd;
  const first = multiply16(b, left, right, false, crossed);
  const secondProduct = multiply16(b, left, right, true, !crossed);
  const sum = b.add(first, secondProduct);
  const added = addSignedWideTo64(b, readReg(b, rdLo), readReg(b, rdHi), sum);

  writeReg(b, rdLo, added.lo);
  writeReg(b, rdHi, added.hi);
}

function usadOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const ra = (h2 >> 12) & 0xf;
  const left = readReg(b, rn);
  const right = readReg(b, rm);
  let sum = ra === 15 ? num(b, 0) : readReg(b, ra);

  for (let index = 0; index < 4; index += 1) {
    const difference = b.subtract(lane8(b, left, index), lane8(b, right, index));

    sum = b.add(sum, b.abs(difference));
  }
  writeReg(b, rd, u32(b, sum));
}

function smmulOperation(b: Body, h1: number, h2: number): void {
  const rd = (h2 >> 8) & 0xf;
  const rn = h1 & 0xf;
  const rm = h2 & 0xf;
  const ra = (h2 >> 12) & 0xf;
  const rounding = op2(h2) === 0x1;
  const high = multiplyHigh32(b, readReg(b, rn), readReg(b, rm), rounding);
  const low = h1 & 0xfff0;

  if (low === 0xfb60) {
    writeReg(b, rd, ra === 15 ? high : u32(b, b.subtract(readReg(b, ra), high)));
    return;
  }

  writeReg(b, rd, ra === 15 ? high : u32(b, b.add(readReg(b, ra), high)));
}

/** 发射一条已识别的 DSP 指令；返回 false 表示不是 DSP 编码。 */
export function emitDsp32(b: Body, h1: number, h2: number): boolean {
  const encoding = classifyDsp(h1, h2);

  if (encoding === undefined) return false;

  switch (encoding.kind) {
    case 'ssat':
    case 'ssat16':
    case 'usat':
    case 'usat16':
      saturateOperation(b, h1, h2, encoding.kind);
      break;
    case 'parallel':
    case 'sel':
      parallelOperation(b, h1, h2, encoding.kind);
      break;
    case 'qadd':
      qaddOperation(b, h1, h2);
      break;
    case 'pkh':
      pkhOperation(b, h1, h2);
      break;
    case 'extend':
      extendOperation(b, h1, h2);
      break;
    case 'mulAcc':
      mulAccOperation(b, h1, h2);
      break;
    case 'dualMul':
      dualMulOperation(b, h1, h2);
      break;
    case 'dualAcc':
      dualAccOperation(b, h1, h2);
      break;
    case 'usad':
      usadOperation(b, h1, h2);
      break;
    case 'smmul':
      smmulOperation(b, h1, h2);
      break;
    case 'mul':
      // 单独出现时按 SMLAL 处理（classify 已限定 0xfbC0 的 8..b）。
      dualAccOperation(b, h1, h2);
      break;
    case 'mulWord':
      mulAccOperation(b, h1, h2);
      break;
  }

  return true;
}

/** 供 register-facts 复用的常量近似：只处理不涉及 64 位/复杂饱和的常见情形。 */
export function dspConstant(
  h1: number,
  h2: number,
  read: (index: number) => number | undefined,
): number | undefined {
  const encoding = classifyDsp(h1, h2);

  if (encoding === undefined) return undefined;

  switch (encoding.kind) {
    case 'pkh': {
      const left = read(h1 & 0xf);
      const right = read(h2 & 0xf);

      if (left === undefined || right === undefined) return undefined;
      const shift = ((h2 >> 12) & 7) * 4;

      if ((h2 & 0x20) !== 0) {
        const shifted =
          shift === 0 ? (right >> 31) >>> 0 : (right >> shift) >>> 0;

        return ((left & 0xffff0000) | (shifted & 0xffff)) >>> 0;
      }

      const shifted = (right << shift) >>> 0;

      return (((shifted & 0xffff0000) | (left & 0xffff)) >>> 0);
    }
    case 'extend': {
      const source = read(h2 & 0xf);

      if (source === undefined) return undefined;
      const rotation = ((h2 >> 4) & 3) * 8;
      const rotated =
        rotation === 0
          ? source >>> 0
          : ((source >>> rotation) | (source << (32 - rotation))) >>> 0;
      const operation = op1(h1);
      const add = (h1 & 0xf) !== 15 ? read(h1 & 0xf) : 0;

      if (add === undefined) return undefined;

      if (operation === 0x2 || operation === 0x3) {
        const signed = operation === 0x2;
        const extend = (value: number): number =>
          signed ? ((value << 24) >> 24) >>> 0 : value;

        return (
          (((extend(rotated & 0xff) + (add >>> 16)) & 0xffff) << 16) |
          ((extend((rotated >>> 16) & 0xff) + (add & 0xffff)) & 0xffff)
        ) >>> 0;
      }

      const signed = operation === 0x0 || operation === 0x4;
      const byte = operation === 0x4 || operation === 0x5;
      const raw = byte ? rotated & 0xff : rotated & 0xffff;
      const extended = signed
        ? byte
          ? ((raw << 24) >> 24) >>> 0
          : ((raw << 16) >> 16) >>> 0
        : raw >>> 0;

      return (extended + add) >>> 0;
    }
    default:
      return undefined;
  }
}
