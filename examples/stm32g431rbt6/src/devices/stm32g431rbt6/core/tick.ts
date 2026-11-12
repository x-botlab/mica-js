import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { PENDING_PS, SYSTICK_LOAD, SYSTICK_ON, TICK_ACTIVE, TICK_PS, TX_MASK } from './layout';
import { asBody, boolAnd, boolOr, num } from './ir';
import type { Body } from './ir';
import { machine } from './machine';

/**
 * 服务节拍粒度。
 *
 * 指令块每个只在 `pendingPs` 上累加自己的耗时，再和 `tickPs` 比一次；粒度越粗，服务块
 * （SysTick/USART 推进、异常派发）被摊销得越薄，但粒度必须细于任何一种需要按时间推进
 * 的外设：
 *
 * - SysTick：`advanceSystick` 按经过的周期数推进，一次可以跨过最多一个周期，
 *   因此粒度不得超过 `(LOAD + 1) × cyclePs`；
 * - USART：`advanceUsart` 一次只推进一个位，因此粒度不得超过位时长。位时长由 BRR
 *   决定、可能远小于 1 µs，这里统一按 1 µs 收紧（115200 baud 的位时长约 8.7 µs）。
 *
 * 粒度只由**活跃**外设决定：SysTick 使能时取它的周期，有发送活动时取 1 µs，两者同时
 * 活跃取较小值。没有活跃外设时取上限 1 s（此时指令块根本不会进服务块，`tickActive`
 * 为 false）。粒度只在会改变上述条件的寄存器写入处重算，指令块内没有额外负担。
 */
const TICK_CEILING_PS = 1_000_000_000_000;
const USART_TICK_PS = 1_000_000;

/** 重算 `tickPs`。调用点：SysTick CTRL/LOAD 写入、USART 发送开始/结束。 */
export function refreshTick(b: Body): void {
  const cyclePs = machine().cyclePs;
  const tick = b.local(types.number, TICK_CEILING_PS);

  b.if(b.readState(SYSTICK_ON, types.bool), (on) => {
    const scope = asBody(on);
    const period: Value<number> = scope.multiply(
      scope.add(scope.readState(SYSTICK_LOAD, types.number), num(scope, 1)),
      num(scope, cyclePs),
    );

    scope.if(scope.lessThan(period, scope.getLocal(tick)), (shorter) => {
      asBody(shorter).setLocal(tick, period);
    });
  });

  b.if(b.notEqual(types.number, b.readState(TX_MASK, types.number), num(b, 0)), (busy) => {
    const scope = asBody(busy);

    scope.if(scope.greaterThan(scope.getLocal(tick), num(scope, USART_TICK_PS)), (sending) => {
      const inner = asBody(sending);

      inner.setLocal(tick, num(inner, USART_TICK_PS));
    });
  });

  const active = boolOr(
    b,
    b.readState(SYSTICK_ON, types.bool),
    b.notEqual(types.number, b.readState(TX_MASK, types.number), num(b, 0)),
  );

  // 从空闲切到激活时丢弃此前累积的时间：SysTick 使能之前的时间不应计给 SysTick，
  // 否则使能后的第一次服务会一次性跨过很多周期。
  b.if(boolAnd(b, active, b.not(b.readState(TICK_ACTIVE, types.bool))), (starting) => {
    asBody(starting).writeState(PENDING_PS, num(asBody(starting), 0));
  });

  b.writeState(TICK_ACTIVE, active);
  b.writeState(TICK_PS, b.getLocal(tick));
}
