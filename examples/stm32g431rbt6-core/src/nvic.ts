import { types } from '@mica-js/sdk/model';
import type { Local, Value } from '@mica-js/sdk/model';
import {
  APSR_T,
  CCM,
  CCM_BASE,
  CCM_SIZE,
  CODE,
  FLASH_BASE,
  FLASH_SIZE,
  IRQ_DIRTY,
  NVIC_BASE,
  NVIC_STATE,
  SCB_BASE,
  SCB_STATE,
  SERVICE_IRQ,
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
  SYS,
  SYSTICK_BASE,
  SYSTICK_CTRL,
  SYSTICK_PENDING,
  exceptionOf,
} from './layout';
import {
  asBody,
  bool,
  boolAnd,
  boolBit,
  boolOr,
  markService,
  num,
  readApsr,
  readLr,
  readReg,
  readSp,
  readWord,
  readWordAt,
  u32,
  writeLr,
  writeReg,
  writeSp,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import {
  SYSTICK_EXCEPTION,
  acknowledgeSystick,
  readSystick,
  systickPending,
  writeSystick,
} from './systick';
import { USARTS, usartPending } from './usart';
import { extiOn, sampleExti } from './exti';
import { CPU_HIDDEN_EVENT, clearExclusiveOnException } from './exclusive';
import {
  RESET_CAUSE_SYSRESETREQ,
  RESET_CAUSE_VECTRESET,
  applyPendingReset,
  requestReset,
  resetPending,
} from './reset';

/**
 * NVIC、SCB 与 Cortex-M4 异常入口/返回。
 *
 * 资源分区（都在现有 `sys` 0x200 内，不新增 DDL state）：
 * - `NVIC_STATE + 0x00`：ISER bank0–3；
 * - `NVIC_STATE + 0x10`：ISPR bank0–3；
 * - `NVIC_STATE + 0x20`：IABR bank0–3；
 * - `NVIC_STATE + 0x30`：IPR0–31 字（每 IRQ 一个字节，仅高 4 位实现）；
 * - `SCB_STATE + 真实偏移`：VTOR/AIRCR/SCR/CCR/SHPR/SHCSR/CFSR/HFSR/…/CPACR；
 * - `SCB_STATE + 0x90` 起：CONTROL/BASEPRI/FAULTMASK/PSP/MSP/PendSV/NMI/HardFault/
 *   模式/active 栈等隐藏状态。
 *
 * G431 实现 4 个优先级位；NVIC 保留 4 个 bank（IRQ 0–127），但只有官方 IRQ 表里的
 * 编号有效（最大 101 FMAC），reserved holes 读 0、写忽略。外部挂起来源统一来自
 * `machine().interruptSources`（`PeripheralModule.interrupts`）与核心 USART；NVIC 不
 * import 具体外设，避免环。
 *
 * 支持范围：NMI/HardFault/SVCall/PendSV/SysTick 与外部 IRQ 的入口、8 字基本栈帧、
 * MSP/PSP、EXC_RETURN、4 位优先级/PRIGROUP/PRIMASK/BASEPRI/FAULTMASK 仲裁、基本嵌套。
 * MemManage/BusFault/UsageFault 独立入口与 lockup 不在范围内；相关故障统一升级为
 * HardFault。
 */

export const NVIC_BANK_COUNT = 4;
export const NVIC_IRQ_COUNT = 128;
export const G431_IRQ_MAX = 101;

/** STM32G431 实际实现的 IRQ 编号；reserved holes 不置位。 */
export const G431_VALID_IRQS: readonly number[] = Object.freeze([
  ...range(0, 16),
  ...range(18, 46),
  49,
  51,
  52,
  ...range(54, 60),
  63,
  64,
  65,
  75,
  76,
  81,
  ...range(90, 94),
  97,
  100,
  101,
]);

function range(first: number, last: number): number[] {
  const values: number[] = [];

  for (let value = first; value <= last; value += 1) values.push(value);
  return values;
}

const BANK_MASKS: readonly number[] = (() => {
  const masks = [0, 0, 0, 0];

  for (const irq of G431_VALID_IRQS)
    masks[irq >>> 5] = (masks[irq >>> 5]! | (1 << (irq & 31))) >>> 0;
  return masks;
})();

const VALID_SET = new Set(G431_VALID_IRQS);

const ENABLED = NVIC_STATE + 0x00;
const PENDING = NVIC_STATE + 0x10;
const ACTIVE = NVIC_STATE + 0x20;
const PRIORITY = NVIC_STATE + 0x30;
const PRIORITY_WORDS = 32;

const VTOR = SCB_STATE + 0x08;
const AIRCR = SCB_STATE + 0x0c;
const SCR = SCB_STATE + 0x10;
const CCR = SCB_STATE + 0x14;
const SHPR1 = SCB_STATE + 0x18;
const SHPR2 = SCB_STATE + 0x1c;
const SHPR3 = SCB_STATE + 0x20;
const SHCSR = SCB_STATE + 0x24;
const CFSR = SCB_STATE + 0x28;
const HFSR = SCB_STATE + 0x2c;
const DFSR = SCB_STATE + 0x30;
const MMFAR = SCB_STATE + 0x34;
const BFAR = SCB_STATE + 0x38;
const AFSR = SCB_STATE + 0x3c;

/* 隐藏状态（SYS 内存；不会被固件通过 SCB 偏移看到）。 */
const H_CONTROL = SCB_STATE + 0x90;
const H_BASEPRI = SCB_STATE + 0x94;
const H_FAULTMASK = SCB_STATE + 0x98;
const H_PSP = SCB_STATE + 0x9c;
const H_MSP = SCB_STATE + 0xa0;
const H_PENDSV = SCB_STATE + 0xa4;
const H_NMI = SCB_STATE + 0xa8;
const H_HARDFAULT = SCB_STATE + 0xac;
const H_USAGEFAULT = SCB_STATE + 0xf8;
const H_MODE = SCB_STATE + 0xb0;
const H_DEPTH = SCB_STATE + 0xb4;
const H_ACTIVE_EXC = SCB_STATE + 0xb8;
const H_ACTIVE_GROUP = SCB_STATE + 0xd8;
const H_VECTPENDING = 0x00;
const H_ISRPENDING = 0x04;

/** 异常入口清理钩子（CPU 独占监视器等模块注册；不建立第二套异常栈）。 */
export type ExceptionEntryHook = (b: Body) => void;

const exceptionEntryHooks: ExceptionEntryHook[] = [];

export function registerExceptionEntryHook(hook: ExceptionEntryHook): void {
  if (!exceptionEntryHooks.includes(hook)) exceptionEntryHooks.push(hook);
}

// 所有异常入口统一清 local exclusive monitor（SVC/PendSV/NMI/HardFault/IRQ 均经过
// enterException 的 hook 链，不只 SVC）。
registerExceptionEntryHook(clearExclusiveOnException);

const ACTIVE_SLOTS = 8;
const EXC_RETURN_HANDLER_MSP = 0xfffffff1;
const EXC_RETURN_THREAD_MSP = 0xfffffff9;
const EXC_RETURN_THREAD_PSP = 0xfffffffd;

export const EXCEPTION_NMI = 2;
export const EXCEPTION_HARDFAULT = 3;
export const EXCEPTION_USAGEFAULT = 6;
export const EXCEPTION_SVCALL = 11;
export const EXCEPTION_PENDSV = 14;
export const EXCEPTION_SYSTICK = 15;

const load = (b: Body, offset: number): Value<number> => readWordAt(b, SYS, offset);
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYS, offset, value);
};
const loadAt = (b: Body, offset: Value<number>): Value<number> => readWord(b, SYS, offset);
const storeAt = (b: Body, offset: Value<number>, value: Value<number>): void => {
  writeWord(b, SYS, offset, value);
};

const inRegion = (b: Body, value: Value<number>, low: number, high: number): Value<boolean> =>
  boolAnd(b, b.greaterThanOrEqual(value, num(b, low)), b.lessThan(value, num(b, high)));

const bankOf = (irq: number): number => irq >>> 5;
const bitOf = (irq: number): number => irq & 31;

function bankWord(b: Body, base: number, bank: number): Value<number> {
  return load(b, base + bank * 4);
}

function bankWrite(b: Body, base: number, bank: number, value: Value<number>): void {
  store(b, base + bank * 4, value);
}

function bankBit(b: Body, base: number, index: number): Value<boolean> {
  return b.notEqual(
    types.number,
    b.bitAnd(bankWord(b, base, bankOf(index)), num(b, 1 << bitOf(index))),
    num(b, 0),
  );
}

