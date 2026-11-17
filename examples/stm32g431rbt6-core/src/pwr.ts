import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { vosLimitHz } from './clock-tree';
import { PERIPH, SCB_STATE, SYS } from './layout';
import {
  asBody,
  boolAnd,
  boolBitAt,
  boolOr,
  num,
  readWord,
  readWordAt,
  u32,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';

/**
 * PWR 寄存器模型（RM0440 第 6 章）。
 *
 * VOS 只存在于 CR1 bit10..9（复位缺省 01）；SR2 的 bit15..14 是 PVMO4/PVMO3，
 * 不是 VOS 副本。VOSF（SR2 bit10）是“电压档切换进行中”，本模型把调节器视为
 * 瞬时稳定，因此读回 0；SR2 的其它只读位原样保留。
 *
 * SR1 的 WUF1..5（bit0..4）与 SBF（bit8）只能由硬件唤醒/待机事件置位；软件写
 * SR1/SR2 被忽略。SCR 是纯写寄存器：写 1 到 CWUFx/CSBF 清除对应 SR1 位，读回
 * 恒为 0。`setWakeFlags`/`setStandbyFlag` 供中央在唤醒事件发生时置位。
 *
 * 低功耗：CR1.LPMS、CR3 的唤醒使能按寄存器保存；`lowPowerRequest` 给出
 * WFI/WFE 应进入的目标模式（Sleep/Stop0/Stop1/Standby/Shutdown），由 CPU/NVIC
 * 中央集成决定何时真正停时钟、何时由 EXTI 唤醒。**PWR 本身不会把 WFI 当 NOP，
 * 也不会假装执行了低功耗**。
 *
 * 地址说明：`bus.ts` 当前把 PWR 后备区放在 0x740。本模块导出 `PWR_REGISTERS`
 * 作为唯一常量；中央应让 bus/layout 直接引用它，而不是再保留 `PWR_STATE + 0x120`
 * 或字面量 0x740 的第二份事实。
 */

export const PWR_CR1 = 0x00;
export const PWR_CR2 = 0x04;
export const PWR_CR3 = 0x08;
export const PWR_CR4 = 0x0c;
export const PWR_SR1 = 0x10;
export const PWR_SR2 = 0x14;
export const PWR_SCR = 0x18;
export const PWR_PUCR = 0x20;
export const PWR_PDCR = 0x24;
export const PWR_CR5 = 0x80;

/** 与 bus.ts 的 PWR 后备区一致：0x740。中央应改为引用本常量。 */
export const PWR_REGISTERS = 0x740;

const VOS_MASK = 0x600;
const VOS_RESET = 0x200;
const VOSF = 1 << 10;
/** SCR 的 CWUF1..5（bit0..4）与 CSBF（bit8）。位号与 SR1 的 WUF/SBF 相同。 */
const SCR_W1C = 0x11f;
const SR1_FLAGS = 0x11f;
const LPMS_MASK = 0x7;
/** PWR_CR5.R1MODE 在 bit8；0=Range 1 boost，1=普通 Range 1。 */
const R1MODE = 1 << 8;

/** 已定义寄存器窗口；其余地址读 0、写忽略，避免与私有后备区/禁用区别名。 */
function visibleRegister(b: Body, offset: Value<number>): Value<boolean> {
  const inRange = (low: number, high: number): Value<boolean> =>
    boolAnd(b, b.greaterThanOrEqual(offset, num(b, low)), b.lessThanOrEqual(offset, num(b, high)));

  return boolOr(
    b,
    b.lessThanOrEqual(offset, num(b, PWR_CR4)),
    boolOr(
      b,
      inRange(PWR_SR1, PWR_SCR),
      boolOr(b, inRange(PWR_PUCR, 0x54), b.equal(types.number, offset, num(b, PWR_CR5))),
    ),
  );
}

/** PWR_CR1 的 VOS[1:0]（bit10..9）。0 按复位缺省 Range 1 处理。 */
export function voltageScalingOf(cr1: number): number {
  const vos = (cr1 & VOS_MASK) >>> 9;

  return vos === 0 ? 1 : vos;
}

/** CR5.R1MODE：1=普通 Range 1（150 MHz），0=Range 1 boost（170 MHz）。 */
export function isBoostMode(cr5: number): boolean {
  return (cr5 & R1MODE) === 0;
}

/** 当前 VOS 档位允许的最大 HCLK；未知组合返回 0。 */
export function voltageLimitHz(cr1: number, cr5: number): number {
  return vosLimitHz(voltageScalingOf(cr1), isBoostMode(cr5));
}

export const LOW_POWER_SLEEP = 0;
export const LOW_POWER_STOP0 = 1;
export const LOW_POWER_STOP1 = 2;
export const LOW_POWER_STANDBY = 3;
export const LOW_POWER_SHUTDOWN = 4;
export const LOW_POWER_INVALID = 5;

/**
 * SCB.SCR.SLEEPDEEP + PWR_CR1.LPMS 决定的目标低功耗模式。
 * `sleepDeep=false` 时 LPMS 不参与，目标是普通 Sleep。
 */
export function lowPowerModeOf(cr1: number, sleepDeep: boolean): number {
  if (!sleepDeep) return LOW_POWER_SLEEP;

  switch (cr1 & LPMS_MASK) {
    case 0:
      return LOW_POWER_STOP0;
    case 1:
      return LOW_POWER_STOP1;
    case 3:
      return LOW_POWER_STANDBY;
    case 4:
      return LOW_POWER_SHUTDOWN;
    default:
      return LOW_POWER_INVALID;
  }
}

const extract = (
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
};

const load = (b: Body, offset: number): Value<number> =>
  readWordAt(b, PERIPH, PWR_REGISTERS + offset);

/** 合成 CR1 的复位缺省 VOS 与 SR2 的 VOSF=0；不伪造 PVMO/VOS 副本。 */
export function readPwr(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);

  b.if(visibleRegister(b, wordOffset), (register) => {
    const scope = asBody(register);
    const stored = readWord(scope, PERIPH, scope.add(num(scope, PWR_REGISTERS), wordOffset));

    scope.if(
      scope.equal(types.number, wordOffset, num(scope, PWR_CR1)),
      (cr1) => {
        const body = asBody(cr1);
        const vos = body.bitAnd(stored, num(body, VOS_MASK));

        body.setLocal(
          result,
          body.select(
            types.number,
            body.equal(types.number, vos, num(body, 0)),
            (none) => none.bitOr(stored, none.constant(types.number, VOS_RESET)),
            () => stored,
          ),
        );
      },
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, PWR_SR2)),
          (sr2) => {
            // SR2 只清 VOSF；PVMO/PVDO/REGLPx 等只读位保持硬件后备值。
            const inner = asBody(sr2);

            inner.setLocal(result, inner.bitAnd(stored, inner.constant(types.number, ~VOSF)));
          },
          (third) => {
            const body2 = asBody(third);

            body2.if(
              body2.equal(types.number, wordOffset, num(body2, PWR_SCR)),
              (scr) => asBody(scr).setLocal(result, num(asBody(scr), 0)),
              (plain) => plain.setLocal(result, stored),
            );
          },
        );
      },
    );
  });

  return extract(b, b.getLocal(result), offset, size);
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

