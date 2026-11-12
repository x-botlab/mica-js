import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  IRQ_DIRTY,
  SYSTICK_COUNT,
  SYSTICK_CTRL,
  SYSTICK_LOAD,
  SYSTICK_ON,
  SYSTICK_PENDING,
  SYSTICK_VAL,
} from './layout';
import { asBody, bool, boolBitAt, num, u32 } from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import { refreshTick } from './tick';

/**
 * Cortex-M SysTick。
 *
 * 校准值固定为 0（NOREF=1），时钟源按处理器时钟处理；VAL 递减到 0 的下一拍重装 LOAD，
 * 并置 COUNTFLAG。TICKINT 置位时同时置挂起位，由 `nvic.ts` 在指令边界响应。
 *
 * CTRL/LOAD/VAL/COUNTFLAG/PENDING 是 state（不是固件可见的寄存器映像），节拍推进只需要
 * 几次 state 读写；`systickOn` 影子 CTRL.ENABLE，未使能时整段推进被跳过。
 */

const CTRL = 0x00;
const LOAD = 0x04;
const VAL = 0x08;
const COUNTFLAG = 0x0c;

const stateName = (offset: number): string => {
  if (offset === CTRL) return SYSTICK_CTRL;
  if (offset === LOAD) return SYSTICK_LOAD;
  if (offset === VAL) return SYSTICK_VAL;

  return SYSTICK_COUNT;
};

const load = (b: Body, offset: number): Value<number> =>
  b.readState(stateName(offset), types.number);

const store = (b: Body, offset: number, value: Value<number>): void => {
  b.writeState(stateName(offset), u32(b, value));
};

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

export function readSystick(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, CTRL)),
    (ctrl) => {
      const body = asBody(ctrl);
      const bits = body.bitAnd(load(body, CTRL), num(body, 0x7));
      const flag = body.shiftLeft(load(body, COUNTFLAG), num(body, 16));

      store(body, COUNTFLAG, num(body, 0));
      ctrl.setLocal(result, body.bitOr(bits, flag));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, LOAD)),
        (reload) => reload.setLocal(result, load(asBody(reload), LOAD)),
        (next) => {
          const scope = asBody(next);

          scope.if(scope.equal(types.number, wordOffset, num(scope, VAL)), (value) => {
            value.setLocal(result, load(asBody(value), VAL));
          });
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeSystick(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  b.if(
    b.equal(types.number, wordOffset, num(b, VAL)),
    (val) => {
      const body = asBody(val);

      store(body, VAL, num(body, 0));
      store(body, COUNTFLAG, num(body, 0));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, LOAD)),
        (reload) => {
          const scope = asBody(reload);

          store(scope, LOAD, scope.bitAnd(u32(scope, value), num(scope, 0xffffff)));
          // 周期变化会改变可用的服务节拍粒度。
          refreshTick(scope);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(scope.equal(types.number, wordOffset, num(scope, CTRL)), (ctrl) => {
            const body2 = asBody(ctrl);
            const current = load(body2, CTRL);
            const width = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
            const shift = body2.multiply(body2.bitAnd(offset, num(body2, 3)), num(body2, 8));
            const placed = body2.shiftLeft(
              body2.bitAnd(u32(body2, value), num(body2, width)),
              shift,
            );
            const mask = body2.shiftLeft(num(body2, width), shift);
            const merged = body2.bitAnd(
              u32(body2, body2.bitOr(body2.bitAnd(current, body2.bitNot(mask)), placed)),
              num(body2, 0x7),
            );

            store(body2, CTRL, merged);
            body2.writeState(SYSTICK_ON, boolBitAt(body2, merged, 0));
            body2.writeState(IRQ_DIRTY, bool(body2, true));
            // 使能状态变化会改变可用的服务节拍粒度。
            refreshTick(body2);
          });
        },
      );
    },
  );
}

/**
 * 每个外设节拍按经过的仿真时间推进 SysTick（调用方已确认 CTRL.ENABLE）。
 *
 * 一次推进可能跨越整周期：`after % period` 恰为 0 时按重装值（LOAD）继续，而不是落在 0。
 * 否则下一拍会以 VAL=0 再判一次「到 0」，同一周期连续置两次 COUNTFLAG/挂起位，
 * 让一个 1 ms 周期产生两次中断。
 */
export function advanceSystick(b: Body, elapsedPs: Value<number>): void {
  const cycles = b.floor(b.divide(elapsedPs, num(b, machine().cyclePs)));

  b.if(b.greaterThan(cycles, num(b, 0)), (inner) => {
    const body = asBody(inner);
    const value = load(body, VAL);
    const reload = load(body, LOAD);
    const period = body.add(reload, num(body, 1));
    const wrapped = body.lessThanOrEqual(value, cycles);
    const after = body.subtract(cycles, value);
    const remainder = body.subtract(period, body.remainder(after, period));
    const next = body.select(
      types.number,
      body.equal(types.number, remainder, period),
      () => reload,
      () => remainder,
    );

    body.if(
      wrapped,
      (wrappedBody) => {
        const scope = asBody(wrappedBody);

        store(scope, VAL, next);
        store(scope, COUNTFLAG, num(scope, 1));
        scope.if(boolBitAt(scope, load(scope, CTRL), 1), (tick) => {
          const body2 = asBody(tick);

          body2.writeState(SYSTICK_PENDING, num(body2, 1));
          body2.writeState(IRQ_DIRTY, bool(body2, true));
        });
      },
      (normal) => {
        const scope = asBody(normal);

        store(scope, VAL, scope.subtract(value, cycles));
      },
    );
  });
}

export function systickPending(b: Body): Value<boolean> {
  return b.notEqual(types.number, b.readState(SYSTICK_PENDING, types.number), num(b, 0));
}

/** SysTick 异常入口：清除挂起位。 */
export function acknowledgeSystick(b: Body): void {
  b.writeState(SYSTICK_PENDING, num(b, 0));
}

export const SYSTICK_EXCEPTION = 15;
