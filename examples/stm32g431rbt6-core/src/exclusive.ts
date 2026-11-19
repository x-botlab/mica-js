import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { SCB_STATE, SYS } from './layout';
import { asBody, boolAnd, num, readByte, readWordAt, u32, writeByte, writeWordAt } from './ir';
import type { Body } from './ir';

/**
 * 单核 local exclusive monitor。
 *
 * ARMv7-M 的 LDREX/STREX 监视器是 CPU 私有的：LDREX 记录地址与宽度；只有同地址同宽度的
 * STREX 才能成功；一次 STREX 尝试后监视器失效；CLREX、异常入口、以及与监视区间重叠的
 * 普通 store 都会清除它。这里把 3 个字放在 SYS 的 0x40..0x4b（NVIC 隐藏状态从 0x90 起，
 * 0x40..0x4f 未被 SCB 偏移暴露），不新增 DDL state，也不改变 memory/bus 模型。
 * 0x4c 为 event，0x50..0x5b 为 WFI/WFE 等待标记（见 `wait.ts`）。
 *
 * 与 NVIC 的协作：`enterException` 必须调用 `clearExclusiveOnException`；该接口已导出。
 * 单核没有第二个核会偷走独占权，因此不模拟全局监视器；STREX 失败只可能来自本地监视器
 * 缺失/不匹配/被普通 store 或 CLREX 清除。
 */

const EXCLUSIVE_VALID = SCB_STATE + 0x40;
const EXCLUSIVE_ADDR = SCB_STATE + 0x44;
const EXCLUSIVE_SIZE = SCB_STATE + 0x48;

/** 预留的 CPU 私有 SYS 字；event 寄存器在 0x4c（system.ts 使用）。 */
export const CPU_HIDDEN_EVENT = SCB_STATE + 0x4c;

const load = (b: Body, offset: number): Value<number> => readWordAt(b, SYS, offset);
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, SYS, offset, value);
};
const loadValid = (b: Body): Value<number> => readByte(b, SYS, num(b, EXCLUSIVE_VALID));
const storeValid = (b: Body, value: number): void => {
  writeByte(b, SYS, num(b, EXCLUSIVE_VALID), num(b, value));
};

export function recordExclusive(b: Body, address: Value<number>, size: 1 | 2 | 4): void {
  store(b, EXCLUSIVE_ADDR, u32(b, address));
  store(b, EXCLUSIVE_SIZE, num(b, size));
  storeValid(b, 1);
}

export function clearExclusiveMonitor(b: Body): void {
  storeValid(b, 0);
}

export function exclusiveMatch(
  b: Body,
  address: Value<number>,
  size: 1 | 2 | 4,
): Value<boolean> {
  const valid = b.notEqual(types.number, loadValid(b), num(b, 0));
  const sameAddress = b.equal(types.number, load(b, EXCLUSIVE_ADDR), u32(b, address));
  const sameSize = b.equal(types.number, load(b, EXCLUSIVE_SIZE), num(b, size));

  return boolAnd(b, valid, boolAnd(b, sameAddress, sameSize));
}

/**
 * 普通 store 与监视区间重叠时清除 local monitor。ARM 的规则是地址区间重叠，不要求
 * 宽度完全相等；跨宽度覆盖同一地址也会破坏独占。
 */
export function noteGuestStore(b: Body, address: Value<number>, size: 1 | 2 | 4): void {
  const valid = b.notEqual(types.number, loadValid(b), num(b, 0));

  b.if(valid, (pending) => {
    const body = asBody(pending);
    const start = u32(body, address);
    const end = body.add(start, num(body, size));
    const exclusiveStart = load(body, EXCLUSIVE_ADDR);
    const exclusiveEnd = body.add(exclusiveStart, load(body, EXCLUSIVE_SIZE));
    const overlaps = boolAnd(
      body,
      body.lessThan(start, exclusiveEnd),
      body.lessThan(exclusiveStart, end),
    );

    body.if(overlaps, (hit) => clearExclusiveMonitor(asBody(hit)));
  });
}

/** 供 NVIC 异常入口调用的清理入口（也用于 reset 扩展）。 */
export const clearExclusiveOnException = clearExclusiveMonitor;
