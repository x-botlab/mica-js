import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { ANALOG, gpioModerState } from './layout';
import { bitField, asBody, num, readWord, readWordAt, u32, writeWordAt } from './ir';
import type { Body } from './ir';

/**
 * STM32G4 模拟外设共用的寄存器文件访问与模型状态分区。
 *
 * ADC1/2、DAC1、COMP1–4 与 OPAMP1–3 的固件可见寄存器都放在 DDL 的 `analog`
 * memory 中。`analog.ts` 分配固定的状态基址，各模拟外设模块只按自己的偏移读写；
 * 中央 `peripherals.ts` 把模块挂到 `PeripheralModule` 上，不再把寄存器挤进
 * `periph` 的后备区。
 *
 * 位宽语义与总线一致：字访问忽略地址低两位，半字/字节访问按地址低两位放入或
 * 截取目标字。静态偏移与运行期偏移共用同一套掩码/拼接实现。
 */

/** 每个 ADC 实例占 0x100 字节：0x00–0xC4 为寄存器映像，0xE0–0xFF 为内部相位。 */
export const ADC_STATE_BASE = 0x000;
export const ADC_STATE_STRIDE = 0x100;
/** ADC12_COMMON 的寄存器映像。 */
export const ADC_COMMON_STATE = 0x200;
/** DAC1 的寄存器映像；0x240–0x2FF 保留给 DAC。 */
export const DAC_STATE = 0x240;
/** COMP1–COMP4 每个 4 字节 CSR。 */
export const COMP_STATE = 0x300;
/** OPAMP1–OPAMP3 每个 4 字节 CSR。 */
export const OPAMP_STATE = 0x310;
/** 模拟状态区结束（不含）；由 `ANALOG_SIZE` 保证。 */
export const ANALOG_STATE_END = 0x340;

/** 读取常量偏移的模型状态字。 */
export const loadStateAt = (b: Body, base: number, offset: number): Value<number> =>
  readWordAt(b, ANALOG, base + offset);

/** 读取运行期偏移的模型状态字。 */
export const loadState = (b: Body, base: number, offset: Value<number>): Value<number> =>
  readWord(b, ANALOG, b.add(num(b, base), offset));

/** 写入常量偏移的模型状态字。 */
export const storeStateAt = (b: Body, base: number, offset: number, value: Value<number>): void => {
  writeWordAt(b, ANALOG, base + offset, value);
};

/** 静态偏移的字内窄访问截取；偏移在翻译期已知。 */
export function extractAt(
  b: Body,
  word: Value<number>,
  offset: number,
  size: number,
): Value<number> {
  if (size === 4) return word;
  const shift = (offset & 3) * 8;
  const shifted = shift === 0 ? word : b.shiftRightUnsigned(word, num(b, shift));

  return b.bitAnd(shifted, num(b, size === 2 ? 0xffff : 0xff));
}

/** 运行期偏移的字内窄访问截取；与 `extractAt` 语义相同。 */
export function extract(
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
}

/** 编译期把一个窄写入放到目标字中的位置。 */
export function placeStaticConstant(value: number, offset: number, size: number): number {
  if (size === 4) return value >>> 0;
  const width = size === 2 ? 0xffff : 0xff;
  const shift = (size === 2 ? offset & 2 : offset & 3) * 8;

  return ((value & width) << shift) >>> 0;
}

/** 运行期宽度/偏移的窄写放置；`size` 为编译期常量。 */
export function place(b: Body, value: Value<number>, offset: Value<number>, size: number): Value<number> {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
}

/** 把窄写入合并进当前字；偏移为运行期值。 */
export function merge(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}

/** 常量偏移的寄存器读；字偏移在翻译期截断到 1 KiB。 */
export function readRegisterAt(
  b: Body,
  base: number,
  offset: number,
  size: number,
): Value<number> {
  const wordOffset = offset & 0x3fc;

  return extractAt(b, loadStateAt(b, base, wordOffset), offset, size);
}

/** 运行期偏移的寄存器读；偏移在运行期截断到 1 KiB。 */
export function readRegister(
  b: Body,
  base: number,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  return extract(b, loadState(b, base, wordOffset), offset, size);
}

/** 常量偏移的寄存器写：按访问宽度合并。 */
export function writeRegisterAt(
  b: Body,
  base: number,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = offset & 0x3fc;
  const current = loadStateAt(b, base, wordOffset);

  storeStateAt(b, base, wordOffset, merge(b, current, value, num(b, offset), size));
}

