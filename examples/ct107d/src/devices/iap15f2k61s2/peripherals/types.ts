import type { Value } from '@mica-js/sdk/model';
import type { Body } from '../kernel/ir';
import type { InterruptSource } from '../kernel/interrupt';

/**
 * 外设模块合同。
 *
 * 每个外设只在翻译期生成 IR：`advance` 在每个指令边界被调用，`onWrite` 在 SFR 锁存器
 * 更新后观察控制位。模块不持有实例状态，全部运行期状态放在 `periph` 存储器或 SFR 里。
 */

export interface Peripheral {
  /** 诊断与测试用的稳定名称。 */
  readonly id: string;
  /** 本外设观察的 SFR 地址（写入后回调 `onWrite`）。 */
  readonly writes?: readonly number[];
  /** 本外设改写的 SFR 读取地址（回调 `onRead`）。 */
  readonly reads?: readonly number[];
  onWrite?(b: Body, address: number, value: Value<number>): void;
  onRead?(b: Body, address: number): Value<number>;
  /** 每个节拍按经过的仿真时间推进一次。 */
  advance(b: Body, advance: Advance): void;
  /**
   * 该外设当前是否可能在无人写入的情况下自行变化（计数、移位、超时、边沿）。
   *
   * 节拍用这些条件合成一个字节门控：全部为假时指令块只读一个字节就跳过推进服务，
   * 因此条件必须是寄存器位或内部标志，不能采样引脚。省略表示该外设没有时间行为。
   */
  active?(b: Body): Value<boolean>;
  /** 本外设声明给中断控制器的中断源。 */
  readonly interrupts?: readonly InterruptSource[];
}

/** 一次节拍推进共享的换算结果：皮秒、系统时钟数与 IAP 计时单位。 */
export interface Advance {
  readonly elapsedPs: Value<number>;
  readonly cycles: Value<number>;
  readonly ticks: Value<number>;
}

/** 器件的系统时钟：`cyclePs` 是一个系统时钟周期的整数皮秒数。 */
export interface Clock {
  readonly frequency: number;
  readonly cyclePs: number;
}

export type PeripheralFactory = (clock: Clock) => Peripheral;