/**
 * PWR 写路径。
 *
 * - SR1/SR2 只读，软件写被忽略；
 * - SCR 写只在本次写的 lane 上清除 SR1.WUFx/SBF，SCR 自身读回 0；
 * - 其余已定义寄存器按宽度合并。
 *
 * 中央把 bus.ts 的 PWR 分支从通用后备区改为本函数后，上述语义才会对固件生效。
 */
export function writePwr(b: Body, offset: Value<number>, size: number, value: Value<number>): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  b.if(visibleRegister(b, wordOffset), (register) => {
    const scope = asBody(register);
    const at = scope.add(num(scope, PWR_REGISTERS), wordOffset);
    const current = readWord(scope, PERIPH, at);
    const merged = merge(scope, current, value, offset, size);

    scope.if(
      scope.equal(types.number, wordOffset, num(scope, PWR_SR1)),
      () => {},
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, PWR_SR2)),
          () => {},
          (writable) => {
            const body2 = asBody(writable);

            body2.if(
              body2.equal(types.number, wordOffset, num(body2, PWR_SCR)),
              (scr) => {
                const inner = asBody(scr);
                const clear = inner.bitAnd(merged, num(inner, SCR_W1C));
                const sr1 = readWordAt(inner, PERIPH, PWR_REGISTERS + PWR_SR1);

                writeWordAt(
                  inner,
                  PERIPH,
                  PWR_REGISTERS + PWR_SR1,
                  inner.bitAnd(sr1, inner.bitNot(clear)),
                );
                // SCR 是写 1 清除寄存器，读回恒 0。
                writeWordAt(inner, PERIPH, PWR_REGISTERS + PWR_SCR, num(inner, 0));
              },
              (plain) => {
                const inner = asBody(plain);

                writeWord(inner, PERIPH, at, merged);
              },
            );
          },
        );
      },
    );
  });
}

