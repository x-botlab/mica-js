import type { Value } from '@mica-js/sdk/model';
import type { Body } from './ir';
import type { SfrHooks } from './sfr-hooks';
import type { InterruptController } from './interrupt';
import type { Peripheral } from '../peripherals/types';

/**
 * 一个器件实例的翻译上下文。
 *
 * `translate` 是同步回调，翻译期间只有当前实例在生成 IR；内核与外设模块因此通过这个
 * 活动上下文取得时钟常量与 SFR 钩子，而不把实例状态放进模块级变量。
 */

export interface PortAccess {
  /** 直读 Px：返回 8 根引脚的当前电平。 */
  readPort(b: Body, port: number): Value<number>;
  /** 位测试：只采样目标脚，返回 0/1。 */
  readPin(b: Body, port: number, bit: number): Value<number>;
}

export interface Machine {
  /** 系统时钟频率（Hz）。 */
  readonly clockFrequency: number;
  /** 一个系统时钟周期的整数皮秒数。 */
  readonly cyclePs: number;
  /** JIT 绑定的 PC state 名：节拍服务块要保存与恢复它。 */
  readonly pcState: string;
  readonly sfr: SfrHooks;
  readonly irq: InterruptController;
  readonly peripherals: readonly Peripheral[];
  readonly ports: PortAccess;
  /** 读取前必须把时间账本结算到当前时刻的 SFR 地址（来自 `SYNC_ON_READ`）。 */
  readonly timedReads: ReadonlySet<number>;
  /** 写入会改变时间语义的 SFR 地址（外设 writes 与中断允许/优先级）。 */
  readonly timedWrites: ReadonlySet<number>;
  /**
   * 翻译期 SFR 访问探针。
   *
   * 指令体先生成到一次性的 probe 里，由 `readSfr`/`readSfrLatch`/`writeSfr`
   * 在翻译期记录真实访问到的地址；翻译器据此决定是否在指令体前插入统一结算，
   * 不再维护第二份 opcode/寻址分类表。外设钩子内部的读取（复用驱动读控制位、
   * PCA 读 CL 等）不是这条指令的架构访问，由 `SfrHooks.withinHook` 排除。
   * 探针只在 `beginAccessProbe` 到 `endAccessProbe` 之间生效。
   */
  beginAccessProbe(): void;
  endAccessProbe(): { readonly reads: ReadonlySet<number>; readonly writes: ReadonlySet<number> };
  noteSfrRead(address: number): void;
  noteSfrWrite(address: number): void;
}

let active: Machine | undefined;

export function activateMachine<T>(machine: Machine, run: () => T): T {
  const previous = active;

  active = machine;

  try {
    return run();
  } finally {
    active = previous;
  }
}

export function machine(): Machine {
  if (active === undefined) throw new Error('iap15f2k61s2: 在 translate 之外访问器件翻译上下文');

  return active;
}
