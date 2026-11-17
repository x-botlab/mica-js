import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  EXTI,
  EXTI_BASE,
  EXTI_SIZE,
  IRQ_DIRTY,
  PERIPHERAL_END,
  SERVICE_IRQ,
  exceptionOf,
} from './layout';
import type { AccessSize } from './layout';
import { EXTI_EVENT, EXTI_INIT, EXTI_PREV } from './system-layout';
import { CPU_HIDDEN_EVENT } from './exclusive';
import {
  asBody,
  boolAnd,
  boolBit,
  boolOr,
  markService,
  num,
  readWordAt,
  u32,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { PORTS } from './machine';
import { SYS } from './layout';
import type { PeripheralModule } from './peripheral';
import { readSyscfgExtiPort } from './syscfg';

/**
 * STM32G431 的 EXTI（外部中断/事件控制器）。
 *
 * GPIO line 0–15 根据 `SYSCFG_EXTICR1..4` 路由到真实端口采样；`RTSR/FTSR` 选择边沿，
 * `PR` 为 W1C 挂起位，`IMR` 为中断屏蔽，`EMR` 为事件屏蔽，`SWIER` 写 1 置位 `PR`。
 * 关键语义：**边沿在 IMR 屏蔽时仍置 PR**；`IMR & PR` 才形成 NVIC 中断线，因此解除
 * 屏蔽后挂起仍可见，NVIC 的 ICPR 也不会清除 PR（电平会重新挂起）。
 *
 * 文件不 import NVIC：中断通过 `PeripheralModule.interrupts` 暴露，NVIC 只扫描
 * `machine().interruptSources`。line16–39 只保留寄存器/PR 行为，未接内部源。
 * 低功耗只提供 event pending；Sleep/Stop 本身不在本模型范围内。
 */

export { EXTI_BASE };

const IMR1 = 0x00;
const EMR1 = 0x04;
const RTSR1 = 0x08;
const FTSR1 = 0x0c;
const SWIER1 = 0x10;
const PR1 = 0x14;
const IMR2 = 0x20;
const EMR2 = 0x24;
const RTSR2 = 0x28;
const FTSR2 = 0x2c;
const SWIER2 = 0x30;
const PR2 = 0x34;

const LINE_IRQ = [6, 7, 8, 9, 10] as const;
const GROUP_5_9_IRQ = 23;
const GROUP_10_15_IRQ = 40;

const lineBit = (line: number): number => 1 << line;

const raw = (b: Body, offset: number): Value<number> => readWordAt(b, EXTI, offset);
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, EXTI, offset, u32(b, value));
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

const placed = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  const width = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
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
  const mask = b.shiftLeft(num(b, width), shift);

  return b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed(b, value, offset, size));
}

function requestIrqScan(b: Body): void {
  b.writeState(IRQ_DIRTY, b.constant(types.bool, true));
  markService(b, SERVICE_IRQ);
}

function rangeMask(first: number, last: number): number {
  let mask = 0;

  for (let line = first; line <= last; line += 1) mask |= lineBit(line);

  return mask >>> 0;
}

function rangePending(b: Body, first: number, last: number): Value<boolean> {
  const mask = rangeMask(first, last);

  return b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(raw(b, PR1), raw(b, IMR1)), num(b, mask)),
    num(b, 0),
  );
}

/** 单条 GPIO line 是否正在向 NVIC 发出中断（`IMR & PR`）。 */
export const extiLinePending = (b: Body, line: number): Value<boolean> =>
  rangePending(b, line, line);

/** GPIO line 共享分组的中断条件。 */
export const extiIrqPending = (b: Body, first: number, last: number): Value<boolean> =>
  rangePending(b, first, last);

/** 每条 GPIO line 对应的 Cortex-M 异常 IRQ。 */
export const EXTI_LINE_IRQS: readonly number[] = [...LINE_IRQ];
export const EXTI_GROUP_IRQS = {
  line5To9: GROUP_5_9_IRQ,
  line10To15: GROUP_10_15_IRQ,
} as const;

