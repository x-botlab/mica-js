import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { CRC, CRC_BASE } from './layout';
import { asBody, boolBit, boolOr, num, readWord, u32, writeWord } from './ir';
import type { Local } from '@mica-js/sdk/model';
import type { Body } from './ir';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431 CRC 计算单元。
 *
 * 寄存器：DR/IDR/CR/INIT/POL。每次写 DR 按访问宽度把 8/16/32 位数据输入 CRC；
 * 默认多项式 0x04C11DB7、INIT 0xFFFFFFFF、不反射、无最终异或，即 CRC-32/MPEG-2。
 * 支持 CR.POLYSIZE 的 32/16/8/7 位、REV_IN 的字节/半字/字输入反射、REV_OUT 输出
 * 反射；INIT/POL 写入与 CR.RESET 都按 RM0440 重置计算。
 *
 * 计算是纯 IR：每次写 DR 展开 8×字节数的位循环。CRC 不在热路径上，展开比引入
 * 通用查表运行时更符合本项目“设备行为由翻译期 IR 生成”的约束。
 */

export const CRC_STATE = 0x00;
const DR = 0x00;
const IDR = 0x04;
const CR = 0x08;
const INIT = 0x10;
const POL = 0x14;
/** 隐藏复位标记；不在固件可见寄存器窗口内。 */
const INITIALIZED = 0x18;

const CR_MASK = 0xff;
const RESET = 0x01;
const POLYSIZE_SHIFT = 3;
const REV_IN_SHIFT = 5;
const REV_OUT = 0x80;

const memory = (b: Body, offset: number): Value<number> => readWord(b, CRC, num(b, offset));

const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWord(b, CRC, num(b, offset), value);
};

/**
 * 惰性复位：DDL 的 memory 零初始化，但 CRC 复位值 DR/INIT=0xFFFFFFFF、POL=0x04C11DB7。
 * 第一次访问时写入真实复位值；标记字位于 0x18，固件读该保留偏移仍返回 0。
 */
function ensureInit(b: Body): void {
  b.if(b.equal(types.number, readWord(b, CRC, num(b, INITIALIZED)), num(b, 0)), (first) => {
    const body = asBody(first);

    writeWord(body, CRC, num(body, DR), num(body, 0xffffffff));
    writeWord(body, CRC, num(body, INIT), num(body, 0xffffffff));
    writeWord(body, CRC, num(body, POL), num(body, 0x04c11db7));
    writeWord(body, CRC, num(body, CR), num(body, 0));
    writeWord(body, CRC, num(body, INITIALIZED), num(body, 1));
  });
}

function extract(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
}

function merge(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}

function reverse8(b: Body, value: Value<number>): Value<number> {
  const first = b.bitOr(
    b.bitAnd(b.shiftLeft(value, num(b, 4)), num(b, 0xf0)),
    b.bitAnd(b.shiftRightUnsigned(value, num(b, 4)), num(b, 0x0f)),
  );
  const second = b.bitOr(
    b.bitAnd(b.shiftLeft(first, num(b, 2)), num(b, 0xcc)),
    b.bitAnd(b.shiftRightUnsigned(first, num(b, 2)), num(b, 0x33)),
  );

  return b.bitAnd(
    b.bitOr(
      b.bitAnd(b.shiftLeft(second, num(b, 1)), num(b, 0xaa)),
      b.bitAnd(b.shiftRightUnsigned(second, num(b, 1)), num(b, 0x55)),
    ),
    num(b, 0xff),
  );
}

function reverse16(b: Body, value: Value<number>): Value<number> {
  const low = reverse8(b, b.bitAnd(value, num(b, 0xff)));
  const high = reverse8(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 8)), num(b, 0xff)));

  return b.bitOr(b.shiftLeft(low, num(b, 8)), high);
}

function reverse32(b: Body, value: Value<number>): Value<number> {
  const low = reverse16(b, b.bitAnd(value, num(b, 0xffff)));
  const high = reverse16(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 16)), num(b, 0xffff)));

  return u32(b, b.bitOr(b.shiftLeft(low, num(b, 16)), high));
}

function widthOf(b: Body, cr: Value<number>): Value<number> {
  const encoded = b.bitAnd(b.shiftRightUnsigned(cr, num(b, POLYSIZE_SHIFT)), num(b, 3));

  return b.select(
    types.number,
    b.equal(types.number, encoded, num(b, 0)),
    (inner) => inner.constant(types.number, 32),
    (inner) =>
      inner.select(
        types.number,
        inner.equal(types.number, encoded, inner.constant(types.number, 1)),
        (inner2) => inner2.constant(types.number, 16),
        (inner2) =>
          inner2.select(
            types.number,
            inner2.equal(types.number, encoded, inner2.constant(types.number, 2)),
            (inner3) => inner3.constant(types.number, 8),
            (inner3) => inner3.constant(types.number, 7),
          ),
      ),
  );
}

