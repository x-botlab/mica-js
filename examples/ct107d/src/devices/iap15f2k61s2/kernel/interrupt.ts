import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  PERIPH,
  SFR_IE,
  SFR_IP,
  SFR_IP2,
  SFR_IP2H,
  SFR_IPH,
  jumpToValue,
  number,
  popByte,
  pushAddressValue,
  pushReturnAddress,
  readSfrBit,
  asBody,
  sfrBitIsSet,
} from './ir';
import type { Body } from './ir';
import { machine } from './machine';

/**
 * 中断控制器。
 *
 * STC15 的每个中断源有允许位与请求标志；多数源可在 IP/IP2 中选低/高两级优先级，
 * INT2/INT3/INT4/T2 固定为最低级。中断只在指令边界响应：时序类外设（定时器、串口、
 * ADC、PCA、SPI）在边界上推进并置位请求标志，控制器只负责选出当前可响应的源。
 *
 * 请求标志都是 SFR 位；写入方（外设或软件）调用 `markIrqDirty` 通知控制器重新扫描，
 * 常见路径因此只需一次字节读与比较。
 */

export const IRQ_DIRTY = 0x00;
export const IRQ_LEVEL = 0x01;
export const IRQ_DEPTH = 0x02;
export const IRQ_STACK = 0x04;
const IRQ_STACK_MASK = 0x0f;

const LEVEL_LOW = 1;
const LEVEL_HIGH = 2;

export interface InterruptSource {
  readonly id: string;
  /** 中断向量地址。 */
  readonly vector: number;
  /** 相同优先级内的查询次序，数值越小越先响应。 */
  readonly query: number;
  /** 可编程优先级位；省略表示固定最低优先级。 */
  readonly priority?: { readonly register: 'IP' | 'IP2'; readonly bit: number };
  readonly enabled: (b: Body) => Value<boolean>;
  readonly pending: (b: Body) => Value<boolean>;
  /** 响应时清除硬件请求标志（边沿触发源）；软件清零的源省略。 */
  readonly acknowledge?: (b: Body) => void;
}

export const IRQ_VECTORS = {
  int0: 0x0003,
  timer0: 0x000b,
  int1: 0x0013,
  timer1: 0x001b,
  uart1: 0x0023,
  adc: 0x002b,
  lvd: 0x0033,
  pca: 0x003b,
  uart2: 0x0043,
  spi: 0x004b,
  int2: 0x0053,
  int3: 0x005b,
  timer2: 0x0063,
  int4: 0x0083,
} as const;

/** 让中断控制器在下一条指令边界重新扫描请求。 */
export function markIrqDirty(b: Body): void {
  b.store8(PERIPH, number(b, IRQ_DIRTY), number(b, 1));
}

/** 中断允许/优先级寄存器写入后需要重新扫描：允许位本身也参与判定。 */
export function watchInterruptEnables(b: Body, address: number): void {
  if (
    address === SFR_IE ||
    address === SFR_IP ||
    address === SFR_IP2 ||
    address === SFR_IPH ||
    address === SFR_IP2H
  )
    markIrqDirty(b);
}

function priorityIsHigh(b: Body, priority: InterruptSource['priority']): Value<boolean> {
  if (priority === undefined) return b.constant(types.bool, false);

  const address = priority.register === 'IP' ? SFR_IP : SFR_IP2;
  const high = priority.register === 'IP' ? SFR_IPH : SFR_IP2H;

  return b.notEqual(
    types.number,
    b.bitOr(readSfrBit(b, high, priority.bit), readSfrBit(b, address, priority.bit)),
    number(b, 0),
  );
}

export class InterruptController {
  private readonly sources: InterruptSource[] = [];

  register(...sources: readonly InterruptSource[]): this {
    for (const source of sources) {
      if (this.sources.some((existing) => existing.id === source.id))
        throw new Error(`iap15f2k61s2: 中断源重复 ${source.id}`);

      this.sources.push(source);
    }

    return this;
  }

