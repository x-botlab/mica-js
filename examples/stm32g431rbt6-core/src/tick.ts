import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  ADVANCE_ELAPSED,
  ADVANCE_PENDING,
  CPU_CYCLE_PS,
  NOW_PS,
  PENDING_PS,
  PERIPH_ACTIVE,
  SERVICE_ADVANCE_BASE,
  SERVICE_DISPATCH,
  SYSTICK_LOAD,
  SYSTICK_ON,
  TICK_ACTIVE,
  TICK_PS,
  TX_MASK,
  periphDeadlineState,
} from './layout';
import { asBody, bool, boolAnd, boolOr, boolBit, num } from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import { readHclkHz } from './clock-tree';
import { usartNextEventPs } from './usart';

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

/** 本 profile 中真正有时间行为的槽位；翻译期决定，指令块/服务块不扫描空槽。 */
function activeSlots(): readonly number[] {
  const slots = new Set<number>();

  for (const peripheral of machine().peripherals)
    if (peripheral.advance !== undefined && peripheral.slot !== undefined)
      slots.add(peripheral.slot);

  return [...slots].sort((left, right) => left - right);
}

function activeMask(): number {
  let mask = 0;

  for (const slot of activeSlots()) mask |= 1 << slot;

  return mask >>> 0;
}

/**
 * 当前 CPU 周期耗时。生产 adapter 使用运行期 `cpuCyclePs`（RCC 写入后刷新）；
 * 小型 rig 没有该 state 时退回翻译期静态值。
 */
export function cpuCyclePs(b: Body): Value<number> {
  if (machine().dynamicClock !== true) return num(b, machine().cyclePs);

  const hclk = b.max(num(b, 1), readHclkHz(b));

  return b.max(num(b, 1), b.floor(b.divide(num(b, 1_000_000_000_000), hclk)));
}

/** RCC 写入后刷新 CPU 周期耗时；服务块在返回指令块前执行。 */
export function refreshCpuClock(b: Body): void {
  if (machine().dynamicClock !== true) return;
  b.writeState(CPU_CYCLE_PS, cpuCyclePs(b));
}

/** 重算 `tickPs`。调用点：SysTick CTRL/LOAD 写入、USART 发送开始/结束、外设活动变化。 */
export function refreshTick(b: Body): void {
  const cyclePs = cpuCyclePs(b);
  const min = (
    body: Body,
    candidate: Value<number>,
    current: Value<number>,
  ): Value<number> =>
    body.select(
      types.number,
      boolAnd(
        body,
        body.notEqual(types.number, candidate, num(body, 0)),
        body.lessThan(candidate, current),
      ),
      () => candidate,
      () => current,
    );
  let tick: Value<number> = num(b, TICK_CEILING_PS);
  const systickOn = b.readState(SYSTICK_ON, types.bool);

  const systickPeriod = b.multiply(
    b.add(b.readState(SYSTICK_LOAD, types.number), num(b, 1)),
    cyclePs,
  );

  tick = b.select(
    types.number,
    systickOn,
    (on) => min(asBody(on), systickPeriod, tick),
    () => tick,
  );

  const usart = b.select(
    types.number,
    b.notEqual(types.number, b.readState(TX_MASK, types.number), num(b, 0)),
    (busy) => usartNextEventPs(asBody(busy)),
    (idle) => idle.constant(types.number, 0),
  );

  tick = min(b, usart, tick);

  // 外设模块自己维护“距下一次事件还剩多少 ps”。0 表示没有未来事件；只有活动位为 1
  // 的槽参与取最小，空闲模块不产生服务节拍。这里用纯 select 组合，避免每个槽共享
  // 一个 local 造成 IR 校验的递归膨胀。
  for (const slot of activeSlots()) {
    const active = boolBit(b, b.readState(PERIPH_ACTIVE, types.number), 1 << slot);
    const deadline = b.select(
      types.number,
      active,
      (on) => on.readState(periphDeadlineState(slot), types.number),
      (off) => off.constant(types.number, 0),
    );

    tick = min(b, deadline, tick);
  }

  const active = boolOr(
    b,
    boolOr(b, systickOn, b.notEqual(types.number, b.readState(TX_MASK, types.number), num(b, 0))),
    b.notEqual(types.number, b.readState(PERIPH_ACTIVE, types.number), num(b, 0)),
  );

  // 从空闲切到激活时丢弃此前累积的时间：SysTick 使能之前的时间不应计给 SysTick，
  // 否则使能后的第一次服务会一次性跨过很多周期。
  b.if(boolAnd(b, active, b.not(b.readState(TICK_ACTIVE, types.bool))), (starting) => {
    asBody(starting).writeState(PENDING_PS, num(asBody(starting), 0));
  });

  b.writeState(TICK_ACTIVE, active);
  b.writeState(TICK_PS, tick);
}