/** 统一挂起描述；模块通过 `EXTI_MODULE.interrupts` 交给 NVIC。 */
export const EXTI_PENDING_RANGES: readonly {
  readonly irq: number;
  readonly first: number;
  readonly last: number;
}[] = [
  ...LINE_IRQ.map((irq, line) => ({ irq, first: line, last: line })),
  { irq: GROUP_5_9_IRQ, first: 5, last: 9 },
  { irq: GROUP_10_15_IRQ, first: 10, last: 15 },
];

const ACKNOWLEDGE_NONE = (): void => {};

const INTERRUPTS = EXTI_PENDING_RANGES.map((range) => ({
  exception: exceptionOf(range.irq),
  pending: (b: Body) => extiIrqPending(b, range.first, range.last),
  acknowledge: ACKNOWLEDGE_NONE,
}));

function pinHigh(b: Body, pin: string): Value<boolean> {
  return b.equal(
    types.logic,
    b.field(b.readSample(pin), 'level'),
    b.constant(types.logic, types.logic.members.high),
  );
}

const PORT_CODES: readonly { readonly code: number; readonly port: number }[] = [
  { code: 0, port: 0 },
  { code: 1, port: 1 },
  { code: 2, port: 2 },
  { code: 3, port: 3 },
  { code: 5, port: 4 },
];

/** 读取 line 当前路由到的 GPIO 电平；不存在的端口或引脚视为低。 */
function sampleLineLevel(b: Body, line: number): Value<boolean> {
  const code = readSyscfgExtiPort(b, line);
  const level = b.local(types.bool, false);

  for (const { code: value, port } of PORT_CODES) {
    const pin = PORTS[port]?.pins[line];

    if (pin === undefined || pin === null) continue;

    b.if(b.equal(types.number, code, num(b, value)), (hit) => {
      asBody(hit).setLocal(level, pinHigh(asBody(hit), pin));
    });
  }

  return b.getLocal(level);
}

function sampleLine(b: Body, line: number): void {
  const bit = lineBit(line);
  const level = sampleLineLevel(b, line);
  const initialized = boolBit(b, raw(b, EXTI_INIT), bit);
  const previous = boolBit(b, raw(b, EXTI_PREV), bit);
  const rising = boolAnd(
    b,
    boolBit(b, raw(b, RTSR1), bit),
    boolAnd(b, level, b.not(previous)),
  );
  const falling = boolAnd(
    b,
    boolBit(b, raw(b, FTSR1), bit),
    boolAnd(b, b.not(level), previous),
  );
  const edge = boolOr(b, rising, falling);

  b.if(initialized, (ready) => {
    const body = asBody(ready);

    body.if(edge, (detected) => {
      const scope = asBody(detected);

      store(scope, PR1, scope.bitOr(raw(scope, PR1), num(scope, bit)));
      scope.if(boolBit(scope, raw(scope, EMR1), bit), (event) => {
        const inner = asBody(event);

        store(inner, EXTI_EVENT, inner.bitOr(raw(inner, EXTI_EVENT), num(inner, bit)));
        // 同一事件也置 CPU 私有 event 寄存器，供 WFE 消费。
        writeWordAt(inner, SYS, CPU_HIDDEN_EVENT, num(inner, 1));
      });
      scope.if(boolBit(scope, raw(scope, IMR1), bit), requestIrqScan);
    });
  });

  store(
    b,
    EXTI_PREV,
    b.bitOr(
      b.bitAnd(raw(b, EXTI_PREV), num(b, ~bit)),
      b.select(
        types.number,
        level,
        (inner) => inner.constant(types.number, bit),
        (inner) => inner.constant(types.number, 0),
      ),
    ),
  );
  store(b, EXTI_INIT, b.bitOr(raw(b, EXTI_INIT), num(b, bit)));
}

/**
 * 采样 GPIO line0–15。由 EXTI 模块的 `advance` 在服务节拍调用。
 * 每轮首个采样只建立基线；之后按 RTSR/FTSR 检测边沿并置 PR。
 */