  /**
   * 生成一段 IR：有可响应请求时压栈并转向向量。
   *
   * `returnPc` 是常量（普通指令边界）或运行期值（节拍服务块：返回地址来自保存的下一条
   * PC）。两者都按硬件语义先压低字节再压高字节。
   */
  dispatch(b: Body, returnPc: number | Value<number>): void {
    const dirty = b.load8(PERIPH, number(b, IRQ_DIRTY));

    b.if(b.notEqual(types.number, dirty, number(b, 0)), (outer) => {
      outer.store8(PERIPH, number(outer, IRQ_DIRTY), number(outer, 0));

      outer.if(sfrBitIsSet(outer, SFR_IE, 7), (enabled) => {
        const level = enabled.load8(PERIPH, number(enabled, IRQ_LEVEL));
        const highQueue = this.queue('high');
        const lowQueue = this.queue('low');

        this.scan(enabled, level, LEVEL_HIGH, highQueue, returnPc, (next) =>
          this.scan(next, level, LEVEL_LOW, lowQueue, returnPc, () => {}),
        );
      });
    });
  }

  private queue(priority: 'high' | 'low'): readonly InterruptSource[] {
    return this.sources
      .filter((source) =>
        priority === 'high' ? source.priority !== undefined : source.priority === undefined,
      )
      .sort((left, right) => left.query - right.query);
  }

  private scan(
    b: Body,
    level: Value<number>,
    needed: number,
    queue: readonly InterruptSource[],
    returnPc: number | Value<number>,
    otherwise: (b: Body) => void,
  ): void {
    b.if(
      b.lessThan(level, number(b, needed)),
      (allowed) => this.choice(allowed, queue, 0, returnPc, otherwise),
      (next) => otherwise(asBody(next)),
    );
  }

  private choice(
    b: Body,
    queue: readonly InterruptSource[],
    index: number,
    returnPc: number | Value<number>,
    otherwise: (b: Body) => void,
  ): void {
    const source = queue[index];

    if (source === undefined) {
      otherwise(b);

      return;
    }

    const high = priorityIsHigh(b, source.priority);

    b.if(
      b.and(source.enabled(b), (inner) => source.pending(asBody(inner))),
      (taken) => this.take(taken, source, high, returnPc),
      (next) => this.choice(asBody(next), queue, index + 1, returnPc, otherwise),
    );
  }

  private take(
    b: Body,
    source: InterruptSource,
    high: Value<boolean>,
    returnPc: number | Value<number>,
  ): void {
    const level = b.load8(PERIPH, number(b, IRQ_LEVEL));
    const depth = b.load8(PERIPH, number(b, IRQ_DEPTH));
    const index = b.bitAnd(depth, number(b, IRQ_STACK_MASK));

    source.acknowledge?.(b);
    b.store8(PERIPH, b.add(number(b, IRQ_STACK), index), level);
    b.store8(
      PERIPH,
      number(b, IRQ_DEPTH),
      b.bitAnd(b.add(depth, number(b, 1)), number(b, IRQ_STACK_MASK)),
    );
    b.store8(
      PERIPH,
      number(b, IRQ_LEVEL),
      b.select(
        types.number,
        high,
        (inner) => inner.constant(types.number, LEVEL_HIGH),
        (inner) => inner.constant(types.number, LEVEL_LOW),
      ),
    );
    if (typeof returnPc === 'number') pushReturnAddress(b, returnPc);
    else pushAddressValue(b, returnPc);
    b.redirect(source.vector, 2 * machine().cyclePs);
  }
}

/** RETI：先弹回压栈的优先级，再弹回返回地址。 */
export function reti(b: Body): void {
  const depth = b.load8(PERIPH, number(b, IRQ_DEPTH));
  const index = b.bitAnd(b.subtract(depth, number(b, 1)), number(b, IRQ_STACK_MASK));

  b.store8(PERIPH, number(b, IRQ_DEPTH), index);
  b.store8(PERIPH, number(b, IRQ_LEVEL), b.load8(PERIPH, b.add(number(b, IRQ_STACK), index)));

  const high = popByte(b);
  const low = popByte(b);

  jumpToValue(b, b.bitOr(b.shiftLeft(high, number(b, 8)), low));
  markIrqDirty(b);
}
