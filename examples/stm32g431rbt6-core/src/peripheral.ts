import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  GPIO_BASE,
  PERIPH_ACTIVE,
  PERIPHERAL_BASE,
  PWR_BASE,
  RCC_BASE,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
  periphDeadlineState,
} from './layout';
import type { AccessSize } from './layout';
import { asBody, bool, num, readWordAt, u32, writeWordAt } from './ir';
import type { Body } from './ir';
import type { AlternateDriver } from './machine';

/** 0 表示没有未来事件；需要立即服务时用 1。 */
export const NO_DEADLINE_PS = 0;
export const IMMEDIATE_PS = 1;

export interface PeripheralRange {
  readonly base: number;
  readonly size: number;
}

/** 一个外设对 NVIC 暴露的中断源；异常号是 16 + CMSIS IRQn。 */
export interface InterruptSource {
  readonly exception: number;
  /** `pending` 只读取状态或内部寄存器，无副作用，结果可在该 IRQ 不参与仲裁时省略。 */
  readonly pendingIsPure?: true;
  readonly pending: (b: Body) => Value<boolean>;
  readonly acknowledge: (b: Body) => void;
}

/**
 * 外设模块的中央注册合同。
 *
 * 模块只负责自己的地址区间；`bus` 在静态地址下只发射命中的那一路，动态地址下把所有
 * 区间拼成一条 if/else。时间推进通过 `slot` + 两个 state 接入，不新增第二套调度器。
 */
export interface PeripheralModule {
  readonly id: string;
  readonly ranges: readonly PeripheralRange[];
  readonly read: (b: Body, address: Value<number>, size: number) => Value<number>;
  readonly write: (b: Body, address: Value<number>, size: AccessSize, value: Value<number>) => void;
  /**
   * 静态地址快速路径。动态地址仍然只走 `read`/`write`，不改变 module service 合同。
   *
   * 返回 `undefined` 表示该模块不处理：实现必须在返回前**没有发射任何 IR**，否则 bus
   * 回退到 `read` 时会把同一访问执行两次。`writeStatic` 返回 `false` 时合同相同。
   */
  readonly readStatic?: (b: Body, staticAddress: number, size: number) => Value<number> | undefined;
  readonly writeStatic?: (
    b: Body,
    staticAddress: number,
    size: AccessSize,
    value: Value<number>,
  ) => boolean;
  /** `periphActive` 的槽位；省略表示没有时间行为。 */
  readonly slot?: number;
  readonly advance?: (b: Body, elapsedPs: Value<number>) => void;
  readonly interrupts?: readonly InterruptSource[];
  readonly alternateDrivers?: readonly AlternateDriver[];
}

export const slotMask = (slot: number): number => 1 << (slot & 31);

export function peripheralSlotActive(b: Body, slot: number): Value<boolean> {
  return b.notEqual(
    types.number,
    b.bitAnd(b.readState(PERIPH_ACTIVE, types.number), num(b, slotMask(slot))),
    num(b, 0),
  );
}

/**
 * 置/清一个时间外设的活动位。`active` 为编译期常量时只发射一次位运算；运行期条件
 * 用 `select` 保持 direct 后端可编译。
 */
export function setPeripheralActive(b: Body, slot: number, active: boolean | Value<boolean>): void {
  const mask = slotMask(slot);
  const current = b.readState(PERIPH_ACTIVE, types.number);

  if (typeof active === 'boolean') {
    b.writeState(
      PERIPH_ACTIVE,
      active ? b.bitOr(current, num(b, mask)) : b.bitAnd(current, num(b, ~mask)),
    );

    return;
  }

  b.writeState(
    PERIPH_ACTIVE,
    b.select(
      types.number,
      active,
      (on) => on.bitOr(current, on.constant(types.number, mask)),
      (off) => off.bitAnd(current, off.constant(types.number, ~mask)),
    ),
  );
}

/** 写某槽的下一次事件剩余时间；0 表示没有未来事件。调用方负责在 inactive 时写 0。 */
export function setPeripheralDeadline(b: Body, slot: number, deadlinePs: Value<number>): void {
  // deadline 是皮秒，可能超过 2^32（例如 RTC/看门狗长周期）；必须用 number state，
  // 不能走 u32/store32 截断。
  b.writeState(periphDeadlineState(slot), deadlinePs);
}

export function readPeripheralDeadline(b: Body, slot: number): Value<number> {
  return b.readState(periphDeadlineState(slot), types.number);
}

