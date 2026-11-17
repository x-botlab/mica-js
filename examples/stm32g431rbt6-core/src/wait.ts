import { types } from '@mica-js/sdk/model';
import type { JitPolling } from '@mica-js/sdk/device';
import type { Value } from '@mica-js/sdk/model';
import { SCB_STATE, SYS } from './layout';
import { asBody, num, readWordAt, writeWordAt } from './ir';
import type { Body } from './ir';

/**
 * WFI/WFE 的 JIT polling 合同（CPU 侧）。
 *
 * 不新增调度器：复用 index.ts 已有的 `attachJit.polling` 与 `SERVICE_TICK`。这里只
 * 提供“等待标记”和扫描器，真正的唤醒判定仍由 NVIC 的 `dispatchExceptions` 完成：
 *
 * - WFI/WFE 把等待状态写入 `sys` 隐藏区（wait active/pc/next），PC 停在等待指令；
 * - polling `advance` 只推进时间并转到 SERVICE_TICK，`SERVICE_RESUME` 保持等待 PC；
 * - SERVICE_TICK/SERVICE_DISPATCH 调用 `dispatchExceptions` 时通过
 *   `waitExceptionReturnPc` 传入 nextPC：没有真实异常时服务尾回到等待 PC，有异常时
 *   异常栈返回地址才是 nextPC；
 * - `irqDirty` 只表示“需要扫描”，WFI/WFE 执行后仍要由 DISPATCH 决定是否真正唤醒，
 *   因此定时外设推进但无 IRQ 时不会落 nextPC；
 * - WFE event 仍在 WFE 指令执行时消费。
 *
 * DDL 端需要以下同名函数（见 /tmp/opencode/g431-cpu-wait-contract.md）：
 * - pure fn cpuWfiPoll() -> bool
 * - pure fn cpuWfePoll() -> bool
 * - pure fn cpuWaitWaitPs() -> number
 * - fn cpuWaitAdvance(elapsedPs)
 */
export const CPU_WFI_POLL = 'cpuWfiPoll';
export const CPU_WFE_POLL = 'cpuWfePoll';
export const CPU_WAIT_WAIT_PS = 'cpuWaitWaitPs';
export const CPU_WAIT_ADVANCE = 'cpuWaitAdvance';

/** CPU 私有等待标记；与 exclusive 0x140..0x14b、event 0x14c 分开。 */
export const WAIT_ACTIVE = SCB_STATE + 0x50;
export const WAIT_PC = SCB_STATE + 0x54;
export const WAIT_NEXT = SCB_STATE + 0x58;

const loadWait = (b: Body, offset: number): Value<number> => readWordAt(b, SYS, offset);
const storeWait = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYS, offset, value);
};

/** 进入等待：记录等待指令 PC 与异常返回应使用的 nextPC。 */
export function beginWait(b: Body, pc: number, nextPc: number): void {
  storeWait(b, WAIT_ACTIVE, num(b, 1));
  storeWait(b, WAIT_PC, num(b, pc));
  storeWait(b, WAIT_NEXT, num(b, nextPc));
}

/** 清等待标记；异常入口和 WFE event 唤醒都会调用。 */
export function clearWait(b: Body): void {
  storeWait(b, WAIT_ACTIVE, num(b, 0));
}

export function waitActive(b: Body): Value<boolean> {
  return b.notEqual(types.number, loadWait(b, WAIT_ACTIVE), num(b, 0));
}

/**
 * `dispatchExceptions` 的返回地址：等待中必须用 WFI/WFE 的 nextPC。
 * 没有真实异常时该值不会被使用，服务尾仍回到 `SERVICE_RESUME`（等待 PC）。
 */
export function waitExceptionReturnPc(b: Body, fallback: Value<number>): Value<number> {
  return b.select(
    types.number,
    waitActive(b),
    (active) => loadWait(asBody(active), WAIT_NEXT),
    () => fallback,
  );
}

/** 扫描器只需要长度与数字索引；Uint8Array/DDL code memory 都满足。 */
export interface CodeImage {
  readonly length: number;
  readonly [index: number]: number | undefined;
}

const halfAt = (code: CodeImage, offset: number): number =>
  (code[offset & 0x1ffff] ?? 0) | ((code[(offset + 1) & 0x1ffff] ?? 0) << 8);

const sizeAt = (code: CodeImage, offset: number): number =>
  halfAt(code, offset) >= 0xe800 ? 4 : 2;

const itCountOf = (mask: number): number => {
  let count = 1;

  while (count < 4 && ((mask << count) & 0xf) !== 0) count += 1;
  return count;
};

/** `pc` 是否落在某个 IT 块内；IT 内 WFI 不能由 PC polling 提前停住。 */
function insideIt(code: CodeImage, pc: number): boolean {
  for (let back = 2; back <= 18; back += 2) {
    const start = (pc - back) >>> 0;
    const h1 = halfAt(code, start);

    if ((h1 & 0xff00) !== 0xbf00) continue;
    const mask = h1 & 0xf;

    if (mask === 0 || ((h1 >> 4) & 0xf) === 0xf) continue;
    const count = itCountOf(mask);
    let cursor = (start + 2) >>> 0;

    for (let index = 0; index < count; index += 1) {
      if (cursor === pc) return true;
      if (cursor > pc) break;
      cursor = (cursor + sizeAt(code, cursor)) >>> 0;
    }
  }

  return false;
}

/**
 * 扫描 Flash 中的 WFI(0xBF30)/WFE(0xBF20)，为每个逻辑 PC（Flash 基址与 0 别名）
 * 生成 polling 声明。IT 块内的 WFI/WFE 跳过，避免条件不成立时提前 park。
 */
export function cpuWaitPolling(
  code: CodeImage,
  firmwareLength: number,
  bases: readonly number[],
): JitPolling[] {
  const length = Math.min(firmwareLength, code.length);
  const pcs: { readonly pc: number; readonly wfe: boolean }[] = [];

  for (let offset = 0; offset + 2 <= length; offset += 2) {
    const half = halfAt(code, offset);

    if (half !== 0xbf30 && half !== 0xbf20) continue;
    if (insideIt(code, offset)) continue;
    for (const base of bases) pcs.push({ pc: (base + offset) >>> 0, wfe: half === 0xbf20 });
  }

  return pcs.map(({ pc, wfe }) => ({
    pc,
    predicate: wfe ? CPU_WFE_POLL : CPU_WFI_POLL,
    wait: { delay: CPU_WAIT_WAIT_PS, advance: CPU_WAIT_ADVANCE },
  }));
}
