import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { EXTI, SYSCFG, SYSCFG_BASE, SYSCFG_SIZE } from './layout';
import type { AccessSize } from './layout';
import { EXTI_INIT } from './system-layout';
import { asBody, num, readWordAt, u32, writeWordAt } from './ir';
import type { Body } from './ir';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431 的 SYSCFG 子集。
 *
 * 只实现与 EXTI 路由相关的 `EXTICR1..4` 行为；其它寄存器保存最后写入值并读回。
 * `CFGR1` 的存储器重映射、`SCSR`、`SWPR`/`SKR` 等没有外部行为。EXTICR 变化会重置
 * line0–15 的边沿基线，避免切换端口时把当前电平误判成一次边沿。
 */

export { SYSCFG_BASE };

const MEMRMP = 0x00;
const CFGR1 = 0x04;
const EXTICR1 = 0x08;
const EXTICR2 = 0x0c;
const EXTICR3 = 0x10;
const EXTICR4 = 0x14;
const SCSR = 0x18;
const CFGR2 = 0x1c;
const SWPR = 0x20;
const SKR = 0x24;
const SWPR2 = 0x28;

const REGISTERS = [
  MEMRMP,
  CFGR1,
  EXTICR1,
  EXTICR2,
  EXTICR3,
  EXTICR4,
  SCSR,
  CFGR2,
  SWPR,
  SKR,
  SWPR2,
] as const;
const EXTICR = [EXTICR1, EXTICR2, EXTICR3, EXTICR4] as const;

const raw = (b: Body, offset: number): Value<number> => readWordAt(b, SYSCFG, offset & 0x3c);
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYSCFG, offset & 0x3c, u32(b, value));
};

const extract = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
};

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

  return b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed);
}

/** EXTI line 的端口选择（0=PA、1=PB、2=PC、3=PD、5=PF）。 */
export function readSyscfgExtiPort(b: Body, line: number): Value<number> {
  const register = EXTICR[line >>> 2]!;
  const shift = (line & 3) * 4;

  return b.bitAnd(b.shiftRightUnsigned(raw(b, register), num(b, shift)), num(b, 0xf));
}

/** 路由变化：清掉 EXTI line0–15 的基线，下一次采样重新建立。 */
function extiRouteChanged(b: Body): void {
  writeWordAt(
    b,
    EXTI,
    EXTI_INIT,
    b.bitAnd(readWordAt(b, EXTI, EXTI_INIT), num(b, ~0xffff)),
  );
}

/** SYSCFG 寄存器读。未实现偏移读 0。 */
export function readSyscfg(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  for (const register of REGISTERS)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      asBody(hit).setLocal(result, raw(asBody(hit), register));
    });

  return extract(b, b.getLocal(result), offset, size);
}

/** SYSCFG 寄存器写。EXTICR 之外的寄存器只保存值。 */
export function writeSyscfg(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  for (const register of REGISTERS)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      const body = asBody(hit);
      const current = raw(body, register);
      const next = merge(body, current, value, offset, size);

      store(body, register, next);
      if (register === EXTICR1 || register === EXTICR2 || register === EXTICR3 || register === EXTICR4)
        body.if(
          body.notEqual(types.number, body.bitXor(current, next), num(body, 0)),
          (changed) => {
            extiRouteChanged(asBody(changed));
          },
        );
    });
}

/** 注册到中央外设表的 SYSCFG 模块。 */
export const SYSCFG_MODULE: PeripheralModule = {
  id: 'syscfg',
  ranges: [{ base: SYSCFG_BASE, size: SYSCFG_SIZE }],
  read: (b, address, size) => readSyscfg(b, b.subtract(address, num(b, SYSCFG_BASE)), size),
  write: (b, address, size: AccessSize, value) =>
    writeSyscfg(b, b.subtract(address, num(b, SYSCFG_BASE)), size, value),
};

export { MEMRMP, CFGR1, EXTICR1, EXTICR2, EXTICR3, EXTICR4, SCSR, CFGR2, SWPR, SKR, SWPR2 };
