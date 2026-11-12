import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { SFR } from './ir';
import type { Body } from './ir';

/**
 * SFR 访问钩子。
 *
 * 所有直接/位寻址写入都要经过这里，外设因此能在锁存器更新后观察控制位变化；
 * 读取钩子用于「读引脚而非锁存器」这类必须改写取值来源的地址。
 */

export type SfrReadHook = (b: Body, address: number) => Value<number>;
export type SfrWriteHook = (b: Body, address: number, value: Value<number>) => void;

export class SfrHooks {
  private readonly readers = new Map<number, SfrReadHook>();
  private readonly writers = new Map<number, SfrWriteHook[]>();
  /**
   * 读之前的同步钩子：外设状态（计数、标志、移位）随时间变化，固件读到这些 SFR 之前
   * 必须先把累积的时间交给外设，否则会读到最多一个节拍的旧值。
   */
  synchronize?: (b: Body, address: number) => void;
  private suppress = 0;

  /**
   * 在该回调里生成的 IR 不触发读之前的同步。
   *
   * 推进代码与中断扫描自己会读控制寄存器；如果这些读也触发同步，会递归展开出巨大的块。
   */
  muted<T>(run: () => T): T {
    this.suppress += 1;

    try {
      return run();
    } finally {
      this.suppress -= 1;
    }
  }

  onRead(address: number, hook: SfrReadHook): void {
    if (this.readers.has(address))
      throw new Error(`iap15f2k61s2: SFR 读钩子重复 ${address.toString(16)}`);

    this.readers.set(address, hook);
  }

  onWrite(address: number, hook: SfrWriteHook): void {
    const list = this.writers.get(address);

    if (list === undefined) this.writers.set(address, [hook]);
    else list.push(hook);
  }

  read(b: Body, address: number): Value<number> {
    if (!this.suppress) this.synchronize?.(b, address);

    const hook = this.readers.get(address);

    return hook === undefined
      ? b.load8(SFR, b.constant(types.number, address & 0x7f))
      : hook(b, address);
  }

  write(b: Body, address: number, value: Value<number>): void {
    const stored = b.bitAnd(value, b.constant(types.number, 0xff));

    b.store8(SFR, b.constant(types.number, address & 0x7f), stored);

    const hooks = this.writers.get(address);

    if (hooks === undefined) return;

    // 写入钩子是外设自己的逻辑：它们按「写入那一刻」的状态工作，不需要也不会在钩子里
    // 再插一段推进（那会让每个 SFR 写块都内联整段推进代码）。
    this.suppress += 1;

    try {
      for (const hook of hooks) hook(b, address, stored);
    } finally {
      this.suppress -= 1;
    }
  }
}