export function sampleExti(b: Body): void {
  b.if(
    b.notEqual(types.number, b.bitOr(raw(b, RTSR1), raw(b, FTSR1)), num(b, 0)),
    (active) => {
      const body = asBody(active);

      for (let line = 0; line < 16; line += 1) sampleLine(body, line);
    },
  );
}

/** 是否配置了至少一个 GPIO 边沿触发。 */
export const extiOn = (b: Body): Value<boolean> =>
  b.notEqual(types.number, b.bitOr(raw(b, RTSR1), raw(b, FTSR1)), num(b, 0));

/** 任意事件线挂起；WFE 代理应消费该状态。 */
export const extiEventPending = (b: Body): Value<boolean> =>
  b.notEqual(types.number, raw(b, EXTI_EVENT), num(b, 0));

/** 消费全部事件挂起（WFE 唤醒后调用）。 */
export const consumeExtiEvents = (b: Body): void => {
  store(b, EXTI_EVENT, num(b, 0));
  writeWordAt(b, SYS, CPU_HIDDEN_EVENT, num(b, 0));
};

function triggerUpdate(
  b: Body,
  register: number,
  writeOffset: Value<number>,
  value: Value<number>,
  size: number,
): void {
  const current = raw(b, register);
  const next = merge(b, current, value, writeOffset, size);
  const changed = b.bitAnd(b.bitXor(current, next), num(b, 0xffff));

  store(b, register, next);
  for (let line = 0; line < 16; line += 1)
    b.if(boolBit(b, changed, lineBit(line)), (hit) => {
      const body = asBody(hit);

      store(
        body,
        EXTI_INIT,
        body.bitAnd(raw(body, EXTI_INIT), num(body, ~lineBit(line) & 0xffff)),
      );
    });
  requestIrqScan(b);
}

function readStored(
  b: Body,
  offset: Value<number>,
  size: number,
  allowed: readonly number[],
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  for (const register of allowed)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      asBody(hit).setLocal(result, raw(asBody(hit), register));
    });

  return extract(b, b.getLocal(result), offset, size);
}

const READABLE = [IMR1, EMR1, RTSR1, FTSR1, PR1, IMR2, EMR2, RTSR2, FTSR2, PR2] as const;

/** EXTI 寄存器读。SWIER 读回 0；未实现偏移读 0。 */
export function readExti(b: Body, offset: Value<number>, size: number): Value<number> {
  return readStored(b, offset, size, READABLE);
}

/** EXTI 寄存器写。 */
export function writeExti(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  for (const register of [IMR1, EMR1, RTSR1, FTSR1, IMR2, EMR2, RTSR2, FTSR2] as const)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      const body = asBody(hit);

      if (register === RTSR1 || register === FTSR1) triggerUpdate(body, register, offset, value, size);
      else {
        store(body, register, merge(body, raw(body, register), value, offset, size));
        if (register === IMR1 || register === IMR2) requestIrqScan(body);
      }
    });

  for (const register of [SWIER1, SWIER2] as const)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      const body = asBody(hit);
      const pending = register === SWIER1 ? PR1 : PR2;
      const bits = placed(body, value, offset, size);

      store(body, pending, body.bitOr(raw(body, pending), bits));
      if (register === SWIER1)
        body.if(
          body.notEqual(
            types.number,
            body.bitAnd(raw(body, IMR1), bits),
            num(body, 0),
          ),
          requestIrqScan,
          () => {},
        );
    });

  for (const register of [PR1, PR2] as const)
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      const body = asBody(hit);

      store(body, register, body.bitAnd(raw(body, register), body.bitNot(placed(body, value, offset, size))));
    });
}

/** 注册到中央外设表的 EXTI 模块。 */
export const EXTI_MODULE: PeripheralModule = {
  id: 'exti',
  ranges: [{ base: EXTI_BASE, size: EXTI_SIZE }],
  read: (b, address, size) => readExti(b, b.subtract(address, num(b, EXTI_BASE)), size),
  write: (b, address, size: AccessSize, value) =>
    writeExti(b, b.subtract(address, num(b, EXTI_BASE)), size, value),
  interrupts: INTERRUPTS,
};
