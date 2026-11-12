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
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
  SYS,
  SYSTICK_BASE,
} from './layout';
import {
  asBody,
  bool,
  boolAnd,
  boolOr,
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
import {
  SYSTICK_EXCEPTION,
  acknowledgeSystick,
  readSystick,
  systickPending,
  writeSystick,
} from './systick';
import { USARTS, usartPending } from './usart';

/**
 * NVIC、SCB 与异常入口/返回。
 *
 * 只实现 32 个外部中断位中的 USART1/2/3 与 SysTick：ISER/ICER/ISPR/ICPR 与 VTOR
 * 可读写，优先级寄存器保存但不参与仲裁（固定按异常号从小到大响应）。异常入口压
 * 8 字栈帧并写 EXC_RETURN；`BX LR` 的低 8 位为 0xF9 时执行异常返回。
 *
 * 指令边界只在 `irqDirty` 为真时扫描异常；置位点是「SysTick 到期」「USART 字节结束」
 * 与中断相关的寄存器写入，未置位时每块只多读一个 bool。
 */

const ISER = NVIC_STATE + 0x00;
const ISPR = NVIC_STATE + 0x08;
const IPR = NVIC_STATE + 0x10;

const VTOR = SCB_STATE + 0x08;
const CCR = SCB_STATE + 0x14;

const EXC_RETURN_MASK = 0xffffff00;
const EXC_RETURN_THREAD_MSP = 0xfffffff9;

const IPR_END = 0x320;

const load = (b: Body, offset: number): Value<number> => readWordAt(b, SYS, offset);
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYS, offset, value);
};

const inRegion = (b: Body, value: Value<number>, low: number, high: number): Value<boolean> =>
  boolAnd(b, b.greaterThanOrEqual(value, num(b, low)), b.lessThan(value, num(b, high)));

export function readNvic(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3ff));
  const result = b.local(types.number, 0);

  b.if(
    boolOr(
      b,
      b.equal(types.number, wordOffset, num(b, 0x00)),
      b.equal(types.number, wordOffset, num(b, 0x80)),
    ),
    (enabled) => enabled.setLocal(result, load(asBody(enabled), ISER)),
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          body.equal(types.number, wordOffset, num(body, 0x100)),
          body.equal(types.number, wordOffset, num(body, 0x180)),
        ),
        (pending) => pending.setLocal(result, load(asBody(pending), ISPR)),
        (next) => {
          const scope = asBody(next);

          scope.if(
            boolAnd(
              scope,
              scope.greaterThanOrEqual(wordOffset, num(scope, 0x300)),
              scope.lessThan(wordOffset, num(scope, IPR_END)),
            ),
            (prio) => {
              const body2 = asBody(prio);
              const index = body2.bitAnd(
                body2.subtract(wordOffset, num(body2, 0x300)),
                num(body2, 0x1f),
              );

              prio.setLocal(result, readWord(body2, SYS, body2.add(num(body2, IPR), index)));
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
  const wordOffset = b.bitAnd(offset, num(b, 0x3ff));

  b.if(
    b.equal(types.number, wordOffset, num(b, 0x00)),
    (enable) => {
      const body = asBody(enable);

      store(body, ISER, body.bitOr(load(body, ISER), u32(body, value)));
      body.writeState(IRQ_DIRTY, bool(body, true));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, 0x80)),
        (disable) => {
          const scope = asBody(disable);

          store(scope, ISER, scope.bitAnd(load(scope, ISER), scope.bitNot(u32(scope, value))));
          scope.writeState(IRQ_DIRTY, bool(scope, true));
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, 0x100)),
            (setPending) => {
              const body2 = asBody(setPending);

              store(body2, ISPR, body2.bitOr(load(body2, ISPR), u32(body2, value)));
              body2.writeState(IRQ_DIRTY, bool(body2, true));
            },
            (after) => {
              const scope2 = asBody(after);

              scope2.if(
                scope2.equal(types.number, wordOffset, num(scope2, 0x180)),
                (clearPending) => {
                  const body2 = asBody(clearPending);

                  store(
                    body2,
                    ISPR,
                    body2.bitAnd(load(body2, ISPR), body2.bitNot(u32(body2, value))),
                  );
                },
                (rest) => {
                  const body2 = asBody(rest);

                  body2.if(
                    boolAnd(
                      body2,
                      body2.greaterThanOrEqual(wordOffset, num(body2, 0x300)),
                      body2.lessThan(wordOffset, num(body2, IPR_END)),
                    ),
                    (prio) => {
                      const body3 = asBody(prio);
                      const index = body3.bitAnd(
                        body3.subtract(wordOffset, num(body3, 0x300)),
                        num(body3, 0x1f),
                      );
                      const at = body3.add(num(body3, IPR), index);
                      const current = readWord(body3, SYS, at);

                      writeWord(body3, SYS, at, merge(body3, current, value, offset, size));
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

export function readScb(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, 0x00)),
    (id) => id.setLocal(result, id.constant(types.number, 0x410fc241)),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, 0x04)),
        (icsr) => icsr.setLocal(result, icsr.constant(types.number, 0)),
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
                      load(asBody(aircr), SCB_STATE + 0x0c),
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

                      body3.if(body3.greaterThan(wordOffset, num(body3, 0x14)), (wide) =>
                        wide.if(wide.lessThanOrEqual(wordOffset, num(wide, 0x3c)), (hit) => {
                          const body4 = asBody(hit);

                          hit.setLocal(
                            result,
                            readWord(body4, SYS, body4.add(num(body4, SCB_STATE), wordOffset)),
                          );
                        }),
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
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  b.if(
    b.equal(types.number, wordOffset, num(b, 0x08)),
    (vtor) => {
      const body = asBody(vtor);

      store(body, VTOR, body.bitAnd(u32(body, value), num(body, 0xffffff80)));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, 0x0c)),
        (aircr) => {
          const scope = asBody(aircr);
          const current = load(scope, SCB_STATE + 0x0c);
          const mask = num(scope, 0x0000ffff);

          store(
            scope,
            SCB_STATE + 0x0c,
            scope.bitOr(
              scope.bitAnd(current, scope.bitNot(mask)),
              scope.bitAnd(u32(scope, value), mask),
            ),
          );
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            boolAnd(
              scope,
              scope.greaterThan(wordOffset, num(scope, 0x0c)),
              scope.lessThanOrEqual(wordOffset, num(scope, 0x3c)),
            ),
            (wide) => {
              const body2 = asBody(wide);
              const at = body2.add(num(body2, SCB_STATE), wordOffset);
              const current = readWord(body2, SYS, at);

              writeWord(body2, SYS, at, merge(body2, current, value, offset, size));
            },
          );
        },
      );
    },
  );
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

  return b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed);
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