/**
 * 把模块状态写到 `periph` 之外的专属 memory。模块必须使用自己的 memory 名，避免不同
 * 外设共享后备字。
 */
export function storeModuleWord(
  b: Body,
  memory: string,
  offset: number,
  value: Value<number>,
): void {
  writeWordAt(b, memory, offset, u32(b, value));
}

export function loadModuleWord(b: Body, memory: string, offset: number): Value<number> {
  return readWordAt(b, memory, offset);
}

/** 核心已直接分派的区间；模块不得重复注册。 */
const CORE_RANGES: readonly PeripheralRange[] = [
  { base: RCC_BASE, size: 0x400 },
  { base: GPIO_BASE, size: 0x2000 },
  { base: USART1_BASE, size: 0x400 },
  { base: USART2_BASE, size: 0x400 },
  { base: USART3_BASE, size: 0x400 },
  { base: PWR_BASE, size: 0x400 },
];

const overlaps = (left: PeripheralRange, right: PeripheralRange): boolean =>
  left.base < right.base + right.size && right.base < left.base + left.size;

/**
 * 创建 Machine 时 fail fast：区间必须落在外设地址空间内、互不重叠、也不与核心直接
 * 分派的 RCC/GPIO/USART/FLASH/PWR 冲突。这样模块注册错误不会静默覆盖别的外设。
 */
export function validatePeripheralModules(modules: readonly PeripheralModule[]): void {
  if (modules.length > 32)
    throw new Error('stm32g431rbt6: at most 32 peripheral modules fit the service PC window');

  const seen: { readonly id: string; readonly range: PeripheralRange }[] = [];
  const slots = new Map<number, string>();

  for (const module of modules) {
    if (module.ranges.length === 0)
      throw new Error(`stm32g431rbt6: peripheral ${module.id} has no ranges`);

    if (module.slot !== undefined) {
      if (!Number.isInteger(module.slot) || module.slot < 0 || module.slot >= 16)
        throw new Error(`stm32g431rbt6: peripheral ${module.id} has invalid slot ${module.slot}`);
      const owner = slots.get(module.slot);

      if (owner !== undefined)
        throw new Error(
          `stm32g431rbt6: peripheral ${module.id} reuses time slot ${module.slot} of ${owner}`,
        );
      slots.set(module.slot, module.id);
    }

    for (const range of module.ranges) {
      if (
        !Number.isSafeInteger(range.base) ||
        !Number.isSafeInteger(range.size) ||
        range.size <= 0 ||
        range.base < PERIPHERAL_BASE ||
        range.base + range.size > 0x60000000
      )
        throw new Error(
          `stm32g431rbt6: peripheral ${module.id} range 0x${range.base.toString(16)}+0x${range.size.toString(16)} is outside the peripheral space`,
        );

      for (const core of CORE_RANGES)
        if (overlaps(range, core))
          throw new Error(
            `stm32g431rbt6: peripheral ${module.id} range 0x${range.base.toString(16)} overlaps a core-handled range`,
          );

      for (const other of seen)
        if (overlaps(range, other.range))
          throw new Error(
            `stm32g431rbt6: peripheral ${module.id} range 0x${range.base.toString(16)} overlaps ${other.id}`,
          );

      seen.push({ id: module.id, range });
    }
  }
}

export const activeMaskValue = (b: Body): Value<number> => b.readState(PERIPH_ACTIVE, types.number);

/** 便于模块在条件分支里设置活动位与期限。 */
export function activatePeripheralSlot(b: Body, slot: number, deadlinePs: Value<number>): void {
  setPeripheralActive(b, slot, true);
  setPeripheralDeadline(b, slot, deadlinePs);
}

export function deactivatePeripheralSlot(b: Body, slot: number): void {
  setPeripheralActive(b, slot, false);
  setPeripheralDeadline(b, slot, num(b, NO_DEADLINE_PS));
}

/** 供模块在服务块内判断自己是否真的需要推进（避免只依赖共享位）。 */
export const slotEnabled = (b: Body, slot: number): Value<boolean> => peripheralSlotActive(b, slot);

/** 让模块的静态分支结构保持与 `asBody` 相同的窄视图。 */
export const peripheralBody = (b: unknown): Body => asBody(b);

export const booleanConstant = (b: Body, value: boolean): Value<boolean> => bool(b, value);
