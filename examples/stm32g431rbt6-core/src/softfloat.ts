import { types } from '@mica-js/sdk/model';
import type { Local, Value } from '@mica-js/sdk/model';
import type { Body } from './ir';
import { asBody, boolAnd, boolOr, num, u32 } from './ir';

/**
 * binary32 软件运算。
 *
 * IR 的 `number` 是宿主 binary64。这里不把 guest double 当 f32：所有操作数先按
 * IEEE754 位型解码成精确的 binary64 数值，运算后按 f32 的位宽显式舍入/编码。
 * binary64 的 53 位精度满足“二次舍入无害”条件（p2 >= 2*p1+2，p1=24），因此
 * +、-、*、/、sqrt 的 double 中间结果再舍入到 f32 与直接 f32 运算一致；乘法的
 * 24 位尾数乘积（<=48 位）本来就在 binary64 中精确。整数/位型搬运不需要任何转换。
 */

export const F32_SIGN = 0x80000000;
export const F32_EXP_MASK = 0x7f800000;
export const F32_FRAC_MASK = 0x007fffff;
export const F32_IMPLICIT = 0x00800000;
export const F32_QUIET = 0x00400000;
export const F32_INFINITY = 0x7f800000;
export const F32_MAX_FINITE = 0x7f7fffff;
export const F32_DEFAULT_NAN = 0x7fc00000;

export const FPSCR_IOC = 0x00000001;
export const FPSCR_DZC = 0x00000002;
export const FPSCR_OFC = 0x00000004;
export const FPSCR_UFC = 0x00000008;
export const FPSCR_IXC = 0x00000010;
export const FPSCR_IDC = 0x00000080;
export const FPSCR_FLAG_MASK = 0x0000009f;
export const FPSCR_NZCV_MASK = 0xf0000000;

export const FPSCR_RMODE_SHIFT = 22;
export const FPSCR_FZ = 0x01000000;
export const FPSCR_DN = 0x02000000;

/** FPSCR 中与软件运算有关的只读快照。 */
export interface F32Environment {
  readonly rmode: Value<number>;
  readonly fz: Value<boolean>;
  readonly dn: Value<boolean>;
}

export interface F32Parts {
  readonly bits: Value<number>;
  readonly sign: Value<number>;
  readonly exponentField: Value<number>;
  readonly fraction: Value<number>;
  readonly isZero: Value<boolean>;
  readonly isSubnormal: Value<boolean>;
  readonly isInfinity: Value<boolean>;
  readonly isNaN: Value<boolean>;
  readonly isSignalingNaN: Value<boolean>;
  readonly magnitude: Value<number>;
  /** 正规化后的 24 位尾数整数：subnormal 会左移到 bit23。 */
  readonly mantissa: Value<number>;
  readonly unbiased: Value<number>;
}

const P2_149 = 2 ** -149;
const P2_126 = 2 ** -126;

const flagValue = (b: Body, mask: number): Value<number> => num(b, mask);

export function raiseFlag(b: Body, flags: Local<number>, mask: number): void {
  b.setLocal(flags, b.bitOr(b.getLocal(flags), flagValue(b, mask)));
}

/** floor(log2(value))，value 为 [1, 2^32) 的整数。 */
export function mostSignificantBit(b: Body, value: Value<number>): Value<number> {
  const remaining = b.local(types.number, u32(b, value));
  const result = b.local(types.number, num(b, 0));

  for (const bit of [16, 8, 4, 2, 1] as const)
    b.if(b.greaterThanOrEqual(b.getLocal(remaining), num(b, 1 << bit)), (inner) => {
      const body = asBody(inner);

      body.setLocal(result, body.add(body.getLocal(result), num(body, bit)));
      body.setLocal(remaining, body.shiftRightUnsigned(body.getLocal(remaining), num(body, bit)));
    });

  return b.getLocal(result);
}

export function decodeF32(b: Body, bits: Value<number>): F32Parts {
  const raw = u32(b, bits);
  const sign = b.shiftRightUnsigned(raw, num(b, 31));
  const exponentField = b.bitAnd(b.shiftRightUnsigned(raw, num(b, 23)), num(b, 0xff));
  const fraction = b.bitAnd(raw, num(b, F32_FRAC_MASK));
  const isZero = b.equal(types.number, b.bitAnd(raw, num(b, 0x7fffffff)), num(b, 0));
  const isSubnormal = boolAnd(
    b,
    b.equal(types.number, exponentField, num(b, 0)),
    b.notEqual(types.number, fraction, num(b, 0)),
  );
  const isInfinity = boolAnd(
    b,
    b.equal(types.number, exponentField, num(b, 0xff)),
    b.equal(types.number, fraction, num(b, 0)),
  );
  const isNaN = boolAnd(
    b,
    b.equal(types.number, exponentField, num(b, 0xff)),
    b.notEqual(types.number, fraction, num(b, 0)),
  );
  const isSignalingNaN = boolAnd(
    b,
    isNaN,
    b.equal(types.number, b.bitAnd(fraction, num(b, F32_QUIET)), num(b, 0)),
  );

  // 正规数：value = (2^23 + fraction) * 2^(exponent - 150)。
  const normalMagnitude = b.multiply(
    b.add(fraction, num(b, F32_IMPLICIT)),
    b.power(num(b, 2), b.subtract(exponentField, num(b, 150))),
  );
  const subnormalMagnitude = b.multiply(fraction, num(b, P2_149));
  const magnitude = b.select(
    types.number,
    isZero,
    (inner) => inner.constant(types.number, 0),
    (inner) =>
      inner.select(
        types.number,
        isSubnormal,
        () => subnormalMagnitude,
        () => normalMagnitude,
      ),
  );
  const unbiased = b.local(types.number, b.subtract(exponentField, num(b, 127)));
  const top = b.local(types.number, num(b, 23));

  b.if(isSubnormal, (inner) => {
    const body = asBody(inner);
    const leading = mostSignificantBit(body, fraction);

    body.setLocal(top, leading);
    body.setLocal(unbiased, body.subtract(leading, num(body, 149)));
  });

  const normalMantissa = b.bitOr(fraction, num(b, F32_IMPLICIT));
  const subnormalMantissa = b.shiftLeft(
    fraction,
    b.subtract(num(b, 23), b.getLocal(top)),
  );
  const mantissa = b.select(
    types.number,
    isZero,
    (inner) => inner.constant(types.number, 0),
    (inner) =>
      inner.select(
        types.number,
        isSubnormal,
        () => subnormalMantissa,
        () => normalMantissa,
      ),
  );

  return {
    bits: raw,
    sign,
    exponentField,
    fraction,
    isZero,
    isSubnormal,
    isInfinity,
    isNaN,
    isSignalingNaN,
    magnitude,
    mantissa,
    unbiased: b.getLocal(unbiased),
  };
}