function bankMaskValue(b: Body, bank: Value<number>): Value<number> {
  let value = num(b, BANK_MASKS[0]!);

  for (let index = 1; index < BANK_MASKS.length; index += 1)
    value = b.select(
      types.number,
      b.equal(types.number, bank, num(b, index)),
      (inner) => inner.constant(types.number, BANK_MASKS[index]!),
      () => value,
    );
  return value;
}

/** 非零 bank 位图的最低置位下标；无符号移位也能处理 bit 31。 */
function firstIrqBit(b: Body, bits: Value<number>): Value<number> {
  let word = bits;
  let index = num(b, 0);

  for (const width of [16, 8, 4, 2, 1]) {
    const skip = b.select(
      types.number,
      b.equal(types.number, b.bitAnd(word, num(b, (1 << width) - 1)), num(b, 0)),
      (high) => high.constant(types.number, width),
      (low) => low.constant(types.number, 0),
    );

    index = b.add(index, skip);
    word = b.shiftRightUnsigned(word, skip);
  }
  return index;
}

/** 静态 IRQ 是否使能。 */
export function nvicEnabled(b: Body, irq: number): Value<boolean> {
  return bankBit(b, ENABLED, irq);
}

/** 静态 IRQ 的 NVIC 挂起（不含外设电平来源）。 */
export function nvicPendingStored(b: Body, irq: number): Value<boolean> {
  return bankBit(b, PENDING, irq);
}

/** 静态 IRQ 的 NVIC active 位。 */
export function nvicActive(b: Body, irq: number): Value<boolean> {
  return bankBit(b, ACTIVE, irq);
}