function widthMask(b: Body, width: Value<number>): Value<number> {
  return b.select(
    types.number,
    b.equal(types.number, width, num(b, 32)),
    (inner) => inner.constant(types.number, 0xffffffff),
    (inner) =>
      inner.subtract(
        inner.shiftLeft(inner.constant(types.number, 1), width),
        inner.constant(types.number, 1),
      ),
  );
}

/** 把 8 位数据按当前宽度/多项式逐位输入；不反射的 CRC-7/8/16/32 通用形式。 */
function feedByte(
  b: Body,
  crc: Local<number>,
  byte: Value<number>,
  width: Value<number>,
  mask: Value<number>,
  poly: Value<number>,
): void {
  const topShift = b.subtract(width, num(b, 1));

  for (let bit = 7; bit >= 0; bit -= 1) {
    const current = b.getLocal(crc);
    const top = b.bitAnd(b.shiftRightUnsigned(current, topShift), num(b, 1));
    const input = b.bitAnd(b.shiftRightUnsigned(byte, num(b, bit)), num(b, 1));
    const feedback = b.notEqual(types.number, b.bitXor(top, input), num(b, 0));
    const shifted = b.bitAnd(b.shiftLeft(current, num(b, 1)), mask);
    const next = b.select(
      types.number,
      feedback,
      (inner) => inner.bitXor(shifted, poly),
      () => shifted,
    );

    b.setLocal(crc, next);
  }
}

function reflectInput(
  b: Body,
  value: Value<number>,
  size: number,
  mode: Value<number>,
): Value<number> {
  const result = b.local(types.number, value);
  const byteReflected =
    size === 4
      ? b.bitOr(
          b.shiftLeft(reverse8(b, b.bitAnd(value, num(b, 0xff))), num(b, 24)),
          b.bitOr(
            b.shiftLeft(
              reverse8(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 8)), num(b, 0xff))),
              num(b, 16),
            ),
            b.bitOr(
              b.shiftLeft(
                reverse8(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 16)), num(b, 0xff))),
                num(b, 8),
              ),
              reverse8(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 24)), num(b, 0xff))),
            ),
          ),
        )
      : size === 2
        ? b.bitOr(
            b.shiftLeft(
              reverse8(b, b.bitAnd(b.shiftRightUnsigned(value, num(b, 8)), num(b, 0xff))),
              num(b, 8),
            ),
            reverse8(b, b.bitAnd(value, num(b, 0xff))),
          )
        : reverse8(b, value);
  const halfReflected =
    size === 4
      ? b.bitOr(
          reverse16(b, b.bitAnd(value, num(b, 0xffff))),
          b.shiftLeft(
            reverse16(
              b,
              b.bitAnd(b.shiftRightUnsigned(value, num(b, 16)), num(b, 0xffff)),
            ),
            num(b, 16),
          ),
        )
      : reverse16(b, value);

  b.if(
    b.equal(types.number, mode, num(b, 0)),
    () => {},
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, mode, num(body, 1)),
        (byte) => byte.setLocal(result, byteReflected),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, mode, num(scope, 2)),
            (half) => half.setLocal(result, halfReflected),
            (word) => {
              const inner = asBody(word);

              inner.setLocal(
                result,
                size === 4
                  ? reverse32(inner, value)
                  : size === 2
                    ? reverse16(inner, value)
                    : reverse8(inner, value),
              );
            },
          );
        },
      );
    },
  );

  return b.getLocal(result);
}

function feedValue(b: Body, value: Value<number>, size: number, cr: Value<number>): void {
  const width = widthOf(b, cr);
  const mask = widthMask(b, width);
  const poly = b.bitAnd(memory(b, POL), mask);
  const mode = b.bitAnd(b.shiftRightUnsigned(cr, num(b, REV_IN_SHIFT)), num(b, 3));
  const reflected = reflectInput(b, value, size, mode);
  const crc = b.local(types.number, b.bitAnd(memory(b, DR), mask));

  if (size === 4) {
    feedByte(b, crc, b.bitAnd(b.shiftRightUnsigned(reflected, num(b, 24)), num(b, 0xff)), width, mask, poly);
    feedByte(b, crc, b.bitAnd(b.shiftRightUnsigned(reflected, num(b, 16)), num(b, 0xff)), width, mask, poly);
    feedByte(b, crc, b.bitAnd(b.shiftRightUnsigned(reflected, num(b, 8)), num(b, 0xff)), width, mask, poly);
    feedByte(b, crc, b.bitAnd(reflected, num(b, 0xff)), width, mask, poly);
  } else if (size === 2) {
    feedByte(b, crc, b.bitAnd(b.shiftRightUnsigned(reflected, num(b, 8)), num(b, 0xff)), width, mask, poly);
    feedByte(b, crc, b.bitAnd(reflected, num(b, 0xff)), width, mask, poly);
  } else {
    feedByte(b, crc, b.bitAnd(reflected, num(b, 0xff)), width, mask, poly);
  }

  store(b, DR, b.bitAnd(b.getLocal(crc), mask));
}