/** FZ=1 时把 denormal 输入按符号冲成零，并置 IDC。 */
export function flushInput(
  b: Body,
  parts: F32Parts,
  fz: Value<boolean>,
  flags: Local<number>,
): Value<number> {
  const adjusted = b.local(types.number, parts.bits);

  b.if(boolAnd(b, fz, parts.isSubnormal), (inner) => {
    const body = asBody(inner);

    body.setLocal(adjusted, body.shiftLeft(parts.sign, num(body, 31)));
    raiseFlag(body, flags, FPSCR_IDC);
  });

  return b.getLocal(adjusted);
}

function roundIncrement(
  b: Body,
  quotient: Value<number>,
  fraction: Value<number>,
  sign: Value<number>,
  rmode: Value<number>,
): Value<number> {
  const inexact = b.notEqual(types.number, fraction, num(b, 0));
  const aboveHalf = b.greaterThan(fraction, num(b, 0.5));
  const exactlyHalf = b.equal(types.number, fraction, num(b, 0.5));
  const odd = b.notEqual(types.number, b.bitAnd(quotient, num(b, 1)), num(b, 0));
  const nearestEven = boolOr(b, aboveHalf, boolAnd(b, exactlyHalf, odd));
  const towardPositive = boolAnd(b, b.equal(types.number, sign, num(b, 0)), inexact);
  const towardNegative = boolAnd(b, b.notEqual(types.number, sign, num(b, 0)), inexact);
  const increment = b.select(
    types.number,
    b.equal(types.number, rmode, num(b, 0)),
    (nearest) =>
      nearest.select(
        types.number,
        nearestEven,
        (inner) => inner.constant(types.number, 1),
        (inner) => inner.constant(types.number, 0),
      ),
    (directed) =>
      directed.select(
        types.number,
        directed.equal(types.number, rmode, num(asBody(directed), 1)),
        (towardPositiveMode) =>
          towardPositiveMode.select(
            types.number,
            towardPositive,
            (inner) => inner.constant(types.number, 1),
            (inner) => inner.constant(types.number, 0),
          ),
        (other) =>
          other.select(
            types.number,
            other.equal(types.number, rmode, num(asBody(other), 2)),
            (towardNegativeMode) =>
              towardNegativeMode.select(
                types.number,
                towardNegative,
                (inner) => inner.constant(types.number, 1),
                (inner) => inner.constant(types.number, 0),
              ),
            (inner) => inner.constant(types.number, 0),
          ),
      ),
  );

  return increment;
}

function overflowResult(b: Body, sign: Value<number>, rmode: Value<number>): Value<number> {
  const finite = b.bitOr(b.shiftLeft(sign, num(b, 31)), num(b, F32_MAX_FINITE));
  const infinity = b.bitOr(b.shiftLeft(sign, num(b, 31)), num(b, F32_INFINITY));

  return b.select(
    types.number,
    b.equal(types.number, rmode, num(b, 3)),
    () => finite,
    (directed) =>
      directed.select(
        types.number,
        directed.equal(types.number, rmode, num(asBody(directed), 1)),
        (towardPositive) =>
          towardPositive.select(
            types.number,
            towardPositive.equal(types.number, sign, num(asBody(towardPositive), 0)),
            () => infinity,
            () => finite,
          ),
        (other) =>
          other.select(
            types.number,
            other.equal(types.number, rmode, num(asBody(other), 2)),
            (towardNegative) =>
              towardNegative.select(
                types.number,
                towardNegative.equal(types.number, sign, num(asBody(towardNegative), 0)),
                () => finite,
                () => infinity,
              ),
            () => infinity,
          ),
      ),
  );
}

/**
 * 把非负 binary64 magnitude 按当前 FPSCR 舍入模式编码成 binary32 位型。
 * `exponent` 是 unbiased 指数估计；调用方保证误差不超过 1（add/sub 由调用方先归一化）。
 */