function nvicEnabled(b: Body, irq: number): Value<boolean> {
  return b.notEqual(types.number, b.bitAnd(load(b, ISER), num(b, 1 << (irq & 31))), num(b, 0));
}

function clearNvicPending(b: Body, irq: number): void {
  store(b, ISPR, b.bitAnd(load(b, ISPR), num(b, 0xffffffff & ~(1 << (irq & 31)))));
}

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

/** 压 8 字异常帧并转向向量；返回地址是当前指令的地址。`exception` 是异常号（15=SysTick）。 */
export function enterException(
  b: Body,
  exception: Value<number>,
  returnPc: number | Value<number>,
): void {
  const sp = b.bitAnd(readSp(b), num(b, 0xfffffff8));
  const frame = b.subtract(sp, num(b, 32));
  const xpsr = b.bitOr(readApsr(b), num(b, APSR_T));
  const storedLr = readLr(b);

  writeSp(b, frame);
  stackStore(b, frame, readReg(b, 0));
  stackStore(b, b.add(frame, num(b, 4)), readReg(b, 1));
  stackStore(b, b.add(frame, num(b, 8)), readReg(b, 2));
  stackStore(b, b.add(frame, num(b, 12)), readReg(b, 3));
  stackStore(b, b.add(frame, num(b, 16)), readReg(b, 12));
  stackStore(b, b.add(frame, num(b, 20)), storedLr);
  stackStore(
    b,
    b.add(frame, num(b, 24)),
    typeof returnPc === 'number' ? num(b, returnPc) : returnPc,
  );
  stackStore(b, b.add(frame, num(b, 28)), xpsr);
  writeLr(b, num(b, EXC_RETURN_THREAD_MSP));
  const vector = b.add(load(b, VTOR), b.shiftLeft(exception, num(b, 2)));
  const vectorOffset = b.select(
    types.number,
    b.greaterThanOrEqual(vector, num(b, FLASH_BASE)),
    (inner) => inner.subtract(vector, inner.constant(types.number, FLASH_BASE)),
    (inner) => inner.bitAnd(vector, inner.constant(types.number, FLASH_SIZE - 1)),
  );
  const handler = readWord(b, CODE, vectorOffset);

  b.writeState('pc', b.bitAnd(handler, num(b, 0xfffffffe)));
}

export function isExceptionReturn(b: Body, target: Value<number>): Value<boolean> {
  return b.equal(
    types.number,
    u32(b, b.bitAnd(target, num(b, EXC_RETURN_MASK))),
    num(b, EXC_RETURN_MASK),
  );
}