/** 运行期偏移的寄存器写：与 `writeRegisterAt` 语义相同。 */
export function writeRegister(
  b: Body,
  base: number,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const current = loadState(b, base, wordOffset);

  // 写入目标在运行期才确定；直接存到 `analog + base + wordOffset`，与静态路径
  // 的 `writeRegisterAt` 共用同一套 merge 语义。
  b.store32le(
    ANALOG,
    b.add(num(b, base), wordOffset),
    merge(b, current, value, offset, size),
  );
}

/** 读取引脚采样的可选电压字段：浮空时返回 null，调用方自行决定是否可用。 */
export const optionalVoltage = (b: Body, pin: string): Value<number | null> =>
  b.field(b.readSample(pin), 'voltage');

/** 采样是否有效（status=valid 且 voltage 非空）。 */
export function sampleValid(b: Body, pin: string): Value<boolean> {
  const sample = b.readSample(pin);
  const status = b.field(sample, 'status');
  const voltage = b.field(sample, 'voltage');

  return b.select(
    types.bool,
    b.equal(
      types.sampleStatus,
      status,
      b.constant(types.sampleStatus, types.sampleStatus.members.valid),
    ),
    (valid) => valid.not(valid.isNone(voltage)),
    (invalid) => invalid.constant(types.bool, false),
  );
}

/** 采样电压；浮空时返回 0，并应同时用 `sampleValid` 判断可用性。 */
export function sampleVoltageOrZero(b: Body, pin: string): Value<number> {
  const voltage = optionalVoltage(b, pin);

  return b.select(
    types.number,
    b.isNone(voltage),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(voltage),
  );
}

/** 模拟输出的固定 Thevenin 输出电阻（Ω）。端点用 OPEN_RESISTANCE 近似开路。 */
export const ANALOG_OUTPUT_RESISTANCE = 10_000;
/** 比例 0/1 时另一个支路应为开路；引擎上限 1 GΩ 有限值近似。 */
export const ANALOG_OPEN_RESISTANCE = 1_000_000_000;

/** 一个引脚当前 GPIO MODER 的 2 位模式。 */
export function analogPinMode(b: Body, port: number, bit: number): Value<number> {
  return bitField(b, b.readState(gpioModerState(port), types.number), bit * 2, 2);
}

/**
 * 用 VREFP/VSS 两只正电阻表达一个有限输出电阻的模拟电压源：
 * `Rout = 10 kΩ`，`Rtop = Rout / (1 - ratio)`、`Rbottom = Rout / ratio`，
 * 其中 `ratio = clamp(voltage / reference, 0, 1)`。端点 0/1 的另一支路用 1 GΩ
 * 近似开路（引擎电阻上限），因此端点 Rout 误差约 1e-5 相对量级。
 *
 * 只有 GPIO MODER=11（模拟）时才驱动/释放引脚：避免 DAC/OPAMP 在错误引脚模式下
 * 抢走 GPIO 输出。关闭时也只对仍处于模拟模式的引脚写空意图，不触碰其它 GPIO。
 */
export function driveAnalogVoltage(
  b: Body,
  pin: string,
  port: number,
  bit: number,
  voltage: Value<number>,
  reference: Value<number>,
  enabled: Value<boolean>,
): void {
  const analogMode = b.equal(types.number, analogPinMode(b, port, bit), num(b, 3));
  const usableReference = b.max(reference, num(b, 1e-9));
  const ratio = b.min(
    b.max(b.divide(voltage, usableReference), num(b, 0)),
    num(b, 1),
  );
  // Rtop = Rout / ratio（ratio→0 时开路），Rbottom = Rout / (1-ratio)
  // （ratio→1 时开路）；并联电阻恒为 Rout。
  const top = b.select(
    types.number,
    b.lessThanOrEqual(ratio, num(b, 0)),
    (open) => open.constant(types.number, ANALOG_OPEN_RESISTANCE),
    (finite) =>
      finite.divide(
        finite.constant(types.number, ANALOG_OUTPUT_RESISTANCE),
        ratio,
      ),
  );
  const bottom = b.select(
    types.number,
    b.greaterThanOrEqual(ratio, num(b, 1)),
    (open) => open.constant(types.number, ANALOG_OPEN_RESISTANCE),
    (finite) =>
      finite.divide(
        finite.constant(types.number, ANALOG_OUTPUT_RESISTANCE),
        finite.subtract(finite.constant(types.number, 1), ratio),
      ),
  );

  b.if(
    enabled,
    (on) => {
      const body = asBody(on);

      body.if(analogMode, (drive) => {
        const scope = asBody(drive);

        scope.writeIntent(
          pin,
          scope.combineIntents(
            scope.resistor('VREFP', top),
            scope.resistor('VSS1', bottom),
          ),
        );
      });
    },
    (off) => {
      const body = asBody(off);

      body.if(analogMode, (release) => {
        asBody(release).writeIntent(pin, asBody(release).combineIntents());
      });
    },
  );
}