export function packF32(
  b: Body,
  magnitude: Value<number>,
  exponent: Value<number>,
  sign: Value<number>,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const result = b.local(types.number, b.shiftLeft(sign, num(b, 31)));
  const signBit = b.shiftLeft(sign, num(b, 31));

  b.if(
    b.equal(types.number, magnitude, num(b, 0)),
    (inner) => {
      inner.setLocal(result, signBit);
    },
    (nonZero) => {
      const body = asBody(nonZero);

      body.if(
        body.lessThan(magnitude, num(body, P2_126)),
        (subnormal) => {
          const sub = asBody(subnormal);
          const scaled = sub.multiply(magnitude, num(sub, 2 ** 149));
          const quotient = sub.floor(scaled);
          const fraction = sub.subtract(scaled, quotient);
          const increment = roundIncrement(sub, quotient, fraction, sign, env.rmode);
          const rounded = sub.add(quotient, increment);
          const inexact = sub.notEqual(types.number, fraction, num(sub, 0));
          const encoded = sub.local(types.number, 0);

          sub.if(
            sub.greaterThanOrEqual(rounded, num(sub, 0x800000)),
            (normal) => {
              const inner = asBody(normal);

              inner.setLocal(
                encoded,
                inner.bitOr(
                  signBit,
                  inner.bitOr(
                    inner.shiftLeft(num(inner, 1), num(inner, 23)),
                    inner.bitAnd(
                      inner.subtract(rounded, num(inner, 0x800000)),
                      num(inner, F32_FRAC_MASK),
                    ),
                  ),
                ),
              );
            },
            (tiny) => {
              const inner = asBody(tiny);

              inner.setLocal(
                encoded,
                inner.bitOr(signBit, inner.bitAnd(rounded, num(inner, F32_FRAC_MASK))),
              );
            },
          );

          sub.if(
            boolAnd(sub, env.fz, sub.lessThan(rounded, num(sub, 0x800000))),
            (flush) => {
              const inner = asBody(flush);

              inner.setLocal(encoded, signBit);
              raiseFlag(inner, flags, FPSCR_UFC);
              inner.if(inexact, (loss) => raiseFlag(asBody(loss), flags, FPSCR_IXC));
            },
            (keep) => {
              const inner = asBody(keep);

              inner.if(inexact, (inexactBody) => {
                const exact = asBody(inexactBody);

                raiseFlag(exact, flags, FPSCR_IXC | FPSCR_UFC);
              });
            },
          );
          sub.setLocal(result, sub.getLocal(encoded));
        },
        (normal) => {
          const body = asBody(normal);
          const exponentLocal = body.local(types.number, exponent);
          const scale = body.local(
            types.number,
            body.multiply(
              magnitude,
              body.power(num(body, 2), body.subtract(num(body, 23), exponent)),
            ),
          );

          body.if(body.greaterThanOrEqual(body.getLocal(scale), num(body, 2 ** 24)), (up) => {
            const inner = asBody(up);

            inner.setLocal(exponentLocal, inner.add(inner.getLocal(exponentLocal), num(inner, 1)));
            inner.setLocal(
              scale,
              inner.multiply(
                magnitude,
                inner.power(
                  num(inner, 2),
                  inner.subtract(num(inner, 23), inner.getLocal(exponentLocal)),
                ),
              ),
            );
          });
          body.if(body.lessThan(body.getLocal(scale), num(body, 2 ** 23)), (down) => {
            const inner = asBody(down);

            inner.setLocal(
              exponentLocal,
              inner.subtract(inner.getLocal(exponentLocal), num(inner, 1)),
            );
            inner.setLocal(
              scale,
              inner.multiply(
                magnitude,
                inner.power(
                  num(inner, 2),
                  inner.subtract(num(inner, 23), inner.getLocal(exponentLocal)),
                ),
              ),
            );
          });

          const quotient = body.floor(body.getLocal(scale));
          const fraction = body.subtract(body.getLocal(scale), quotient);
          const increment = roundIncrement(body, quotient, fraction, sign, env.rmode);
          const rounded = body.add(quotient, increment);
          const normalized = body.local(types.number, rounded);
          const finalExponent = body.local(types.number, body.getLocal(exponentLocal));

          body.if(body.greaterThanOrEqual(rounded, num(body, 2 ** 24)), (carry) => {
            const inner = asBody(carry);

            inner.setLocal(normalized, inner.shiftRightUnsigned(rounded, num(inner, 1)));
            inner.setLocal(finalExponent, inner.add(inner.getLocal(finalExponent), num(inner, 1)));
          });

          body.if(
            body.greaterThan(body.getLocal(finalExponent), num(body, 127)),
            (overflow) => {
              const inner = asBody(overflow);

              inner.setLocal(result, overflowResult(inner, sign, env.rmode));
              raiseFlag(inner, flags, FPSCR_OFC | FPSCR_IXC);
            },
            (fits) => {
              const inner = asBody(fits);
              const cleaned = inner.bitAnd(inner.getLocal(normalized), num(inner, F32_FRAC_MASK));

              inner.setLocal(
                result,
                inner.bitOr(
                  signBit,
                  inner.bitOr(
                    inner.shiftLeft(
                      inner.add(inner.getLocal(finalExponent), num(inner, 127)),
                      num(inner, 23),
                    ),
                    cleaned,
                  ),
                ),
              );
              inner.if(inner.notEqual(types.number, fraction, num(inner, 0)), (inexact) => {
                raiseFlag(asBody(inexact), flags, FPSCR_IXC);
              });
            },
          );
        },
      );
    },
  );

  return b.getLocal(result);
}

/** NaN 结果：DN=1 返回默认 NaN；否则按操作数顺序取第一个 NaN 并 quiet。 */
export function propagateNaN(
  b: Body,
  left: F32Parts,
  right: F32Parts,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  // ARM 的 NaN 传播优先 sNaN；同种类按操作数顺序取第一个。
  const selected = b.select(
    types.number,
    left.isSignalingNaN,
    () => left.bits,
    (leftQuiet) =>
      leftQuiet.select(
        types.number,
        right.isSignalingNaN,
        () => right.bits,
        (noSignaling) =>
          noSignaling.select(
            types.number,
            left.isNaN,
            () => left.bits,
            () => right.bits,
          ),
      ),
  );
  const quieted = b.bitOr(selected, num(b, F32_QUIET));

  b.if(boolOr(b, left.isSignalingNaN, right.isSignalingNaN), (invalid) => {
    raiseFlag(asBody(invalid), flags, FPSCR_IOC);
  });

  return b.select(
    types.number,
    env.dn,
    (inner) => inner.constant(types.number, F32_DEFAULT_NAN),
    () => quieted,
  );
}

function infinityWithSign(b: Body, sign: Value<number>): Value<number> {
  return b.bitOr(b.shiftLeft(sign, num(b, 31)), num(b, F32_INFINITY));
}

function zeroWithSign(b: Body, sign: Value<number>): Value<number> {
  return b.shiftLeft(sign, num(b, 31));
}