function currentWidthMask(b: Body): Value<number> {
  return widthMask(b, widthOf(b, memory(b, CR)));
}

export function readCrc(b: Body, offset: Value<number>, size: number): Value<number> {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, DR)),
    (dr) => {
      const body = asBody(dr);
      const width = widthOf(body, memory(body, CR));
      const mask = widthMask(body, width);
      const raw = body.bitAnd(memory(body, DR), mask);
      const reflected = body.local(types.number, raw);

      body.if(
        body.notEqual(
          types.number,
          body.bitAnd(memory(body, CR), num(body, REV_OUT)),
          num(body, 0),
        ),
        (reverse) => {
          const scope = asBody(reverse);

          scope.setLocal(
            reflected,
            scope.shiftRightUnsigned(
              reverse32(scope, raw),
              scope.subtract(scope.constant(types.number, 32), width),
            ),
          );
        },
      );
      body.setLocal(result, body.bitAnd(body.getLocal(reflected), mask));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          boolOr(
            body,
            body.equal(types.number, wordOffset, num(body, IDR)),
            body.equal(types.number, wordOffset, num(body, CR)),
          ),
          boolOr(
            body,
            body.equal(types.number, wordOffset, num(body, INIT)),
            body.equal(types.number, wordOffset, num(body, POL)),
          ),
        ),
        (stored) => {
          const body2 = asBody(stored);
          const value = readWord(body2, CRC, wordOffset);

          body2.setLocal(
            result,
            body2.select(
              types.number,
              body2.equal(types.number, wordOffset, num(body2, CR)),
              (inner) => inner.bitAnd(value, inner.constant(types.number, CR_MASK)),
              () => value,
            ),
          );
        },
        (zero) => zero.setLocal(result, num(asBody(zero), 0)),
      );
    },
  );

  return u32(b, extract(b, b.getLocal(result), offset, size));
}

export function writeCrc(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));

  b.if(
    b.equal(types.number, wordOffset, num(b, DR)),
    (dr) => {
      const body = asBody(dr);

      feedValue(body, value, size, memory(body, CR));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, IDR)),
        (idr) => {
          const scope = asBody(idr);

          store(scope, IDR, merge(scope, memory(scope, IDR), value, offset, size));
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, CR)),
            (cr) => {
              const body2 = asBody(cr);
              const merged = merge(body2, memory(body2, CR), value, offset, size);
              const reset = boolBit(body2, u32(body2, value), RESET);

              store(body2, CR, body2.bitAnd(merged, num(body2, CR_MASK & ~RESET)));
              body2.if(reset, (hit) => {
                const body3 = asBody(hit);
                const initial = memory(body3, INIT);

                store(body3, DR, body3.bitAnd(initial, currentWidthMask(body3)));
              });
            },
            (rest) => {
              const body2 = asBody(rest);

              body2.if(
                body2.equal(types.number, wordOffset, num(body2, INIT)),
                (init) => {
                  const body3 = asBody(init);
                  const stored = merge(body3, memory(body3, INIT), value, offset, size);

                  store(body3, INIT, stored);
                  store(body3, DR, body3.bitAnd(stored, currentWidthMask(body3)));
                },
                (last) => {
                  const body3 = asBody(last);

                  body3.if(
                    body3.equal(types.number, wordOffset, num(body3, POL)),
                    (pol) => {
                      const body4 = asBody(pol);

                      store(body4, POL, merge(body4, memory(body4, POL), value, offset, size));
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );
}

export function readCrcAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  return readCrc(b, b.subtract(address, num(b, CRC_BASE)), size);
}

export function writeCrcAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeCrc(b, b.subtract(address, num(b, CRC_BASE)), size, value);
}

/** CRC 没有时间行为，也没有中断；只暴露 AHB 寄存器区间。 */
export const crcModule: PeripheralModule = {
  id: 'crc',
  ranges: [{ base: CRC_BASE, size: 0x20 }],
  read: readCrcAddress,
  write: writeCrcAddress,
};