/** 异常返回：弹出 8 字帧，恢复 SP/LR/PC/APSR。 */
export function exceptionReturn(b: Body): void {
  const sp = readSp(b);
  const r0 = stackLoad(b, sp);
  const r1 = stackLoad(b, b.add(sp, num(b, 4)));
  const r2 = stackLoad(b, b.add(sp, num(b, 8)));
  const r3 = stackLoad(b, b.add(sp, num(b, 12)));
  const r12 = stackLoad(b, b.add(sp, num(b, 16)));
  const lr = stackLoad(b, b.add(sp, num(b, 20)));
  const pc = stackLoad(b, b.add(sp, num(b, 24)));
  const xpsr = stackLoad(b, b.add(sp, num(b, 28)));

  writeReg(b, 0, r0);
  writeReg(b, 1, r1);
  writeReg(b, 2, r2);
  writeReg(b, 3, r3);
  writeReg(b, 12, r12);
  writeLr(b, lr);
  writeSp(b, b.add(sp, num(b, 32)));
  b.writeState('apsr', b.bitOr(b.bitAnd(xpsr, num(b, 0xf8000000)), num(b, APSR_T)));
  b.writeState('pc', b.bitAnd(pc, num(b, 0xfffffffe)));
}

/**
 * 指令边界的中断派发。返回 true 表示已经进入异常，调用方跳过当前指令。
 * 固定顺序：SysTick → USART1 → USART2 → USART3。
 *
 * `irqDirty` 是本函数的门控：未置位时调用方根本不进入这里。屏蔽（PRIMASK=1）期间
 * 不清除标志，解除屏蔽后的第一条指令会重新扫描；取走一个异常后重新置位，因为可能
 * 还有别的挂起源（下一拍再判，各源自己的挂起位已被清除）。
 *
 * 只生成一份异常入口：先选出异常号，再统一压栈转向。
 */
export function dispatchExceptions(b: Body, returnPc: number | Value<number>): Value<boolean> {
  const taken = b.local(types.bool, false);
  const exception = b.local(types.number, 0);

  b.if(
    b.notEqual(types.number, b.readState('primask', types.number), num(b, 0)),
    () => {},
    (allowed) => {
      const body = asBody(allowed);

      body.writeState(IRQ_DIRTY, bool(body, false));
      body.if(
        systickPending(body),
        (tick) => {
          const scope = asBody(tick);

          acknowledgeSystick(scope);
          scope.setLocal(exception, num(scope, SYSTICK_EXCEPTION));
          scope.setLocal(taken, bool(scope, true));
        },
        (next) => {
          tryUsart(asBody(next), 0, taken, exception, returnPc);
        },
      );
      body.if(body.getLocal(taken), (enter) => {
        const scope = asBody(enter);

        enterException(scope, scope.getLocal(exception), returnPc);
        scope.writeState(IRQ_DIRTY, bool(scope, true));
      });
    },
  );

  return b.getLocal(taken);
}

function tryUsart(
  b: Body,
  index: number,
  taken: Local<boolean>,
  exception: Local<number>,
  returnPc: number | Value<number>,
): void {
  const config = USARTS[index];

  if (config === undefined) return;

  b.if(
    boolAnd(b, nvicEnabled(b, config.irq), usartPending(b, config)),
    (hit) => {
      const body = asBody(hit);

      clearNvicPending(body, config.irq);
      body.setLocal(exception, num(body, config.irq + 16));
      body.setLocal(taken, bool(body, true));
    },
    (next) => {
      tryUsart(asBody(next), index + 1, taken, exception, returnPc);
    },
  );
}

/** 系统区（0xE0000000 起）的读写入口。 */
export function readSystem(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    inRegion(b, address, SYSTICK_BASE, SYSTICK_BASE + 0x20),
    (systick) => {
      const body = asBody(systick);

      systick.setLocal(
        result,
        readSystick(body, body.subtract(address, num(body, SYSTICK_BASE)), size),
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, NVIC_BASE, NVIC_BASE + 0x1000),
        (nvic) => {
          const scope = asBody(nvic);

          nvic.setLocal(
            result,
            readNvic(scope, scope.subtract(address, num(scope, NVIC_BASE)), size),
          );
        },
        (next) => {
          const scope = asBody(next);

          scope.if(inRegion(scope, address, SCB_BASE, SCB_BASE + 0x40), (scb) => {
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
        inRegion(body, address, NVIC_BASE, NVIC_BASE + 0x1000),
        (nvic) => {
          const scope = asBody(nvic);

          writeNvic(scope, scope.subtract(address, num(scope, NVIC_BASE)), size, value);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(inRegion(scope, address, SCB_BASE, SCB_BASE + 0x40), (scb) => {
            const body2 = asBody(scb);

            writeScb(body2, body2.subtract(address, num(body2, SCB_BASE)), size, value);
          });
        },
      );
    },
  );
}