/** 由 24 位商、guard/round/sticky 位决定是否进位。 */
function roundBitsIncrement(
  b: Body,
  quotient: Value<number>,
  guard: Value<boolean>,
  round: Value<boolean>,
  sticky: Value<boolean>,
  sign: Value<number>,
  rmode: Value<number>,
): Value<number> {
  const inexact = boolOr(b, guard, boolOr(b, round, sticky));
  const odd = b.notEqual(types.number, b.bitAnd(quotient, num(b, 1)), num(b, 0));
  const nearestEven = boolAnd(b, guard, boolOr(b, round, boolOr(b, sticky, odd)));
  const towardPositive = boolAnd(b, b.equal(types.number, sign, num(b, 0)), inexact);
  const towardNegative = boolAnd(b, b.notEqual(types.number, sign, num(b, 0)), inexact);
  const increment = b.select(
    types.number,
    b.equal(types.number, rmode, num(b, 0)),
    (nearest) =>
      nearest.select(
        types.number,
        nearestEven,
        (inner) => inner.constant(types.number, 1),
        (inner) => inner.constant(types.number, 0),
      ),
    (directed) =>
      directed.select(
        types.number,
        directed.equal(types.number, rmode, num(asBody(directed), 1)),
        (positiveMode) =>
          positiveMode.select(
            types.number,
            towardPositive,
            (inner) => inner.constant(types.number, 1),
            (inner) => inner.constant(types.number, 0),
          ),
        (other) =>
          other.select(
            types.number,
            other.equal(types.number, rmode, num(asBody(other), 2)),
            (negativeMode) =>
              negativeMode.select(
                types.number,
                towardNegative,
                (inner) => inner.constant(types.number, 1),
                (inner) => inner.constant(types.number, 0),
              ),
            (inner) => inner.constant(types.number, 0),
          ),
      ),
  );

  return increment;
}

/**
 * 从一个精确的非负整数 significand 编码 f32。
 *
 * `significand * 2^(exponent - msb(significand))` 是真实值；`sticky` 表示整数下方
 * 还有正的非零残差。这样 add/sub 不需要把结果先舍入到 binary64，directed rounding
 * 与 IXC 都能保留 1.0 ± 2^-100 这类远低于 double 精度的信息。
 */
export function packF32FromSignificand(
  b: Body,
  significand: Value<number>,
  exponent: Value<number>,
  sign: Value<number>,
  sticky: Value<boolean>,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const result = b.local(types.number, b.shiftLeft(sign, num(b, 31)));
  const signBit = b.shiftLeft(sign, num(b, 31));
  const top = mostSignificantBit(b, significand);

  b.if(b.equal(types.number, significand, num(b, 0)), (zero) => {
    zero.setLocal(result, signBit);
  }, (nonZero) => {
    const body = asBody(nonZero);

    body.if(body.lessThan(exponent, num(body, -126)), (subnormal) => {
      const sub = asBody(subnormal);
      const shift = sub.add(sub.subtract(exponent, top), num(sub, 149));
      const quotient = sub.local(types.number, 0);
      const guard = sub.local(types.bool, false);
      const round = sub.local(types.bool, false);

      sub.if(sub.greaterThanOrEqual(shift, num(sub, 0)), (left) => {
        const inner = asBody(left);

        inner.setLocal(
          quotient,
          inner.multiply(significand, inner.power(num(inner, 2), shift)),
        );
      }, (right) => {
        const inner = asBody(right);
        const distance = inner.subtract(num(inner, 0), shift);
        const divisor = inner.power(num(inner, 2), distance);
        const kept = inner.floor(inner.divide(significand, divisor));
        const remainder = inner.subtract(significand, inner.multiply(kept, divisor));
        const half = inner.power(num(inner, 2), inner.subtract(distance, num(inner, 1)));

        inner.setLocal(quotient, kept);
        inner.setLocal(guard, inner.greaterThanOrEqual(remainder, half));
        inner.setLocal(
          round,
          inner.notEqual(
            types.number,
            remainder,
            inner.multiply(
              inner.select(
                types.number,
                inner.greaterThanOrEqual(remainder, half),
                (inner) => inner.constant(types.number, 1),
                (inner) => inner.constant(types.number, 0),
              ),
              half,
            ),
          ),
        );
      });

      const increment = roundBitsIncrement(
        sub,
        sub.getLocal(quotient),
        sub.getLocal(guard),
        sub.getLocal(round),
        sticky,
        sign,
        env.rmode,
      );
      const rounded = sub.add(sub.getLocal(quotient), increment);
      const inexact = boolOr(
        sub,
        sub.getLocal(guard),
        boolOr(sub, sub.getLocal(round), sticky),
      );
      const encoded = sub.local(types.number, 0);

      sub.if(sub.greaterThanOrEqual(rounded, num(sub, 0x800000)), (normal) => {
        const inner = asBody(normal);

        inner.setLocal(
          encoded,
          inner.bitOr(
            signBit,
            inner.bitOr(
              inner.shiftLeft(num(inner, 1), num(inner, 23)),
              inner.bitAnd(
                inner.subtract(rounded, num(inner, 0x800000)),
                num(inner, F32_FRAC_MASK),
              ),
            ),
          ),
        );
      }, (tiny) => {
        const inner = asBody(tiny);

        inner.setLocal(
          encoded,
          inner.bitOr(signBit, inner.bitAnd(rounded, num(inner, F32_FRAC_MASK))),
        );
      });

      sub.if(
        boolAnd(sub, env.fz, sub.lessThan(rounded, num(sub, 0x800000))),
        (flush) => {
          const inner = asBody(flush);

          inner.setLocal(encoded, signBit);
          raiseFlag(inner, flags, FPSCR_UFC);
          inner.if(inexact, (loss) => raiseFlag(asBody(loss), flags, FPSCR_IXC));
        },
        (keep) => {
          const inner = asBody(keep);

          inner.if(inexact, (inexactBody) => {
            raiseFlag(asBody(inexactBody), flags, FPSCR_IXC | FPSCR_UFC);
          });
        },
      );
      sub.setLocal(result, sub.getLocal(encoded));
    }, (normal) => {
      const body = asBody(normal);
      const distance = body.subtract(top, num(body, 23));
      const quotient = body.local(types.number, 0);
      const guard = body.local(types.bool, false);
      const round = body.local(types.bool, false);

      body.if(body.lessThan(distance, num(body, 0)), (left) => {
        const inner = asBody(left);

        inner.setLocal(
          quotient,
          inner.shiftLeft(significand, inner.subtract(num(inner, 0), distance)),
        );
      }, (right) => {
        const inner = asBody(right);
        const divisor = inner.power(num(inner, 2), distance);
        const kept = inner.floor(inner.divide(significand, divisor));
        const remainder = inner.subtract(significand, inner.multiply(kept, divisor));
        const half = inner.power(num(inner, 2), inner.subtract(distance, num(inner, 1)));

        inner.setLocal(quotient, kept);
        inner.if(inner.greaterThan(distance, num(inner, 0)), (shifted) => {
          const shiftedBody = asBody(shifted);

          const guardBit = shiftedBody.select(
            types.number,
            shiftedBody.greaterThanOrEqual(remainder, half),
            (inner) => inner.constant(types.number, 1),
            (inner) => inner.constant(types.number, 0),
          );

          shiftedBody.setLocal(guard, shiftedBody.greaterThanOrEqual(remainder, half));
          shiftedBody.setLocal(
            round,
            shiftedBody.notEqual(
              types.number,
              remainder,
              shiftedBody.multiply(guardBit, half),
            ),
          );
        });
      });

      const increment = roundBitsIncrement(
        body,
        body.getLocal(quotient),
        body.getLocal(guard),
        body.getLocal(round),
        sticky,
        sign,
        env.rmode,
      );
      const rounded = body.add(body.getLocal(quotient), increment);
      const normalized = body.local(types.number, rounded);
      const finalExponent = body.local(types.number, exponent);

      body.if(body.greaterThanOrEqual(rounded, num(body, 2 ** 24)), (carry) => {
        const inner = asBody(carry);

        inner.setLocal(normalized, inner.shiftRightUnsigned(rounded, num(inner, 1)));
        inner.setLocal(finalExponent, inner.add(inner.getLocal(finalExponent), num(inner, 1)));
      });

      body.if(body.greaterThan(body.getLocal(finalExponent), num(body, 127)), (overflow) => {
        const inner = asBody(overflow);

        inner.setLocal(result, overflowResult(inner, sign, env.rmode));
        raiseFlag(inner, flags, FPSCR_OFC | FPSCR_IXC);
      }, (fits) => {
        const inner = asBody(fits);

        inner.setLocal(
          result,
          inner.bitOr(
            signBit,
            inner.bitOr(
              inner.shiftLeft(
                inner.add(inner.getLocal(finalExponent), num(inner, 127)),
                num(inner, 23),
              ),
              inner.bitAnd(inner.getLocal(normalized), num(inner, F32_FRAC_MASK)),
            ),
          ),
        );
        inner.if(
          boolOr(
            inner,
            inner.getLocal(guard),
            boolOr(inner, inner.getLocal(round), sticky),
          ),
          (inexact) => raiseFlag(asBody(inexact), flags, FPSCR_IXC),
        );
      });
    });
  });

  return b.getLocal(result);
}