/** 硬件唤醒事件：置 SR1 的 WUF1..5/SBF（bit0..4、bit8），供 EXTI/RTC 中央调用。 */
export function setWakeFlags(b: Body, flags: Value<number>): void {
  const current = load(b, PWR_SR1);

  writeWordAt(
    b,
    PERIPH,
    PWR_REGISTERS + PWR_SR1,
    b.bitOr(current, b.bitAnd(flags, num(b, SR1_FLAGS))),
  );
}

/** 硬件待机事件：置 SR1.SBF。 */
export function setStandbyFlag(b: Body): void {
  setWakeFlags(b, num(b, 1 << 8));
}

/**
 * WFI/WFE 目标模式。中央在真正进入低功耗时调用：0=Sleep，1=Stop0，
 * 2=Stop1，3=Standby，4=Shutdown，5=LPMS 未定义。SCB.SCR.SLEEPDEEP 位于
 * `sys` 的 0x110（SCB_STATE + 0x10），由 nvic 的 SCB 写路径保存。
 */
export function lowPowerRequest(b: Body): Value<number> {
  const cr1 = load(b, PWR_CR1);
  const scr = readWordAt(b, SYS, SCB_STATE + 0x10);
  const sleepDeep = boolBitAt(b, scr, 2);
  const lpms = b.bitAnd(cr1, num(b, LPMS_MASK));
  const deep = b.select(
    types.number,
    b.equal(types.number, lpms, num(b, 0)),
    (inner) => inner.constant(types.number, LOW_POWER_STOP0),
    (next) =>
      next.select(
        types.number,
        next.equal(types.number, lpms, next.constant(types.number, 1)),
        (inner) => inner.constant(types.number, LOW_POWER_STOP1),
        (rest) =>
          rest.select(
            types.number,
            rest.equal(types.number, lpms, rest.constant(types.number, 3)),
            (inner) => inner.constant(types.number, LOW_POWER_STANDBY),
            (last) =>
              last.select(
                types.number,
                last.equal(types.number, lpms, last.constant(types.number, 4)),
                (inner) => inner.constant(types.number, LOW_POWER_SHUTDOWN),
                (none) => none.constant(types.number, LOW_POWER_INVALID),
              ),
          ),
      ),
  );

  return b.select(
    types.number,
    sleepDeep,
    () => deep,
    (inner) => inner.constant(types.number, LOW_POWER_SLEEP),
  );
}

/** CR3 的 EWUP1..5（bit0..4）唤醒引脚使能。 */
export function wakeupEnabled(b: Body, line: number): Value<boolean> {
  const cr3 = load(b, PWR_CR3);

  return boolBitAt(b, cr3, line);
}