/** 把当前活动槽安排到各自的服务块；返回是否已把 PC 转到推进服务。 */
export function schedulePeripheralAdvances(
  b: Body,
  elapsedPs: Value<number>,
): Value<boolean> {
  const scheduled = b.local(types.bool, false);
  const slots = activeSlots();
  const recognized = activeMask();
  const mask = b.bitAnd(b.readState(PERIPH_ACTIVE, types.number), num(b, recognized));

  b.if(b.notEqual(types.number, mask, num(b, 0)), (active) => {
    const scope = asBody(active);

    scope.writeState(ADVANCE_ELAPSED, elapsedPs);
    scope.writeState(ADVANCE_PENDING, mask);

    const step = (body: Body, index: number): void => {
      const slot = slots[index];

      if (slot === undefined) return;

      body.if(boolBit(body, mask, 1 << slot), (hit) => {
        const inner = asBody(hit);

        inner.writeState('pc', num(inner, SERVICE_ADVANCE_BASE + slot));
        inner.setLocal(scheduled, bool(inner, true));
      }, (next) => step(asBody(next), index + 1));
    };

    step(scope, 0);
  });

  return b.getLocal(scheduled);
}

/**
 * 一个模块推进服务块：只展开当前槽的 `advance`，然后根据剩余活动槽转到下一个块，
 * 全部完成后回到 `resume`。这样 SERVICE_TICK 不必内联所有外设的时间代码。
 */
export function advanceServiceSlot(b: Body, pc: number, resume: Value<number>): void {
  const slot = pc - SERVICE_ADVANCE_BASE;
  const module = machine().peripherals.find(
    (peripheral) => peripheral.slot === slot && peripheral.advance !== undefined,
  );
  const recognized = activeMask();
  const remaining = b.local(
    types.number,
    b.bitAnd(
      b.readState(ADVANCE_PENDING, types.number),
      num(b, (~(1 << slot) & recognized) >>> 0),
    ),
  );

  if (module?.advance !== undefined)
    module.advance(b, b.readState(ADVANCE_ELAPSED, types.number));

  b.writeState(ADVANCE_PENDING, b.getLocal(remaining));

  const slots = activeSlots();
  const step = (body: Body, index: number): void => {
    const nextSlot = slots[index];

    if (nextSlot === undefined) return;

    body.if(boolBit(body, body.getLocal(remaining), 1 << nextSlot), (hit) => {
      asBody(hit).writeState('pc', num(asBody(hit), SERVICE_ADVANCE_BASE + nextSlot));
    }, (next) => step(asBody(next), index + 1));
  };

  b.if(
    b.notEqual(types.number, b.getLocal(remaining), num(b, 0)),
    (more) => step(asBody(more), 0),
    (done) => {
      const scope = asBody(done);

      scope.writeState(ADVANCE_ELAPSED, num(scope, 0));
      scope.writeState('pc', num(scope, SERVICE_DISPATCH));
    },
  );
}

/** 绝对仿真时间（ps），只在服务块推进后读取。 */
export const currentTimePs = (b: Body): Value<number> => b.readState(NOW_PS, types.number);