export function addF32(
  b: Body,
  leftBits: Value<number>,
  rightBits: Value<number>,
  subtract: boolean,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const left = decodeF32(b, leftBits);
  const right = decodeF32(b, rightBits);
  const leftAdjusted = flushInput(b, left, env.fz, flags);
  const rightAdjusted = flushInput(b, right, env.fz, flags);
  const leftParts = decodeF32(b, leftAdjusted);
  const rightParts = decodeF32(b, rightAdjusted);
  const effectiveRightSign = subtract ? b.subtract(num(b, 1), rightParts.sign) : rightParts.sign;

  const result = b.local(types.number, 0);
  const handled = b.local(types.bool, false);

  b.if(boolOr(b, leftParts.isNaN, rightParts.isNaN), (nan) => {
    const body = asBody(nan);

    body.setLocal(result, propagateNaN(body, leftParts, rightParts, env, flags));
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolOr(b, leftParts.isInfinity, rightParts.isInfinity)),
    (infinite) => {
      const body = asBody(infinite);
      const both = boolAnd(body, leftParts.isInfinity, rightParts.isInfinity);
      const opposite = body.notEqual(types.number, leftParts.sign, effectiveRightSign);

      body.if(
        both,
        (pair) => {
          const inner = asBody(pair);

          inner.if(
            opposite,
            (invalid) => {
              const bad = asBody(invalid);

              bad.setLocal(result, num(bad, F32_DEFAULT_NAN));
              raiseFlag(bad, flags, FPSCR_IOC);
            },
            (same) => {
              const sameBody = asBody(same);

              sameBody.setLocal(result, infinityWithSign(sameBody, leftParts.sign));
            },
          );
        },
        (single) => {
          const inner = asBody(single);

          inner.setLocal(
            result,
            inner.select(
              types.number,
              leftParts.isInfinity,
              (leftInfinite) => infinityWithSign(asBody(leftInfinite), leftParts.sign),
              (rightInfinite) => infinityWithSign(asBody(rightInfinite), effectiveRightSign),
            ),
          );
        },
      );
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolOr(b, leftParts.isZero, rightParts.isZero)),
    (zero) => {
      const body = asBody(zero);

      body.if(
        boolAnd(body, leftParts.isZero, rightParts.isZero),
        (both) => {
          const inner = asBody(both);
          const same = inner.equal(types.number, leftParts.sign, effectiveRightSign);
          const cancelledSign = inner.select(
            types.number,
            same,
            () => leftParts.sign,
            (opposite) =>
              opposite.select(
                types.number,
                opposite.equal(types.number, env.rmode, num(asBody(opposite), 2)),
                (round) => round.constant(types.number, 1),
                (round) => round.constant(types.number, 0),
              ),
          );

          inner.setLocal(result, zeroWithSign(inner, cancelledSign));
        },
        (one) => {
          const inner = asBody(one);

          inner.if(
            leftParts.isZero,
            (leftZero) => {
              const onlyRight = asBody(leftZero);

              onlyRight.setLocal(
                result,
                onlyRight.bitOr(
                  onlyRight.bitAnd(rightParts.bits, num(onlyRight, 0x7fffffff)),
                  onlyRight.shiftLeft(effectiveRightSign, num(onlyRight, 31)),
                ),
              );
            },
            (rightZero) => {
              const onlyLeft = asBody(rightZero);

              onlyLeft.setLocal(result, leftParts.bits);
            },
          );
        },
      );
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(b.not(b.getLocal(handled)), (finite) => {
    const body = asBody(finite);
    const sameSign = body.equal(types.number, leftParts.sign, effectiveRightSign);
    const leftLarger = body.greaterThan(leftParts.magnitude, rightParts.magnitude);
    const largeMantissa = body.select(
      types.number,
      leftLarger,
      () => leftParts.mantissa,
      () => rightParts.mantissa,
    );
    const smallMantissa = body.select(
      types.number,
      leftLarger,
      () => rightParts.mantissa,
      () => leftParts.mantissa,
    );
    const largeExponent = body.select(
      types.number,
      leftLarger,
      () => leftParts.unbiased,
      () => rightParts.unbiased,
    );
    const smallExponent = body.select(
      types.number,
      leftLarger,
      () => rightParts.unbiased,
      () => leftParts.unbiased,
    );
    const resultSign = body.select(
      types.number,
      leftLarger,
      () => leftParts.sign,
      () => effectiveRightSign,
    );
    const distance = body.subtract(largeExponent, smallExponent);
    const kept = body.local(types.number, 0);
    const smallSticky = body.local(types.bool, false);

    body.if(
      body.lessThanOrEqual(distance, num(body, 3)),
      (close) => {
        const inner = asBody(close);

        inner.setLocal(
          kept,
          inner.shiftLeft(smallMantissa, inner.subtract(num(inner, 3), distance)),
        );
        inner.setLocal(smallSticky, inner.constant(types.bool, false));
      },
      (far) => {
        const inner = asBody(far);

        inner.if(
          inner.lessThanOrEqual(distance, num(inner, 27)),
          (aligned) => {
            const scope = asBody(aligned);
            const shift = scope.subtract(distance, num(scope, 3));
            const divisor = scope.power(num(scope, 2), shift);
            const value = scope.floor(scope.divide(smallMantissa, divisor));
            const remainder = scope.subtract(
              smallMantissa,
              scope.multiply(value, divisor),
            );

            scope.setLocal(kept, value);
            scope.setLocal(
              smallSticky,
              scope.notEqual(types.number, remainder, num(scope, 0)),
            );
          },
          (beyond) => {
            const scope = asBody(beyond);

            scope.setLocal(kept, scope.constant(types.number, 0));
            scope.setLocal(smallSticky, scope.constant(types.bool, true));
          },
        );
      },
    );

    const scaledLarge = body.shiftLeft(largeMantissa, num(body, 3));
    const magnitude = body.local(types.number, 0);
    const residual = body.local(types.bool, false);

    body.if(
      sameSign,
      (add) => {
        const inner = asBody(add);

        inner.setLocal(magnitude, inner.add(scaledLarge, inner.getLocal(kept)));
        inner.setLocal(residual, inner.getLocal(smallSticky));
      },
      (subtract) => {
        const inner = asBody(subtract);

        inner.if(
          inner.getLocal(smallSticky),
          (borrow) => {
            const scope = asBody(borrow);

            scope.setLocal(
              magnitude,
              scope.subtract(
                scope.subtract(scaledLarge, scope.getLocal(kept)),
                num(scope, 1),
              ),
            );
            scope.setLocal(residual, scope.constant(types.bool, true));
          },
          (exact) => {
            const scope = asBody(exact);

            scope.setLocal(magnitude, scope.subtract(scaledLarge, scope.getLocal(kept)));
            scope.setLocal(residual, scope.constant(types.bool, false));
          },
        );
      },
    );

    body.if(
      body.equal(types.number, body.getLocal(magnitude), num(body, 0)),
      (zero) => {
        const inner = asBody(zero);
        const negative = inner.equal(types.number, env.rmode, num(inner, 2));

        inner.setLocal(
          result,
          zeroWithSign(
            inner,
            inner.select(
              types.number,
              negative,
              (round) => round.constant(types.number, 1),
              (round) => round.constant(types.number, 0),
            ),
          ),
        );
      },
      (nonZero) => {
        const inner = asBody(nonZero);
        const top = mostSignificantBit(inner, inner.getLocal(magnitude));
        const exponent = inner.subtract(
          inner.add(top, largeExponent),
          num(inner, 26),
        );

        inner.setLocal(
          result,
          packF32FromSignificand(
            inner,
            inner.getLocal(magnitude),
            exponent,
            resultSign,
            inner.getLocal(residual),
            env,
            flags,
          ),
        );
      },
    );
  });

  return b.getLocal(result);
}

export function subF32(
  b: Body,
  leftBits: Value<number>,
  rightBits: Value<number>,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  return addF32(b, leftBits, rightBits, true, env, flags);
}

export function mulF32(
  b: Body,
  leftBits: Value<number>,
  rightBits: Value<number>,
  negate: boolean,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const left = decodeF32(b, leftBits);
  const right = decodeF32(b, rightBits);
  const leftParts = decodeF32(b, flushInput(b, left, env.fz, flags));
  const rightParts = decodeF32(b, flushInput(b, right, env.fz, flags));
  const result = b.local(types.number, 0);
  const handled = b.local(types.bool, false);
  const sign = b.local(types.number, b.bitXor(leftParts.sign, rightParts.sign));

  if (negate) b.setLocal(sign, b.bitXor(b.getLocal(sign), num(b, 1)));

  b.if(boolOr(b, leftParts.isNaN, rightParts.isNaN), (nan) => {
    const body = asBody(nan);

    body.setLocal(result, propagateNaN(body, leftParts, rightParts, env, flags));
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolOr(b, leftParts.isInfinity, rightParts.isInfinity)),
    (infinite) => {
      const body = asBody(infinite);
      const zeroTimesInfinity = boolOr(
        body,
        boolAnd(body, leftParts.isInfinity, rightParts.isZero),
        boolAnd(body, rightParts.isInfinity, leftParts.isZero),
      );

      body.if(
        zeroTimesInfinity,
        (invalid) => {
          const bad = asBody(invalid);

          bad.setLocal(result, num(bad, F32_DEFAULT_NAN));
          raiseFlag(bad, flags, FPSCR_IOC);
        },
        (valid) => {
          const body = asBody(valid);

          body.setLocal(result, infinityWithSign(body, body.getLocal(sign)));
        },
      );
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolOr(b, leftParts.isZero, rightParts.isZero)),
    (zero) => {
      const body = asBody(zero);

      body.setLocal(result, zeroWithSign(body, body.getLocal(sign)));
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(b.not(b.getLocal(handled)), (finite) => {
    const body = asBody(finite);
    const magnitude = body.multiply(leftParts.magnitude, rightParts.magnitude);
    const exponent = body.add(leftParts.unbiased, rightParts.unbiased);

    body.setLocal(result, packF32(body, magnitude, exponent, body.getLocal(sign), env, flags));
  });

  return b.getLocal(result);
}

export function divF32(
  b: Body,
  leftBits: Value<number>,
  rightBits: Value<number>,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const left = decodeF32(b, leftBits);
  const right = decodeF32(b, rightBits);
  const leftParts = decodeF32(b, flushInput(b, left, env.fz, flags));
  const rightParts = decodeF32(b, flushInput(b, right, env.fz, flags));
  const result = b.local(types.number, 0);
  const handled = b.local(types.bool, false);
  const sign = b.bitXor(leftParts.sign, rightParts.sign);

  b.if(boolOr(b, leftParts.isNaN, rightParts.isNaN), (nan) => {
    const body = asBody(nan);

    body.setLocal(result, propagateNaN(body, leftParts, rightParts, env, flags));
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolOr(b, leftParts.isInfinity, rightParts.isInfinity)),
    (infinite) => {
      const body = asBody(infinite);
      const invalid = boolAnd(body, leftParts.isInfinity, rightParts.isInfinity);

      body.if(
        invalid,
        (bad) => {
          const inner = asBody(bad);

          inner.setLocal(result, num(inner, F32_DEFAULT_NAN));
          raiseFlag(inner, flags, FPSCR_IOC);
        },
        (valid) => {
          const inner = asBody(valid);

          inner.if(
            leftParts.isInfinity,
            (leftInf) => {
              asBody(leftInf).setLocal(result, infinityWithSign(asBody(leftInf), sign));
            },
            (rightInf) => {
              asBody(rightInf).setLocal(result, zeroWithSign(asBody(rightInf), sign));
            },
          );
        },
      );
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolAnd(b, leftParts.isZero, rightParts.isZero)),
    (invalid) => {
      const body = asBody(invalid);

      body.setLocal(result, num(body, F32_DEFAULT_NAN));
      raiseFlag(body, flags, FPSCR_IOC);
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), boolAnd(b, b.not(leftParts.isZero), rightParts.isZero)),
    (divideByZero) => {
      const body = asBody(divideByZero);

      body.setLocal(result, infinityWithSign(body, sign));
      raiseFlag(body, flags, FPSCR_DZC);
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(boolAnd(b, b.not(b.getLocal(handled)), leftParts.isZero), (zero) => {
    const body = asBody(zero);

    body.setLocal(result, zeroWithSign(body, sign));
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(b.not(b.getLocal(handled)), (finite) => {
    const body = asBody(finite);
    const magnitude = body.divide(leftParts.magnitude, rightParts.magnitude);
    const exponent = body.subtract(leftParts.unbiased, rightParts.unbiased);

    body.setLocal(result, packF32(body, magnitude, exponent, sign, env, flags));
  });

  return b.getLocal(result);
}

export function sqrtF32(
  b: Body,
  bits: Value<number>,
  env: F32Environment,
  flags: Local<number>,
): Value<number> {
  const original = decodeF32(b, bits);
  const parts = decodeF32(b, flushInput(b, original, env.fz, flags));
  const result = b.local(types.number, 0);
  const handled = b.local(types.bool, false);

  b.if(parts.isNaN, (nan) => {
    const body = asBody(nan);

    body.setLocal(
      result,
      body.select(
        types.number,
        env.dn,
        (inner) => inner.constant(types.number, F32_DEFAULT_NAN),
        (inner) => inner.bitOr(parts.bits, num(asBody(inner), F32_QUIET)),
      ),
    );
    body.if(parts.isSignalingNaN, (invalid) => {
      raiseFlag(asBody(invalid), flags, FPSCR_IOC);
    });
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(boolAnd(b, b.not(b.getLocal(handled)), parts.isInfinity), (infinite) => {
    const body = asBody(infinite);

    body.if(
      body.equal(types.number, parts.sign, num(body, 0)),
      (positive) => {
        asBody(positive).setLocal(result, num(asBody(positive), F32_INFINITY));
      },
      (negative) => {
        const bad = asBody(negative);

        bad.setLocal(result, num(bad, F32_DEFAULT_NAN));
        raiseFlag(bad, flags, FPSCR_IOC);
      },
    );
    body.setLocal(handled, body.constant(types.bool, true));
  });

  b.if(
    boolAnd(
      b,
      b.not(b.getLocal(handled)),
      boolAnd(b, parts.isZero, b.equal(types.number, parts.sign, num(b, 1))),
    ),
    (negativeZero) => {
      const body = asBody(negativeZero);

      body.setLocal(result, num(body, F32_SIGN));
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(
    boolAnd(b, b.not(b.getLocal(handled)), b.notEqual(types.number, parts.sign, num(b, 0))),
    (negative) => {
      const body = asBody(negative);

      body.setLocal(result, num(body, F32_DEFAULT_NAN));
      raiseFlag(body, flags, FPSCR_IOC);
      body.setLocal(handled, body.constant(types.bool, true));
    },
  );

  b.if(b.not(b.getLocal(handled)), (finite) => {
    const body = asBody(finite);
    const magnitude = body.sqrt(parts.magnitude);
    const exponent = body.floor(body.divide(parts.unbiased, num(body, 2)));

    body.setLocal(result, packF32(body, magnitude, exponent, num(body, 0), env, flags));
  });

  return b.getLocal(result);
}

export function absF32(
  b: Body,
  bits: Value<number>,
  flags: Local<number>,
): Value<number> {
  void flags;
  // VABS/VNEG 是位操作：sNaN 不 quiet、不置 IOC（QEMU MPS2 已核对）。
  return b.bitAnd(u32(b, bits), num(b, 0x7fffffff));
}

export function negF32(
  b: Body,
  bits: Value<number>,
  flags: Local<number>,
): Value<number> {
  void flags;

  return b.bitXor(u32(b, bits), num(b, F32_SIGN));
}

export interface F32Comparison {
  readonly unordered: Value<boolean>;
  readonly less: Value<boolean>;
  readonly equal: Value<boolean>;
  readonly greater: Value<boolean>;
}

/** 比较两个 f32；NaN 返回 unordered。 */
export function compareF32(
  b: Body,
  leftBits: Value<number>,
  rightBits: Value<number>,
): F32Comparison {
  const left = decodeF32(b, leftBits);
  const right = decodeF32(b, rightBits);
  const unordered = boolOr(b, left.isNaN, right.isNaN);
  const bothZero = boolAnd(b, left.isZero, right.isZero);
  const sameSign = b.equal(types.number, left.sign, right.sign);
  const sameMagnitude = b.equal(types.number, left.magnitude, right.magnitude);
  const leftGreaterMagnitude = b.greaterThan(left.magnitude, right.magnitude);
  const rightGreaterMagnitude = b.greaterThan(right.magnitude, left.magnitude);
  const leftGreater = b.select(
    types.bool,
    sameSign,
    (same) =>
      same.select(
        types.bool,
        same.equal(types.number, left.sign, num(asBody(same), 0)),
        () => leftGreaterMagnitude,
        () => rightGreaterMagnitude,
      ),
    (opposite) => opposite.equal(types.number, left.sign, num(asBody(opposite), 0)),
  );
  const equal = boolOr(
    b,
    bothZero,
    boolAnd(b, b.not(unordered), boolAnd(b, sameSign, sameMagnitude)),
  );
  const greater = boolAnd(b, b.not(unordered), boolAnd(b, b.not(equal), leftGreater));
  const less = boolAnd(b, b.not(unordered), boolAnd(b, b.not(equal), b.not(leftGreater)));

  return { unordered, less, equal, greater };
}

export function fromSignedInteger(
  b: Body,
  value: Value<number>,
): {
  readonly magnitude: Value<number>;
  readonly exponent: Value<number>;
  readonly sign: Value<number>;
} {
  const raw = u32(b, value);
  const sign = b.shiftRightUnsigned(raw, num(b, 31));
  const signed = b.bitOr(raw, num(b, 0));
  const magnitude = b.abs(signed);

  return {
    magnitude,
    exponent: mostSignificantBit(b, magnitude),
    sign,
  };
}

export function fromUnsignedInteger(
  b: Body,
  value: Value<number>,
): {
  readonly magnitude: Value<number>;
  readonly exponent: Value<number>;
  readonly sign: Value<number>;
} {
  const magnitude = u32(b, value);

  return {
    magnitude,
    exponent: mostSignificantBit(b, magnitude),
    sign: num(b, 0),
  };
}

export interface IntegerConversion {
  readonly value: Value<number>;
  readonly invalid: Value<boolean>;
  readonly inexact: Value<boolean>;
}

/** VCVT.S32.F32 / VCVT.U32.F32；按 FPSCR.RMode 舍入。 */
export function toInteger(
  b: Body,
  bits: Value<number>,
  unsigned: boolean,
  env: F32Environment,
): IntegerConversion {
  void env;
  const parts = decodeF32(b, bits);
  // ARM VCVT.{S32,U32}.F32 总是向零截断；VCVT 的 RMode 只影响定点和浮点互转的
  // 其他形式，这里不读 FPSCR.RMode。
  const rounded = b.floor(parts.magnitude);
  const fraction = b.subtract(parts.magnitude, rounded);
  const invalidNaN = boolOr(b, parts.isNaN, parts.isInfinity);
  const negative = b.notEqual(types.number, parts.sign, num(b, 0));
  const signedOutOfRange = b.select(
    types.bool,
    negative,
    (inner) => inner.greaterThan(parts.magnitude, inner.constant(types.number, 0x80000000)),
    (inner) => inner.greaterThan(parts.magnitude, inner.constant(types.number, 0x7fffffff)),
  );
  const unsignedOutOfRange = boolOr(
    b,
    boolAnd(b, negative, b.greaterThanOrEqual(parts.magnitude, num(b, 1))),
    b.greaterThan(parts.magnitude, num(b, 0xffffffff)),
  );
  const outOfRange = unsigned ? unsignedOutOfRange : signedOutOfRange;
  const invalid = boolOr(b, invalidNaN, outOfRange);
  const encoded = b.local(types.number, 0);

  b.if(
    invalid,
    (bad) => {
      const body = asBody(bad);
      const invalidValue = unsigned
        ? body.select(
            types.number,
            negative,
            (inner) => inner.constant(types.number, 0),
            (inner) => inner.constant(types.number, 0xffffffff),
          )
        : body.select(
            types.number,
            negative,
            (inner) => inner.constant(types.number, 0x80000000),
            (inner) => inner.constant(types.number, 0x7fffffff),
          );

      body.setLocal(encoded, invalidValue);
    },
    (finite) => {
      const body = asBody(finite);
      const positiveValue = body.bitAnd(rounded, num(body, 0xffffffff));
      const negativeValue = body.bitAnd(
        body.subtract(num(body, 0), rounded),
        num(body, 0xffffffff),
      );

      body.setLocal(
        encoded,
        body.select(
          types.number,
          negative,
          () => negativeValue,
          () => positiveValue,
        ),
      );
    },
  );

  return {
    value: b.getLocal(encoded),
    invalid,
    inexact: b.notEqual(types.number, fraction, num(b, 0)),
  };
}
