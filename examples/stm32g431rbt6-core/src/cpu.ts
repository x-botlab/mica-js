import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import type { AccessSize } from './layout';
import {
  asBody,
  conditionHolds,
  num,
  readReg,
  setPc,
  signExtend,
  writeReg,
  u32,
} from './ir';
import type { Body } from './ir';
import { readMemory, writeMemory } from './memory';
import type { At } from './memory';
import { exceptionReturn, isExceptionReturn } from './nvic';
import { noteGuestStore } from './exclusive';

/** 读取通用寄存器；R15 返回当前指令地址 + 4（Thumb 约定）。 */
export const readAnyReg = (b: Body, index: number, pc: number): Value<number> =>
  index === 15 ? num(b, (pc + 4) >>> 0) : readReg(b, index);

/**
 * 写通用寄存器；写 R15 等价于跳转。
 *
 * 任何写 PC 的指令（BX、POP {pc}、LDM {pc}、LDR pc、MOV pc, ...）都可能携带
 * EXC_RETURN：异常返回规则统一由 nvic 的 exceptionReturn 维护，这里不能只 setPc，
 * 否则 `pop {pc}` 会把 0xFFFFFFF9 当成代码地址。
 */
export const writeAnyReg = (
  b: Body,
  index: number,
  value: Value<number>,
  pc?: number,
): void => {
  // `pc` 仍由调用点按统一寄存器写入协议传入；FP 上下文边界移除后写入路径不再需要它。
  void pc;
  if (index === 15) {
    b.if(
      isExceptionReturn(b, value),
      (inner) => exceptionReturn(asBody(inner), value),
      (normal) => setPc(asBody(normal), value),
    );
  } else writeReg(b, index, value);
};

/**
 * 装载一个寄存器。`defer` 只对单寄存器装载有效：命中 GPIO IDR 时由 `SERVICE_READ`
 * 组包后写回，块内不再展开逐脚采样。多寄存器装载与写 PC 必须保持内联。
 */
export function loadRegister(
  b: Body,
  target: number,
  address: Value<number>,
  size: number,
  pc: number,
  signed = false,
  at?: At,
  defer = false,
): void {
  const raw = readMemory(
    b,
    address,
    size,
    defer && target !== 15 ? { target, signed } : undefined,
    at,
  );
  const value = signed ? signExtend(b, raw, size * 8) : raw;

  writeAnyReg(b, target, value, pc);
}

export function storeRegister(
  b: Body,
  source: number,
  address: Value<number>,
  size: AccessSize,
  pc: number,
  at?: At,
  defer = false,
): void {
  // normal store 与 local exclusive monitor 的区间重叠时清除监视器。
  noteGuestStore(b, address, size);
  writeMemory(b, address, size, readAnyReg(b, source, pc), defer, at);
}

export const mul = (b: Body, left: Value<number>, right: Value<number>): Value<number> =>
  b.multiply(left, right);

export const align4 = (value: number): number => value & ~3;

/** 静态条件执行：条件成立时执行分支体。 */
export const conditional = (b: Body, condition: number, emit: (body: Body) => void): void => {
  if (condition >= 14) {
    emit(b);

    return;
  }

  b.if(conditionHolds(b, condition), (inner) => emit(asBody(inner)));
};

/**
 * 动态条件（IT 块）：把条件号映射为当前标志的组合。
 *
 * 条件在 `guard` 顶层通过 `conditionHolds` 生成，再组合成 select 链；不要把
 * `conditionValue` 放进嵌套 builder/if 回调，否则 APSR 读取会丢失外部状态。
 * `cond = 14/15`（AL/NV）由默认 true 覆盖。
 */
export function conditionValue(b: Body, condition: Value<number>): Value<boolean> {
  let selected = b.constant(types.bool, true);

  // 逐条件比较。动态 IT 条件的 bit 展开在嵌套 select 里容易丢状态；这里每个
  // 条件分支都用顶层 conditionHolds 生成，最后只组合 select，避免嵌套 builder。
  for (let code = 13; code >= 0; code -= 1) {
    const holds = conditionHolds(b, code);

    selected = b.select(
      types.bool,
      b.equal(types.number, condition, num(b, code)),
      () => holds,
      () => selected,
    );
  }

  return selected;
}

/** 32 位值的二进制补码取负。 */
export const negate = (b: Body, value: Value<number>): Value<number> =>
  u32(b, b.subtract(num(b, 0), value));