export function setIrqPending(b: Body, irq: number): void {
  if (!VALID_SET.has(irq)) return;
  const bank = bankOf(irq);

  bankWrite(b, PENDING, bank, b.bitOr(bankWord(b, PENDING, bank), num(b, 1 << bitOf(irq))));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function clearIrqPending(b: Body, irq: number): void {
  const bank = bankOf(irq);

  bankWrite(b, PENDING, bank, b.bitAnd(bankWord(b, PENDING, bank), num(b, ~(1 << bitOf(irq)))));
}

function clearPendingDynamic(b: Body, exception: Value<number>): void {
  b.if(b.greaterThanOrEqual(exception, num(b, 16)), (external) => {
    const scope = asBody(external);
    const irq = scope.subtract(exception, num(scope, 16));
    const bank = scope.shiftRightUnsigned(irq, num(scope, 5));
    const bit = scope.shiftLeft(num(scope, 1), scope.bitAnd(irq, num(scope, 31)));
    const at = scope.add(num(scope, PENDING), scope.shiftLeft(bank, num(scope, 2)));

    storeAt(scope, at, scope.bitAnd(loadAt(scope, at), scope.bitNot(bit)));
  });
}

function setActiveDynamic(b: Body, exception: Value<number>): void {
  b.if(b.greaterThanOrEqual(exception, num(b, 16)), (external) => {
    const scope = asBody(external);
    const irq = scope.subtract(exception, num(scope, 16));
    const bank = scope.shiftRightUnsigned(irq, num(scope, 5));
    const bit = scope.shiftLeft(num(scope, 1), scope.bitAnd(irq, num(scope, 31)));
    const at = scope.add(num(scope, ACTIVE), scope.shiftLeft(bank, num(scope, 2)));

    storeAt(scope, at, scope.bitOr(loadAt(scope, at), bit));
  });
}

function clearActiveDynamic(b: Body, exception: Value<number>): void {
  b.if(b.greaterThanOrEqual(exception, num(b, 16)), (external) => {
    const scope = asBody(external);
    const irq = scope.subtract(exception, num(scope, 16));
    const bank = scope.shiftRightUnsigned(irq, num(scope, 5));
    const bit = scope.shiftLeft(num(scope, 1), scope.bitAnd(irq, num(scope, 31)));
    const at = scope.add(num(scope, ACTIVE), scope.shiftLeft(bank, num(scope, 2)));

    storeAt(scope, at, scope.bitAnd(loadAt(scope, at), scope.bitNot(bit)));
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

function placed(b: Body, value: Value<number>, offset: Value<number>, size: number): Value<number> {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
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
  const mask = b.shiftLeft(num(b, width), shift);

  return b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed(b, value, offset, size));
}

function priorityMerge(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const width = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
  const byteMask = width === 0xffffffff ? 0xf0f0f0f0 : 0xf0f0;
  const mask = b.shiftLeft(num(b, byteMask), shift);
  const bits = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);

  return b.bitOr(b.bitAnd(current, b.bitNot(mask)), b.bitAnd(bits, mask));
}

/* ---------------- NVIC 寄存器 ---------------- */

export function readNvic(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0xfff));
  const result = b.local(types.number, 0);

  b.if(
    b.lessThan(wordOffset, num(b, 0x20)),
    (enable) => {
      const body = asBody(enable);
      const bank = body.shiftRightUnsigned(wordOffset, num(body, 2));

      body.if(body.lessThan(bank, num(body, NVIC_BANK_COUNT)), (valid) => {
        const inner = asBody(valid);

        inner.setLocal(
          result,
          inner.bitAnd(
            readWord(
              inner,
              SYS,
              inner.add(num(inner, ENABLED), inner.shiftLeft(bank, num(inner, 2))),
            ),
            bankMaskValue(inner, bank),
          ),
        );
      });
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, wordOffset, 0x80, 0xa0),
        (disable) => disable.setLocal(result, num(asBody(disable), 0)),
        (next) => {
          const scope = asBody(next);

          scope.if(
            inRegion(scope, wordOffset, 0x100, 0x120),
            (pending) => {
              const inner = asBody(pending);
              const bank = inner.shiftRightUnsigned(wordOffset, num(inner, 2));
              const mask = bankMaskValue(inner, bank);
              const stored = readWord(
                inner,
                SYS,
                inner.add(num(inner, PENDING), inner.shiftLeft(bank, num(inner, 2))),
              );
              const derived = derivedPending(inner, bank);

              inner.setLocal(result, inner.bitAnd(inner.bitOr(stored, derived), mask));
            },
            (afterPending) => {
              const inner = asBody(afterPending);

              inner.if(
                inRegion(inner, wordOffset, 0x180, 0x1a0),
                (clearPending) => clearPending.setLocal(result, num(asBody(clearPending), 0)),
                (afterClear) => {
                  const scope2 = asBody(afterClear);

                  scope2.if(
                    inRegion(scope2, wordOffset, 0x200, 0x220),
                    (active) => {
                      const body2 = asBody(active);
                      const bank = body2.shiftRightUnsigned(wordOffset, num(body2, 2));

                      body2.setLocal(
                        result,
                        body2.bitAnd(
                          readWord(
                            body2,
                            SYS,
                            body2.add(num(body2, ACTIVE), body2.shiftLeft(bank, num(body2, 2))),
                          ),
                          bankMaskValue(body2, bank),
                        ),
                      );
                    },
                    (afterActive) => {
                      const body2 = asBody(afterActive);
                      const index = body2.shiftRightUnsigned(
                        body2.subtract(wordOffset, num(body2, 0x300)),
                        num(body2, 2),
                      );

                      body2.if(
                        boolAnd(
                          body2,
                          body2.greaterThanOrEqual(wordOffset, num(body2, 0x300)),
                          body2.lessThan(index, num(body2, PRIORITY_WORDS)),
                        ),
                        (priority) => {
                          const inner2 = asBody(priority);

                          inner2.setLocal(
                            result,
                            readWord(
                              inner2,
                              SYS,
                              inner2.add(
                                num(inner2, PRIORITY),
                                inner2.multiply(index, num(inner2, 4)),
                              ),
                            ),
                          );
                        },
                        (tail) => {
                          const last = asBody(tail);

                          // STIR 读回 0。
                          last.if(
                            last.equal(types.number, wordOffset, num(last, 0xe00)),
                            (stir) => stir.setLocal(result, num(asBody(stir), 0)),
                            () => {},
                          );
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
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeNvic(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0xfff));

  const applyBank = (
    body: Body,
    base: number,
    innerOffset: Value<number>,
    op: 'set' | 'clear',
  ): void => {
    const bank = body.shiftRightUnsigned(innerOffset, num(body, 2));
    const mask = bankMaskValue(body, bank);
    const bits = body.bitAnd(placed(body, value, offset, size), mask);
    const at = body.add(num(body, base), body.shiftLeft(bank, num(body, 2)));
    const current = loadAt(body, at);

    storeAt(
      body,
      at,
      op === 'set' ? body.bitOr(current, bits) : body.bitAnd(current, body.bitNot(bits)),
    );
    body.writeState(IRQ_DIRTY, bool(body, true));
    markService(body, SERVICE_IRQ);
  };

  b.if(
    b.lessThan(wordOffset, num(b, 0x20)),
    (enable) => applyBank(asBody(enable), ENABLED, wordOffset, 'set'),
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, wordOffset, 0x80, 0xa0),
        (disable) => {
          const inner = asBody(disable);

          applyBank(inner, ENABLED, inner.subtract(wordOffset, num(inner, 0x80)), 'clear');
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            inRegion(scope, wordOffset, 0x100, 0x120),
            (pending) => {
              const inner = asBody(pending);

              applyBank(inner, PENDING, inner.subtract(wordOffset, num(inner, 0x100)), 'set');
            },
            (afterPending) => {
              const inner = asBody(afterPending);

              inner.if(
                inRegion(inner, wordOffset, 0x180, 0x1a0),
                (clearPending) => {
                  const scope2 = asBody(clearPending);

                  applyBank(
                    scope2,
                    PENDING,
                    scope2.subtract(wordOffset, num(scope2, 0x180)),
                    'clear',
                  );
                },
                (afterClear) => {
                  const scope2 = asBody(afterClear);
                  const index = scope2.shiftRightUnsigned(
                    scope2.subtract(wordOffset, num(scope2, 0x300)),
                    num(scope2, 2),
                  );

                  scope2.if(
                    boolAnd(
                      scope2,
                      scope2.greaterThanOrEqual(wordOffset, num(scope2, 0x300)),
                      scope2.lessThan(index, num(scope2, PRIORITY_WORDS)),
                    ),
                    (priority) => {
                      const body2 = asBody(priority);
                      const at = body2.add(
                        num(body2, PRIORITY),
                        body2.multiply(index, num(body2, 4)),
                      );

                      storeAt(
                        body2,
                        at,
                        priorityMerge(body2, loadAt(body2, at), value, offset, size),
                      );
                      body2.writeState(IRQ_DIRTY, bool(body2, true));
                      markService(body2, SERVICE_IRQ);
                    },
                    (tail) => {
                      const last = asBody(tail);
                      const channel = last.bitAnd(u32(last, value), num(last, 0x1ff));
                      const bank = last.shiftRightUnsigned(channel, num(last, 5));
                      const mask = bankMaskValue(last, bank);
                      const bit = last.shiftLeft(num(last, 1), last.bitAnd(channel, num(last, 31)));
                      const valid = last.notEqual(
                        types.number,
                        last.bitAnd(mask, bit),
                        num(last, 0),
                      );

                      last.if(
                        boolAnd(
                          last,
                          last.equal(types.number, wordOffset, num(last, 0xe00)),
                          valid,
                        ),
                        (stir) => {
                          const inner2 = asBody(stir);

                          setPendingDynamic(inner2, channel);
                        },
                        () => {},
                      );
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

function setPendingDynamic(b: Body, channel: Value<number>): void {
  const bank = b.shiftRightUnsigned(channel, num(b, 5));
  const bit = b.shiftLeft(num(b, 1), b.bitAnd(channel, num(b, 31)));
  const at = b.add(num(b, PENDING), b.shiftLeft(bank, num(b, 2)));

  storeAt(b, at, b.bitOr(loadAt(b, at), bit));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

/* ---------------- 挂起来源 ---------------- */

function acknowledgeIrqSources(b: Body, irq: number): void {
  for (const source of machine().interruptSources)
    if (source.exception === irq + 16) source.acknowledge(b);
}

function derivedPending(b: Body, bank: Value<number>): Value<number> {
  let selected = derivedBankMask(b, 0);

  for (let index = 1; index < NVIC_BANK_COUNT; index += 1)
    selected = b.select(
      types.number,
      b.equal(types.number, bank, num(b, index)),
      (inner) => derivedBankMask(asBody(inner), index),
      () => selected,
    );

  return selected;
}

function derivedBankMask(b: Body, bank: number): Value<number> {
  let mask = num(b, 0);

  for (const source of machine().interruptSources) {
    const irq = source.exception - 16;

    if (irq < 0 || bankOf(irq) !== bank || !VALID_SET.has(irq)) continue;
    const bit = 1 << bitOf(irq);

    mask = b.bitOr(
      mask,
      b.select(
        types.number,
        source.pending(b),
        (inner) => inner.constant(types.number, bit),
        (inner) => inner.constant(types.number, 0),
      ),
    );
  }

  for (const config of USARTS) {
    if (bankOf(config.irq) !== bank) continue;
    const bit = 1 << bitOf(config.irq);

    mask = b.bitOr(
      mask,
      b.select(
        types.number,
        usartPending(b, config),
        (inner) => inner.constant(types.number, bit),
        (inner) => inner.constant(types.number, 0),
      ),
    );
  }

  return mask;
}

/* ---------------- 特殊寄存器 / 隐藏状态 ---------------- */

const readHidden = (b: Body, offset: number): Value<number> => load(b, offset);
const writeHidden = (b: Body, offset: number, value: Value<number>): void => {
  store(b, offset, value);
};

export const readPrimask = (b: Body): Value<number> => b.readState('primask', types.number);
export const writePrimask = (b: Body, value: Value<number>): void => {
  b.writeState('primask', b.bitAnd(u32(b, value), num(b, 1)));
};

export const readBasepri = (b: Body): Value<number> => readHidden(b, H_BASEPRI);
export function writeBasepri(b: Body, value: Value<number>): void {
  writeHidden(b, H_BASEPRI, b.bitAnd(u32(b, value), num(b, 0xf0)));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export const readFaultmask = (b: Body): Value<number> => readHidden(b, H_FAULTMASK);
export function writeFaultmask(b: Body, value: Value<number>): void {
  writeHidden(b, H_FAULTMASK, b.bitAnd(u32(b, value), num(b, 1)));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export const readControl = (b: Body): Value<number> => readHidden(b, H_CONTROL);

/** Handler 模式始终 privileged；Thread 模式由 CONTROL.nPRIV 决定。 */
export const isPrivileged = (b: Body): Value<boolean> =>
  boolOr(
    b,
    b.equal(types.number, readHidden(b, H_MODE), num(b, 1)),
    b.equal(types.number, b.bitAnd(readHidden(b, H_CONTROL), num(b, 1)), num(b, 0)),
  );

export function writeControl(b: Body, value: Value<number>): void {
  const next = b.bitAnd(u32(b, value), num(b, 0x7));
  const previous = readHidden(b, H_CONTROL);
  const oldSpsel = boolBit(b, previous, 2);
  const newSpsel = boolBit(b, next, 2);
  const thread = b.equal(types.number, readHidden(b, H_MODE), num(b, 0));

  b.if(boolAnd(b, thread, boolAnd(b, b.not(oldSpsel), newSpsel)), (toPsp) => {
    const body = asBody(toPsp);

    writeHidden(body, H_MSP, readSp(body));
    writeSp(body, readHidden(body, H_PSP));
  });
  b.if(boolAnd(b, thread, boolAnd(b, oldSpsel, b.not(newSpsel))), (toMsp) => {
    const body = asBody(toMsp);

    writeHidden(body, H_PSP, readSp(body));
    writeSp(body, readHidden(body, H_MSP));
  });
  writeHidden(b, H_CONTROL, next);
}

export const readPsp = (b: Body): Value<number> => readHidden(b, H_PSP);
export function writePsp(b: Body, value: Value<number>): void {
  writeHidden(b, H_PSP, u32(b, value));
  b.if(
    boolAnd(
      b,
      b.equal(types.number, readHidden(b, H_MODE), num(b, 0)),
      boolBit(b, readHidden(b, H_CONTROL), 2),
    ),
    (active) => writeSp(asBody(active), value),
  );
}

export const readMsp = (b: Body): Value<number> => {
  const result = b.local(types.number, 0);

  b.if(
    boolOr(
      b,
      b.equal(types.number, readHidden(b, H_MODE), num(b, 1)),
      b.not(boolBit(b, readHidden(b, H_CONTROL), 2)),
    ),
    (current) => current.setLocal(result, readSp(asBody(current))),
    (saved) => saved.setLocal(result, readHidden(asBody(saved), H_MSP)),
  );

  return b.getLocal(result);
};

export function writeMsp(b: Body, value: Value<number>): void {
  b.if(
    boolOr(
      b,
      b.equal(types.number, readHidden(b, H_MODE), num(b, 1)),
      b.not(boolBit(b, readHidden(b, H_CONTROL), 2)),
    ),
    (current) => writeSp(asBody(current), value),
    (saved) => writeHidden(asBody(saved), H_MSP, u32(asBody(saved), value)),
  );
}

function priorityByteOfSystem(b: Body, exception: number): Value<number> {
  if (exception <= 7)
    return b.bitAnd(
      b.shiftRightUnsigned(load(b, SHPR1), num(b, (exception - 4) * 8)),
      num(b, 0xf0),
    );
  if (exception <= 11)
    return b.bitAnd(
      b.shiftRightUnsigned(load(b, SHPR2), num(b, (exception - 8) * 8)),
      num(b, 0xf0),
    );

  return b.bitAnd(b.shiftRightUnsigned(load(b, SHPR3), num(b, (exception - 12) * 8)), num(b, 0xf0));
}

function priorityByteOfIrqDynamic(b: Body, irq: Value<number>): Value<number> {
  const at = b.add(num(b, PRIORITY), b.shiftLeft(b.shiftRightUnsigned(irq, num(b, 2)), num(b, 2)));
  const shift = b.multiply(b.bitAnd(irq, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(loadAt(b, at), shift), num(b, 0xf0));
}

function prigroup(b: Body): Value<number> {
  return b.bitAnd(b.shiftRightUnsigned(load(b, AIRCR), num(b, 8)), num(b, 7));
}

function groupShift(b: Body): Value<number> {
  const value = prigroup(b);

  return b.select(
    types.number,
    b.greaterThan(value, num(b, 4)),
    (inner) => inner.constant(types.number, 4),
    () => value,
  );
}

function groupOf(b: Body, priority: Value<number>): Value<number> {
  return b.shiftRightUnsigned(priority, groupShift(b));
}

function currentException(b: Body): Value<number> {
  const depth = readHidden(b, H_DEPTH);
  const result = b.local(types.number, 0);

  b.if(b.greaterThan(depth, num(b, 0)), (running) => {
    const body = asBody(running);
    const index = body.subtract(depth, num(body, 1));

    body.setLocal(
      result,
      loadAt(body, body.add(num(body, H_ACTIVE_EXC), body.multiply(index, num(body, 4)))),
    );
  });

  return b.getLocal(result);
}

function currentGroup(b: Body): Value<number> {
  const depth = readHidden(b, H_DEPTH);
  const result = b.local(types.number, 256);

  b.if(b.greaterThan(depth, num(b, 0)), (running) => {
    const body = asBody(running);
    const index = body.subtract(depth, num(body, 1));

    body.setLocal(
      result,
      loadAt(body, body.add(num(body, H_ACTIVE_GROUP), body.multiply(index, num(body, 4)))),
    );
  });

  return b.getLocal(result);
}

function pushActive(b: Body, exception: Value<number>, group: Value<number>): void {
  for (let index = ACTIVE_SLOTS - 1; index >= 1; index -= 1) {
    writeWordAt(
      b,
      SYS,
      H_ACTIVE_EXC + index * 4,
      readWordAt(b, SYS, H_ACTIVE_EXC + (index - 1) * 4),
    );
    writeWordAt(
      b,
      SYS,
      H_ACTIVE_GROUP + index * 4,
      readWordAt(b, SYS, H_ACTIVE_GROUP + (index - 1) * 4),
    );
  }
  writeWordAt(b, SYS, H_ACTIVE_EXC, exception);
  writeWordAt(b, SYS, H_ACTIVE_GROUP, group);

  const depth = readHidden(b, H_DEPTH);
  const next = b.select(
    types.number,
    b.greaterThanOrEqual(depth, num(b, ACTIVE_SLOTS)),
    (inner) => inner.constant(types.number, ACTIVE_SLOTS),
    (inner) => inner.add(depth, inner.constant(types.number, 1)),
  );

  writeHidden(b, H_DEPTH, next);
}

function popActive(b: Body): void {
  const depth = readHidden(b, H_DEPTH);

  b.if(b.greaterThan(depth, num(b, 0)), (any) => {
    const body = asBody(any);
    const index = body.subtract(depth, num(body, 1));
    const exception = loadAt(
      body,
      body.add(num(body, H_ACTIVE_EXC), body.multiply(index, num(body, 4))),
    );

    clearActiveDynamic(body, exception);
    writeHidden(body, H_DEPTH, index);
  });
}

/* ---------------- 异常入口/返回 ---------------- */

function stackStore(b: Body, address: Value<number>, value: Value<number>): void {
  b.if(inRegion(b, address, SRAM_BASE, SRAM_BASE + SRAM_SIZE), (ram) => {
    const body = asBody(ram);

    writeWord(body, SRAM, body.subtract(address, num(body, SRAM_BASE)), value);
  });
  b.if(inRegion(b, address, CCM_BASE, CCM_BASE + CCM_SIZE), (ccm) => {
    const body = asBody(ccm);

    writeWord(body, CCM, body.subtract(address, num(body, CCM_BASE)), value);
  });
}

function stackLoad(b: Body, address: Value<number>): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    inRegion(b, address, SRAM_BASE, SRAM_BASE + SRAM_SIZE),
    (ram) => {
      const body = asBody(ram);

      ram.setLocal(result, readWord(body, SRAM, body.subtract(address, num(body, SRAM_BASE))));
    },
    (other) => {
      const body = asBody(other);

      body.if(inRegion(body, address, CCM_BASE, CCM_BASE + CCM_SIZE), (ccm) => {
        const scope = asBody(ccm);

        ccm.setLocal(result, readWord(scope, CCM, scope.subtract(address, num(scope, CCM_BASE))));
      });
    },
  );

  return b.getLocal(result);
}

function vectorHandler(b: Body, exception: Value<number>): Value<number> {
  const vector = b.add(load(b, VTOR), b.shiftLeft(exception, num(b, 2)));
  const result = b.local(types.number, 0);

  b.if(
    boolAnd(
      b,
      b.greaterThanOrEqual(vector, num(b, FLASH_BASE)),
      b.lessThan(vector, num(b, FLASH_BASE + FLASH_SIZE)),
    ),
    (flash) => {
      const body = asBody(flash);

      body.setLocal(result, readWord(body, CODE, body.subtract(vector, num(body, FLASH_BASE))));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolAnd(
          body,
          body.greaterThanOrEqual(vector, num(body, 0)),
          body.lessThan(vector, num(body, FLASH_SIZE)),
        ),
        (alias) => {
          const inner = asBody(alias);

          inner.setLocal(result, readWord(inner, CODE, vector));
        },
        (ram) => {
          const inner = asBody(ram);

          inner.setLocal(result, stackLoad(inner, inner.bitAnd(vector, num(inner, 0xfffffffc))));
        },
      );
    },
  );

  return b.bitAnd(b.getLocal(result), num(b, 0xfffffffe));
}

/**
 * 异常入口：压 8 字基本帧并转向向量。
 *
 * `group` 是已经按当前 PRIGROUP 折算的抢占优先级（NMI=-2、HardFault=-1、可配置异常
 * ≥0）。`returnPc` 是异常返回后恢复的 PC。
 */
export function enterException(
  b: Body,
  exception: Value<number> | number,
  returnPc: number | Value<number>,
  group: Value<number> | number,
): void {
  const exc = typeof exception === 'number' ? num(b, exception) : exception;
  const grp = typeof group === 'number' ? num(b, group) : group;
  const mode = readHidden(b, H_MODE);
  const spsel = boolBit(b, readHidden(b, H_CONTROL), 2);
  const fromThread = b.equal(types.number, mode, num(b, 0));
  const usePsp = boolAnd(b, fromThread, spsel);
  const sp = readSp(b);
  const frameSize = 32;
  const frame = b.subtract(b.bitAnd(sp, num(b, 0xfffffff8)), num(b, frameSize));
  // CCR.STKALIGN is fixed at 1. Stacked xPSR[9] records the optional word above the frame.
  const padding = b.shiftLeft(b.bitAnd(sp, num(b, 4)), num(b, 7));
  const xpsr = b.bitOr(b.bitOr(readApsr(b), num(b, APSR_T)), padding);
  const storedLr = readLr(b);
  const returnValue = typeof returnPc === 'number' ? num(b, returnPc) : returnPc;

  stackStore(b, frame, readReg(b, 0));
  stackStore(b, b.add(frame, num(b, 4)), readReg(b, 1));
  stackStore(b, b.add(frame, num(b, 8)), readReg(b, 2));
  stackStore(b, b.add(frame, num(b, 12)), readReg(b, 3));
  stackStore(b, b.add(frame, num(b, 16)), readReg(b, 12));
  stackStore(b, b.add(frame, num(b, 20)), storedLr);
  stackStore(b, b.add(frame, num(b, 24)), returnValue);
  stackStore(b, b.add(frame, num(b, 28)), xpsr);

  // Thread+PSP 时栈帧仍在 PSP 上；handler 改用 MSP（隐藏值）。
  b.if(
    usePsp,
    (psp) => {
      const body = asBody(psp);

      writeHidden(body, H_PSP, frame);
      writeSp(body, readHidden(body, H_MSP));
    },
    (msp) => writeSp(asBody(msp), frame),
  );

  writeHidden(b, H_MODE, num(b, 1));
  pushActive(b, exc, grp);
  for (const hook of exceptionEntryHooks) hook(b);
  setActiveDynamic(b, exc);

  const excReturn = b.select(
    types.number,
    fromThread,
    (thread) =>
      thread.select(
        types.number,
        usePsp,
        (psp) => psp.constant(types.number, EXC_RETURN_THREAD_PSP),
        (msp) => msp.constant(types.number, EXC_RETURN_THREAD_MSP),
      ),
    (handler) => handler.constant(types.number, EXC_RETURN_HANDLER_MSP),
  );

  writeLr(b, excReturn);

  // 取走异常时清除对应的软件挂起/隐藏 pending；PR/外设电平条件由驱动者自行保持。
  b.if(b.equal(types.number, exc, num(b, EXCEPTION_NMI)), (nmi) => {
    writeHidden(asBody(nmi), H_NMI, num(asBody(nmi), 0));
  });
  b.if(b.equal(types.number, exc, num(b, EXCEPTION_HARDFAULT)), (fault) => {
    writeHidden(asBody(fault), H_HARDFAULT, num(asBody(fault), 0));
  });
  b.if(b.equal(types.number, exc, num(b, EXCEPTION_USAGEFAULT)), (usage) => {
    writeHidden(asBody(usage), H_USAGEFAULT, num(asBody(usage), 0));
  });
  b.if(b.equal(types.number, exc, num(b, EXCEPTION_PENDSV)), (pendsv) => {
    writeHidden(asBody(pendsv), H_PENDSV, num(asBody(pendsv), 0));
  });
  b.if(b.equal(types.number, exc, num(b, SYSTICK_EXCEPTION)), (tick) => {
    acknowledgeSystick(asBody(tick));
  });
  clearPendingDynamic(b, exc);
  for (const config of USARTS)
    b.if(b.equal(types.number, exc, num(b, exceptionOf(config.irq))), (hit) => {
      acknowledgeIrqSources(asBody(hit), config.irq);
    });
  for (const source of machine().interruptSources) {
    const irq = source.exception - 16;

    if (irq < 0) continue;
    b.if(b.equal(types.number, exc, num(b, source.exception)), (hit) => {
      acknowledgeIrqSources(asBody(hit), irq);
    });
  }

  b.writeState('pc', vectorHandler(b, exc));
}

export function isExceptionReturn(b: Body, target: Value<number>): Value<boolean> {
  const value = u32(b, target);
  const high = b.greaterThanOrEqual(value, num(b, 0xffffffe0));
  const low = b.bitAnd(value, num(b, 0x1f));
  // Valid EXC_RETURN low 5-bit patterns: 0x01, 0x09, 0x0d, 0x11, 0x19, 0x1d -> mask 0x22022202.
  const valid = b.notEqual(
    types.number,
    b.bitAnd(b.shiftRightUnsigned(num(b, 0x22022202), low), num(b, 1)),
    num(b, 0),
  );

  return boolAnd(b, high, valid);
}

/** 异常返回：弹出 8 字基本帧并恢复 MSP/PSP/模式。 */
export function exceptionReturn(b: Body, target?: Value<number>): void {
  const excReturn = target ?? readLr(b);

  const thread = boolBit(b, excReturn, 8);
  const psp = boolBit(b, excReturn, 4);
  const usePsp = boolAnd(b, thread, psp);
  const frame = b.select(
    types.number,
    usePsp,
    (inner) => readHidden(asBody(inner), H_PSP),
    (inner) => readSp(asBody(inner)),
  );
  const r0 = stackLoad(b, frame);
  const r1 = stackLoad(b, b.add(frame, num(b, 4)));
  const r2 = stackLoad(b, b.add(frame, num(b, 8)));
  const r3 = stackLoad(b, b.add(frame, num(b, 12)));
  const r12 = stackLoad(b, b.add(frame, num(b, 16)));
  const lr = stackLoad(b, b.add(frame, num(b, 20)));
  const pc = stackLoad(b, b.add(frame, num(b, 24)));
  const xpsr = stackLoad(b, b.add(frame, num(b, 28)));
  const padding = b.shiftRightUnsigned(b.bitAnd(xpsr, num(b, 0x200)), num(b, 7));
  const next = b.add(b.add(frame, num(b, 32)), padding);

  writeReg(b, 0, r0);
  writeReg(b, 1, r1);
  writeReg(b, 2, r2);
  writeReg(b, 3, r3);
  writeReg(b, 12, r12);
  writeLr(b, lr);
  b.writeState('apsr', b.bitOr(b.bitAnd(xpsr, num(b, 0xf8000000)), num(b, APSR_T)));
  popActive(b);

  b.if(
    usePsp,
    (threadPsp) => {
      const body = asBody(threadPsp);

      writeHidden(body, H_PSP, next);
      writeSp(body, next);
      writeHidden(body, H_MODE, num(body, 0));
    },
    (other) => {
      const body = asBody(other);

      writeSp(body, next);
      writeHidden(
        body,
        H_MODE,
        body.select(
          types.number,
          thread,
          (inner) => inner.constant(types.number, 0),
          (inner) => inner.constant(types.number, 1),
        ),
      );
    },
  );
  // 异常返回置 CPU 私有 event，供紧接着的一次 WFE 立即通过（消费在 WFE 执行处）。
  writeWordAt(b, SYS, CPU_HIDDEN_EVENT, num(b, 1));
  b.writeState('pc', b.bitAnd(u32(b, pc), num(b, 0xfffffffe)));
}

/* ---------------- 系统异常入口 ---------------- */

export const nmiPending = (b: Body): Value<boolean> =>
  b.notEqual(types.number, readHidden(b, H_NMI), num(b, 0));

export function setNmiPending(b: Body): void {
  writeHidden(b, H_NMI, num(b, 1));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function clearNmiPending(b: Body): void {
  writeHidden(b, H_NMI, num(b, 0));
}

export const hardFaultPending = (b: Body): Value<boolean> =>
  b.notEqual(types.number, readHidden(b, H_HARDFAULT), num(b, 0));

/** 请求 HardFault；`reason='svc'`/`'fault'` 置 FORCED，`'vector'` 置 VECTTBL。 */
export function requestHardFault(b: Body, reason: 'svc' | 'fault' | 'vector' = 'fault'): void {
  writeHidden(b, H_HARDFAULT, num(b, 1));
  const bit = reason === 'vector' ? 1 << 1 : 1 << 30;

  store(b, HFSR, b.bitOr(load(b, HFSR), num(b, bit)));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

/**
 * UsageFault 请求（如 NOCP）。在 SHCSR.USGFAULTENA=1 时进入异常 6；
 * 否则按 ARM 规则升级为 HardFault（HFSR.FORCED）。
 */
export function requestUsageFault(b: Body, nocp = true): void {
  if (nocp) store(b, CFSR, b.bitOr(load(b, CFSR), num(b, 1 << 19)));
  b.if(
    b.notEqual(types.number, b.bitAnd(load(b, SHCSR), num(b, 1 << 16)), num(b, 0)),
    (enabled) => {
      const body = asBody(enabled);

      writeHidden(body, H_USAGEFAULT, num(body, 1));
      body.writeState(IRQ_DIRTY, bool(body, true));
      markService(body, SERVICE_IRQ);
    },
    (disabled) => requestHardFault(asBody(disabled), 'fault'),
  );
}

export const usageFaultPending = (b: Body): Value<boolean> =>
  b.notEqual(types.number, readHidden(b, H_USAGEFAULT), num(b, 0));

export const pendSvPending = (b: Body): Value<boolean> =>
  b.notEqual(types.number, readHidden(b, H_PENDSV), num(b, 0));

export function setPendSvPending(b: Body): void {
  writeHidden(b, H_PENDSV, num(b, 1));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function clearPendSvPending(b: Body): void {
  writeHidden(b, H_PENDSV, num(b, 0));
}

/** SVC 同步入口。优先级掩蔽或同级/更低优先级时升级为 HardFault（ARM 行为）。 */
export function enterSvc(b: Body, returnPc: number | Value<number>): Value<boolean> {
  const priority = priorityByteOfSystem(b, EXCEPTION_SVCALL);
  const group = groupOf(b, priority);
  const allowed = boolAnd(
    b,
    b.equal(types.number, readHidden(b, H_FAULTMASK), num(b, 0)),
    boolAnd(b, allowedByBasepri(b, group), b.lessThan(group, currentGroup(b))),
  );
  const taken = b.local(types.bool, false);

  b.if(
    allowed,
    (call) => {
      const body = asBody(call);

      enterException(body, num(body, EXCEPTION_SVCALL), returnPc, group);
      body.setLocal(taken, bool(body, true));
    },
    (fault) => requestHardFault(asBody(fault), 'svc'),
  );

  return b.getLocal(taken);
}

function allowedByBasepri(b: Body, group: Value<number>): Value<boolean> {
  const base = readHidden(b, H_BASEPRI);

  return b.select(
    types.bool,
    b.equal(types.number, base, num(b, 0)),
    (disabled) => disabled.constant(types.bool, true),
    (enabled) => {
      const body = asBody(enabled);

      return body.lessThan(group, body.shiftRightUnsigned(base, groupShift(body)));
    },
  );
}

/** 显式进入 NMI（CPU 代理也可只 `setNmiPending` 等边界派发）。 */
export function enterNmi(b: Body, returnPc: number | Value<number>): void {
  enterException(b, num(b, EXCEPTION_NMI), returnPc, num(b, -2));
}

/** 显式进入 HardFault。 */
export function enterHardFault(b: Body, returnPc: number | Value<number>): void {
  enterException(b, num(b, EXCEPTION_HARDFAULT), returnPc, num(b, -1));
}

/** 显式进入 PendSV。 */
export function enterPendSv(b: Body, returnPc: number | Value<number>): void {
  enterException(
    b,
    num(b, EXCEPTION_PENDSV),
    returnPc,
    groupOf(b, priorityByteOfSystem(b, EXCEPTION_PENDSV)),
  );
}

/* ---------------- 派发 ---------------- */

interface Selection {
  readonly best: Local<number>;
  readonly bestGroup: Local<number>;
  readonly bestPriority: Local<number>;
  readonly pending: Local<number>;
  readonly pendingGroup: Local<number>;
  readonly pendingPriority: Local<number>;
  readonly external: Local<boolean>;
}

function better(
  b: Body,
  exception: Value<number>,
  priority: Value<number>,
  group: Value<number>,
  best: Local<number>,
  bestGroup: Local<number>,
  bestPriority: Local<number>,
): Value<boolean> {
  const groupBetter = b.lessThan(group, b.getLocal(bestGroup));
  const sameGroup = b.equal(types.number, group, b.getLocal(bestGroup));
  const priorityBetter = b.lessThan(priority, b.getLocal(bestPriority));
  const samePriority = b.equal(types.number, priority, b.getLocal(bestPriority));
  const indexBetter = b.lessThan(exception, b.getLocal(best));

  return boolOr(
    b,
    groupBetter,
    boolAnd(b, sameGroup, boolOr(b, priorityBetter, boolAnd(b, samePriority, indexBetter))),
  );
}

function updateBest(
  b: Body,
  exception: Value<number>,
  priority: Value<number>,
  group: Value<number>,
  best: Local<number>,
  bestGroup: Local<number>,
  bestPriority: Local<number>,
): void {
  b.if(better(b, exception, priority, group, best, bestGroup, bestPriority), (hit) => {
    const body = asBody(hit);

    body.setLocal(best, exception);
    body.setLocal(bestGroup, group);
    body.setLocal(bestPriority, priority);
  });
}

function considerValue(
  b: Body,
  exception: Value<number>,
  pending: Value<boolean>,
  enabled: Value<boolean>,
  active: Value<boolean>,
  priority: Value<number>,
  group: Value<number>,
  allowed: Value<boolean>,
  external: boolean,
  selection: Selection,
): void {
  const eligible = boolAnd(b, pending, boolAnd(b, enabled, b.not(active)));

  b.if(eligible, (hit) => {
    const body = asBody(hit);

    updateBest(
      body,
      exception,
      priority,
      group,
      selection.pending,
      selection.pendingGroup,
      selection.pendingPriority,
    );
    if (external) body.setLocal(selection.external, bool(body, true));
  });

  b.if(boolAnd(b, eligible, allowed), (runnable) => {
    const body = asBody(runnable);

    updateBest(
      body,
      exception,
      priority,
      group,
      selection.best,
      selection.bestGroup,
      selection.bestPriority,
    );
  });
}

function consider(
  b: Body,
  exception: number,
  pending: Value<boolean>,
  enabled: Value<boolean>,
  active: Value<boolean>,
  priority: Value<number>,
  group: Value<number>,
  allowed: Value<boolean>,
  external: boolean,
  selection: Selection,
): void {
  considerValue(
    b,
    num(b, exception),
    pending,
    enabled,
    active,
    priority,
    group,
    allowed,
    external,
    selection,
  );
}

/**
 * 指令边界派发。返回 true 表示已经进入异常；调用方跳过当前指令。
 *
 * 顺序：软件复位 → NMI → HardFault → 可配置异常（PendSV/SysTick/外部 IRQ）。
 * 可配置异常的抢占只看 group priority（PRIGROUP 以上），同级/更低只挂起不抢占；
 * 同级时按 subpriority、再按异常号选择。PRIMASK/BASEPRI 只屏蔽可配置异常，
 * FAULTMASK 同时屏蔽 HardFault，NMI 与复位不可屏蔽。
 */
export function dispatchExceptions(b: Body, returnPc: number | Value<number>): Value<boolean> {
  const taken = b.local(types.bool, false);

  b.if(
    resetPending(b),
    (reset) => {
      applyPendingReset(asBody(reset));
      reset.setLocal(taken, bool(reset, true));
    },
    (normal) => {
      const scope = asBody(normal);
      const active = currentException(scope);
      const activeGroup = currentGroup(scope);
      const faultmask = readHidden(scope, H_FAULTMASK);
      const primask = readPrimask(scope);
      const selection: Selection = {
        best: scope.local(types.number, 0),
        bestGroup: scope.local(types.number, 256),
        bestPriority: scope.local(types.number, 256),
        pending: scope.local(types.number, 0),
        pendingGroup: scope.local(types.number, 256),
        pendingPriority: scope.local(types.number, 256),
        external: scope.local(types.bool, false),
      };

      scope.writeState(IRQ_DIRTY, bool(scope, false));
      // EXTI 边沿必须在指令块边界采样；配置了触发线时保持 IRQ 服务循环，
      // 让下一批继续采样（不依赖时间槽，避免与中央外设推进调度互相抢占）。
      sampleExti(scope);

      // NMI：不可屏蔽，且只在 NMI 自身不 active 时进入。
      scope.if(
        boolAnd(
          scope,
          nmiPending(scope),
          scope.notEqual(types.number, active, num(scope, EXCEPTION_NMI)),
        ),
        (nmi) => {
          const body = asBody(nmi);

          enterException(body, num(body, EXCEPTION_NMI), returnPc, num(body, -2));
          body.setLocal(taken, bool(body, true));
          body.writeState(IRQ_DIRTY, bool(body, true));
          markService(body, SERVICE_IRQ);
        },
        (afterNmi) => {
          const body = asBody(afterNmi);

          body.if(
            boolAnd(
              body,
              hardFaultPending(body),
              boolAnd(
                body,
                body.equal(types.number, faultmask, num(body, 0)),
                boolAnd(
                  body,
                  body.notEqual(types.number, active, num(body, EXCEPTION_HARDFAULT)),
                  body.lessThan(num(body, -1), activeGroup),
                ),
              ),
            ),
            (fault) => {
              const inner = asBody(fault);

              enterException(inner, num(inner, EXCEPTION_HARDFAULT), returnPc, num(inner, -1));
              inner.setLocal(taken, bool(inner, true));
              inner.writeState(IRQ_DIRTY, bool(inner, true));
              markService(inner, SERVICE_IRQ);
            },
            (configurable) => {
              const inner = asBody(configurable);
              const groupShiftValue = groupShift(inner);
              const base = readHidden(inner, H_BASEPRI);
              const baseGroup = inner.select(
                types.number,
                inner.equal(types.number, base, num(inner, 0)),
                (disabled) => disabled.constant(types.number, 256),
                (enabled) => enabled.shiftRightUnsigned(base, groupShiftValue),
              );
              const masked = boolOr(
                inner,
                inner.notEqual(types.number, primask, num(inner, 0)),
                inner.notEqual(types.number, faultmask, num(inner, 0)),
              );
              const configurableAllowed = (b: Body, group: Value<number>): Value<boolean> =>
                boolAnd(
                  b,
                  b.not(masked),
                  boolAnd(b, b.lessThan(group, baseGroup), b.lessThan(group, activeGroup)),
                );

              const usagePriority = priorityByteOfSystem(inner, EXCEPTION_USAGEFAULT);
              const usageGroup = inner.shiftRightUnsigned(usagePriority, groupShiftValue);
              const usageEnabled = inner.notEqual(
                types.number,
                inner.bitAnd(load(inner, SHCSR), num(inner, 1 << 16)),
                num(inner, 0),
              );

              consider(
                inner,
                6,
                usageFaultPending(inner),
                usageEnabled,
                inner.equal(types.number, active, num(inner, EXCEPTION_USAGEFAULT)),
                usagePriority,
                usageGroup,
                configurableAllowed(inner, usageGroup),
                false,
                selection,
              );

              const pendsvPriority = priorityByteOfSystem(inner, EXCEPTION_PENDSV);
              const pendsvGroup = inner.shiftRightUnsigned(pendsvPriority, groupShiftValue);

              consider(
                inner,
                EXCEPTION_PENDSV,
                pendSvPending(inner),
                bool(inner, true),
                inner.equal(types.number, active, num(inner, EXCEPTION_PENDSV)),
                pendsvPriority,
                pendsvGroup,
                configurableAllowed(inner, pendsvGroup),
                false,
                selection,
              );

              const tickPriority = priorityByteOfSystem(inner, EXCEPTION_SYSTICK);
              const tickGroup = inner.shiftRightUnsigned(tickPriority, groupShiftValue);
              const tickEnabled = inner.notEqual(
                types.number,
                inner.bitAnd(inner.readState(SYSTICK_CTRL, types.number), num(inner, 2)),
                num(inner, 0),
              );

              consider(
                inner,
                EXCEPTION_SYSTICK,
                systickPending(inner),
                tickEnabled,
                inner.equal(types.number, active, num(inner, EXCEPTION_SYSTICK)),
                tickPriority,
                tickGroup,
                configurableAllowed(inner, tickGroup),
                false,
                selection,
              );

              const sourceWords = [0, 1, 2, 3].map(() => inner.local(types.number, 0));
              const sources = machine().interruptSources;
              const eligibleWord = (bank: number) =>
                inner.bitAnd(
                  bankWord(inner, ENABLED, bank),
                  inner.bitNot(bankWord(inner, ACTIVE, bank)),
                );
              // 只有所有回调都只读时，才能在执行它们之前读取 NVIC bank。
              const eligibleWords = sources.every((source) => source.pendingIsPure)
                ? sourceWords.map((_, bank) => eligibleWord(bank))
                : undefined;

              const addSource = (
                body: Body,
                irq: number,
                pending: (scope: Body) => Value<boolean>,
              ): void => {
                if (irq < 0 || irq > G431_IRQ_MAX) {
                  if (eligibleWords === undefined) pending(body);
                  return;
                }
                const bank = bankOf(irq);
                const bit = 1 << bitOf(irq);
                const poll = (scope: Body) => {
                  scope.if(pending(scope), (hit) => {
                    const target = asBody(hit);

                    target.setLocal(
                      sourceWords[bank]!,
                      target.bitOr(target.getLocal(sourceWords[bank]!), num(target, bit)),
                    );
                  });
                };
                if (eligibleWords === undefined) {
                  poll(body);
                } else {
                  // 只提前排除未启用或已 active 的线路。不能抢占的线路仍参与 ICSR 仲裁。
                  body.if(boolBit(body, eligibleWords[bank]!, bit), (hit) => poll(asBody(hit)));
                }
              };

              for (const source of sources)
                addSource(inner, source.exception - 16, (scope) => source.pending(scope));
              // 内建 USART 的电平读取也无副作用。
              for (const config of USARTS)
                addSource(inner, config.irq, (scope) => usartPending(scope, config));

              // 先逐 bank 排除不可能入选的 IRQ；组优先级和屏蔽仍在候选比较中处理，
              // 因为即使不能抢占，候选也参与 ICSR.VECTPENDING 的选择。
              sourceWords.forEach((source, bank) => {
                const eligible = inner.bitAnd(
                  inner.bitOr(bankWord(inner, PENDING, bank), inner.getLocal(source)),
                  eligibleWords?.[bank] ?? eligibleWord(bank),
                );
                const candidates = inner.local(
                  types.number,
                  inner.bitAnd(eligible, num(inner, BANK_MASKS[bank]!)),
                );

                inner.while(
                  (test) =>
                    test.notEqual(
                      types.number,
                      test.getLocal(candidates),
                      test.constant(types.number, 0),
                    ),
                  (loopBody) => {
                    const body = asBody(loopBody);
                    const bits = body.getLocal(candidates);
                    const current = body.add(num(body, 32 * bank), firstIrqBit(body, bits));
                    const exception = body.add(current, num(body, 16));
                    const priority = priorityByteOfIrqDynamic(body, current);
                    const group = body.shiftRightUnsigned(priority, groupShiftValue);

                    considerValue(
                      body,
                      exception,
                      bool(body, true),
                      bool(body, true),
                      body.equal(types.number, active, exception),
                      priority,
                      group,
                      configurableAllowed(body, group),
                      true,
                      selection,
                    );
                    body.setLocal(candidates, body.bitAnd(bits, body.subtract(bits, num(body, 1))));
                  },
                );
              });

              writeHidden(inner, H_VECTPENDING, inner.getLocal(selection.pending));
              writeHidden(
                inner,
                H_ISRPENDING,
                inner.select(
                  types.number,
                  inner.getLocal(selection.external),
                  (on) => on.constant(types.number, 1),
                  (off) => off.constant(types.number, 0),
                ),
              );

              inner.if(
                inner.notEqual(types.number, inner.getLocal(selection.best), num(inner, 0)),
                (hit) => {
                  const body = asBody(hit);

                  enterException(
                    body,
                    body.getLocal(selection.best),
                    returnPc,
                    body.getLocal(selection.bestGroup),
                  );
                  body.setLocal(taken, bool(body, true));
                  body.writeState(IRQ_DIRTY, bool(body, true));
                  markService(body, SERVICE_IRQ);
                },
                (idle) => {
                  const body = asBody(idle);

                  body.if(
                    body.notEqual(types.number, body.getLocal(selection.pending), num(body, 0)),
                    (blocked) => {
                      const scope2 = asBody(blocked);

                      scope2.writeState(IRQ_DIRTY, bool(scope2, true));
                      markService(scope2, SERVICE_IRQ);
                    },
                  );
                },
              );
            },
          );
        },
      );
      scope.if(extiOn(scope), (exti) => {
        const body = asBody(exti);

        body.writeState(IRQ_DIRTY, bool(body, true));
        markService(body, SERVICE_IRQ);
      });
    },
  );

  return b.getLocal(taken);
}

/* ---------------- SCB ---------------- */

export function readScb(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0xffc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, 0x00)),
    (id) => id.setLocal(result, id.constant(types.number, 0x410fc241)),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, 0x04)),
        (icsr) => {
          const scope = asBody(icsr);
          const depth = readHidden(scope, H_DEPTH);
          const pending = scope.shiftLeft(readHidden(scope, H_VECTPENDING), num(scope, 12));
          const pendsv = scope.shiftLeft(readHidden(scope, H_PENDSV), num(scope, 28));
          const nmipendset = scope.shiftLeft(readHidden(scope, H_NMI), num(scope, 31));
          const isr = scope.shiftLeft(readHidden(scope, H_ISRPENDING), num(scope, 22));
          const tickSet = scope.shiftLeft(
            scope.bitAnd(scope.readState(SYSTICK_PENDING, types.number), num(scope, 1)),
            num(scope, 26),
          );
          const rettobase = scope.select(
            types.number,
            scope.lessThanOrEqual(depth, num(scope, 1)),
            (inner) => inner.constant(types.number, 1 << 11),
            (inner) => inner.constant(types.number, 0),
          );

          icsr.setLocal(
            result,
            scope.bitOr(
              scope.bitOr(currentException(scope), scope.bitOr(pending, isr)),
              scope.bitOr(rettobase, scope.bitOr(pendsv, scope.bitOr(tickSet, nmipendset))),
            ),
          );
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, 0x08)),
            (vtor) => vtor.setLocal(result, load(asBody(vtor), VTOR)),
            (after) => {
              const scope2 = asBody(after);

              scope2.if(
                scope2.equal(types.number, wordOffset, num(scope2, 0x0c)),
                (aircr) =>
                  aircr.setLocal(
                    result,
                    aircr.bitOr(
                      load(asBody(aircr), AIRCR),
                      aircr.constant(types.number, 0xfa050000),
                    ),
                  ),
                (rest) => {
                  const body2 = asBody(rest);

                  body2.if(
                    body2.equal(types.number, wordOffset, num(body2, 0x14)),
                    (ccr) =>
                      ccr.setLocal(
                        result,
                        ccr.bitOr(load(asBody(ccr), CCR), ccr.constant(types.number, 0x200)),
                      ),
                    (tail) => {
                      const body3 = asBody(tail);

                      body3.if(
                        boolOr(
                          body3,
                          inRegion(body3, wordOffset, 0x10, 0x40),
                          body3.equal(types.number, wordOffset, num(body3, 0x88)),
                        ),
                        (stored) => {
                          const inner = asBody(stored);

                          inner.setLocal(
                            result,
                            readWord(inner, SYS, inner.add(num(inner, SCB_STATE), wordOffset)),
                          );
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
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeScb(b: Body, offset: Value<number>, size: number, value: Value<number>): void {
  const wordOffset = b.bitAnd(offset, num(b, 0xffc));
  const raw = u32(b, value);

  b.if(b.equal(types.number, wordOffset, num(b, 0x04)), (icsr) => {
    const body = asBody(icsr);

    body.if(
      bitValue(body, raw, 31),
      (set) => writeHidden(asBody(set), H_NMI, num(asBody(set), 1)),
      (clear) => writeHidden(asBody(clear), H_NMI, num(asBody(clear), 0)),
    );
    body.if(bitValue(body, raw, 28), (hit) =>
      writeHidden(asBody(hit), H_PENDSV, num(asBody(hit), 1)),
    );
    body.if(bitValue(body, raw, 27), (hit) =>
      writeHidden(asBody(hit), H_PENDSV, num(asBody(hit), 0)),
    );
    body.if(bitValue(body, raw, 26), (hit) =>
      asBody(hit).writeState(SYSTICK_PENDING, num(asBody(hit), 1)),
    );
    body.if(bitValue(body, raw, 25), (hit) =>
      asBody(hit).writeState(SYSTICK_PENDING, num(asBody(hit), 0)),
    );
    body.writeState(IRQ_DIRTY, bool(body, true));
    markService(body, SERVICE_IRQ);
  });

  b.if(b.equal(types.number, wordOffset, num(b, 0x08)), (vtor) => {
    const body = asBody(vtor);

    store(
      body,
      VTOR,
      body.bitAnd(merge(body, load(body, VTOR), value, offset, size), num(body, 0xffffff80)),
    );
  });

  b.if(b.equal(types.number, wordOffset, num(b, 0x0c)), (aircr) => {
    const body = asBody(aircr);

    body.if(
      body.equal(types.number, body.shiftRightUnsigned(raw, num(body, 16)), num(body, 0x05fa)),
      (valid) => {
        const scope = asBody(valid);

        store(
          scope,
          AIRCR,
          scope.bitOr(
            scope.bitAnd(load(scope, AIRCR), num(scope, ~0x700)),
            scope.bitAnd(raw, num(scope, 0x700)),
          ),
        );
        scope.if(bitValue(scope, raw, 2), (reset) => {
          const inner = asBody(reset);

          // PRIMASK 不屏蔽复位；放开现有服务门控，下一次边界执行统一的 applyReset。
          inner.writeState('primask', num(inner, 0));
          requestReset(inner, RESET_CAUSE_SYSRESETREQ);
        });
        scope.if(bitValue(scope, raw, 0), (reset) => {
          const inner = asBody(reset);

          inner.writeState('primask', num(inner, 0));
          requestReset(inner, RESET_CAUSE_VECTRESET);
        });
      },
    );
  });

  b.if(b.equal(types.number, wordOffset, num(b, 0x10)), (scr) => {
    const body = asBody(scr);

    store(
      body,
      SCR,
      body.bitAnd(merge(body, load(body, SCR), value, offset, size), num(body, 0x1f)),
    );
  });

  b.if(b.equal(types.number, wordOffset, num(b, 0x14)), (ccr) => {
    const body = asBody(ccr);

    store(
      body,
      CCR,
      body.bitAnd(merge(body, load(body, CCR), value, offset, size), num(body, ~0x200)),
    );
  });

  for (const [register, offsetOf] of [
    [SHPR1, 0x18],
    [SHPR2, 0x1c],
    [SHPR3, 0x20],
  ] as const)
    b.if(b.equal(types.number, wordOffset, num(b, offsetOf)), (hit) => {
      const body = asBody(hit);

      store(
        body,
        register,
        body.bitAnd(merge(body, load(body, register), value, offset, size), num(body, 0xf0f0f0f0)),
      );
      body.writeState(IRQ_DIRTY, bool(body, true));
      markService(body, SERVICE_IRQ);
    });

  b.if(b.equal(types.number, wordOffset, num(b, 0x24)), (shcsr) => {
    const body = asBody(shcsr);

    store(body, SHCSR, raw);
  });

  for (const [register, offsetOf] of [
    [CFSR, 0x28],
    [HFSR, 0x2c],
    [DFSR, 0x30],
    [AFSR, 0x3c],
  ] as const)
    b.if(b.equal(types.number, wordOffset, num(b, offsetOf)), (hit) => {
      const body = asBody(hit);

      store(body, register, body.bitAnd(load(body, register), body.bitNot(raw)));
    });

  for (const [register, offsetOf] of [
    [MMFAR, 0x34],
    [BFAR, 0x38],
  ] as const)
    b.if(b.equal(types.number, wordOffset, num(b, offsetOf)), (hit) => {
      const body = asBody(hit);

      store(body, register, raw);
    });

  b.if(b.equal(types.number, wordOffset, num(b, 0x88)), (cpacr) => {
    const body = asBody(cpacr);

    store(body, SCB_STATE + 0x88, raw);
  });
}

function bitValue(b: Body, value: Value<number>, index: number): Value<boolean> {
  return b.notEqual(types.number, b.bitAnd(value, num(b, 1 << index)), num(b, 0));
}

/* ---------------- 系统区入口 ---------------- */

export function readSystem(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    inRegion(b, address, SYSTICK_BASE, SYSTICK_BASE + 0x20),
    (systick) => {
      const body = asBody(systick);

      body.setLocal(
        result,
        readSystick(body, body.subtract(address, num(body, SYSTICK_BASE)), size),
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, NVIC_BASE, NVIC_BASE + 0x400),
        (nvic) => {
          const scope = asBody(nvic);

          nvic.setLocal(
            result,
            readNvic(scope, scope.subtract(address, num(scope, NVIC_BASE)), size),
          );
        },
        (next) => {
          const scope = asBody(next);

          // STIR is write-only and lies outside the SCB window. The default zero
          // also covers its four byte lanes; no second NVIC read tree is needed.
          scope.if(inRegion(scope, address, SCB_BASE, SCB_BASE + 0x100), (scb) => {
            const body2 = asBody(scb);

            scb.setLocal(
              result,
              readScb(body2, body2.subtract(address, num(body2, SCB_BASE)), size),
            );
          });
        },
      );
    },
  );

  return b.getLocal(result);
}

export function writeSystem(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.if(
    inRegion(b, address, SYSTICK_BASE, SYSTICK_BASE + 0x20),
    (systick) => {
      const body = asBody(systick);

      writeSystick(body, body.subtract(address, num(body, SYSTICK_BASE)), size, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          inRegion(body, address, NVIC_BASE, NVIC_BASE + 0x400),
          inRegion(body, address, NVIC_BASE + 0xe00, NVIC_BASE + 0xe04),
        ),
        (nvic) => {
          const scope = asBody(nvic);

          writeNvic(scope, scope.subtract(address, num(scope, NVIC_BASE)), size, value);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(inRegion(scope, address, SCB_BASE, SCB_BASE + 0x100), (scb) => {
            const body2 = asBody(scb);

            writeScb(body2, body2.subtract(address, num(body2, SCB_BASE)), size, value);
          });
        },
      );
    },
  );
}
