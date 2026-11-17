import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { ADC_VREFINT_NOMINAL } from './adc-layout';
import {
  COMP_STATE,
  extract,
  extractAt,
  loadStateAt,
  merge,
  readRegister,
  readRegisterAt,
  writeRegisterAt,
} from './analog';
import { asBody, bool, boolAnd, boolBitAt, num, u32 } from './ir';
import type { Body } from './ir';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431RBT6 COMP1–COMP4 的基础寄存器/比较器模型。
 *
 * 每个 COMP 只有一个 CSR（4 字节，基址 0x4001_0200 + 4×index）。模型支持 EN、
 * INMSEL、INPSEL、POLARITY、HYST 保存、VALUE 只读位；BLANKING/BRGEN/SCALEN/LOCK
 * 只保存。VALUE 在读取 CSR 时按当前引脚采样与 VREFINT 分压实时计算。
 *
 * 已核对的可选输入（DS12589 pin table）：
 * - COMP1: INM0=PA0 / INM1=PA4；INP0=PA1 / INP1=PB1；
 * - COMP2: INM0=PA2 / INM1=PA5；INP0=PA3 / INP1=PA7；
 * - COMP3: INP0=PA0；外部 INM 未在 G431 封装上核对到，按无数据处理；
 * - COMP4: INM0=PB2；INP0=PB0。
 *
 * INMSEL=0..3 使用 VREFINT 的 1/4、1/2、3/4、1 倍；4..7（DAC 输出）与 8..15
 * 的外部负输入只有表中列出的通道可用。未支持的选择返回 VALUE=0，不伪造比较结果。
 * 迟滞、消隐、输出引脚路由与中断未建模。
 */

export const COMP1_BASE = 0x40010200;
export const COMP_COUNT = 4;
const COMP_CSR = 0x00;

const COMP_CSR_EN = 1 << 0;
const COMP_CSR_INMSEL_SHIFT = 4;
const COMP_CSR_INMSEL_MASK = 0xf << COMP_CSR_INMSEL_SHIFT;
const COMP_CSR_INPSEL = 1 << 8;
const COMP_CSR_POLARITY = 1 << 15;
const COMP_CSR_VALUE = 1 << 30;
const COMP_CSR_LOCK = 1 << 31;

interface ComparatorConfig {
  readonly index: 1 | 2 | 3 | 4;
  readonly inputMinus: readonly (string | undefined)[];
  readonly inputPlus: readonly (string | undefined)[];
}

const COMPARATORS: readonly ComparatorConfig[] = [
  // INMSEL=110 → IO1，111 → IO2；INPSEL=0 → INP0，1 → INP1（RM0440 Table 195/196）。
  { index: 1, inputMinus: ['PA4', 'PA0'], inputPlus: ['PA1', 'PB1'] },
  { index: 2, inputMinus: ['PA5', 'PA2'], inputPlus: ['PA7', 'PA3'] },
  { index: 3, inputMinus: ['PF1', 'PC0'], inputPlus: ['PA0', 'PC1'] },
  { index: 4, inputMinus: [undefined, 'PB2'], inputPlus: ['PB0', undefined] },
];

const load = (b: Body, index: number): Value<number> =>
  loadStateAt(b, COMP_STATE, index * 4);

const store = (b: Body, index: number, value: Value<number>): void => {
  writeRegisterAt(b, COMP_STATE, index * 4, 4, value);
};

interface AnalogValue {
  readonly valid: Value<boolean>;
  readonly voltage: Value<number>;
}

function pinVoltage(b: Body, pin: string | undefined): AnalogValue {
  if (pin === undefined)
    return { valid: bool(b, false), voltage: num(b, 0) };

  const sample = b.local(types.sample, b.readSample(pin));
  const status = b.field(b.getLocal(sample), 'status');
  const optional = b.field(b.getLocal(sample), 'voltage');
  const statusValid = b.equal(
    types.sampleStatus,
    status,
    b.constant(types.sampleStatus, types.sampleStatus.members.valid),
  );
  const valid = b.select(
    types.bool,
    statusValid,
    (inner) => inner.not(inner.isNone(optional)),
    (inner) => inner.constant(types.bool, false),
  );
  const voltage = b.select(
    types.number,
    b.isNone(optional),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(optional),
  );

  return { valid, voltage };
}

function comparatorOutput(b: Body, config: ComparatorConfig, csr: Value<number>): Value<boolean> {
  const enabled = boolBitAt(b, csr, 0);
  const inmsel = b.bitAnd(
    b.shiftRightUnsigned(csr, num(b, COMP_CSR_INMSEL_SHIFT)),
    num(b, 0xf),
  );
  const inpsel = boolBitAt(b, csr, 8);
  const polarity = boolBitAt(b, csr, 15);
  const minus = b.local(types.number, num(b, 0));
  const minusValid = b.local(types.bool, false);

  // INMSEL 0..3：VREFINT × 1/4、1/2、3/4、1。4..7 为 DAC 输出，未建模。
  for (let selection = 0; selection < 4; selection += 1)
    b.if(b.equal(types.number, inmsel, num(b, selection)), (inner) => {
      const body = asBody(inner);

      body.setLocal(
        minus,
        body.multiply(
          body.constant(types.number, ADC_VREFINT_NOMINAL),
          body.constant(types.number, (selection + 1) / 4),
        ),
      );
      body.setLocal(minusValid, bool(body, true));
    });

  // INMSEL=110/111 的外部负输入：IO1 / IO2。
  for (let offset = 0; offset < config.inputMinus.length; offset += 1) {
    const pin = config.inputMinus[offset];

    if (pin === undefined) continue;
    b.if(b.equal(types.number, inmsel, num(b, 6 + offset)), (inner) => {
      const body = asBody(inner);
      const sampled = pinVoltage(body, pin);

      body.setLocal(minus, sampled.voltage);
      body.setLocal(minusValid, sampled.valid);
    });
  }

  const plus = b.local(types.number, num(b, 0));
  const plusValid = b.local(types.bool, false);

  for (let selection = 0; selection < config.inputPlus.length; selection += 1) {
    const pin = config.inputPlus[selection];

    if (pin === undefined) continue;
    b.if(
      b.equal(types.bool, inpsel, b.constant(types.bool, selection === 1)),
      (inner) => {
        const body = asBody(inner);
        const sampled = pinVoltage(body, pin);

        body.setLocal(plus, sampled.voltage);
        body.setLocal(plusValid, sampled.valid);
      },
    );
  }

  const compare = b.greaterThan(
    b.subtract(b.getLocal(plus), b.getLocal(minus)),
    num(b, 0),
  );
  const result = b.select(
    types.bool,
    polarity,
    (inner) => inner.not(compare),
    () => compare,
  );

  return b.select(
    types.bool,
    boolAnd(b, enabled, boolAnd(b, b.getLocal(plusValid), b.getLocal(minusValid))),
    () => result,
    (inner) => inner.constant(types.bool, false),
  );
}

function csrValue(b: Body, config: ComparatorConfig, stored: Value<number>): Value<number> {
  const output = comparatorOutput(b, config, stored);

  return b.bitOr(
    b.bitAnd(stored, num(b, ~COMP_CSR_VALUE)),
    b.select(
      types.number,
      output,
      (inner) => inner.constant(types.number, COMP_CSR_VALUE),
      (inner) => inner.constant(types.number, 0),
    ),
  );
}

export function readComparatorAt(
  b: Body,
  index: number,
  offset: number,
  size: number,
): Value<number> {
  if ((offset & 0xfc) !== COMP_CSR) return num(b, 0);
  const config = COMPARATORS[index];

  if (config === undefined) return num(b, 0);

  return extractAt(b, csrValue(b, config, load(b, index)), offset, size);
}

export function writeComparatorAt(
  b: Body,
  index: number,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  if ((offset & 0xfc) !== COMP_CSR) return;

  const current = load(b, index);
  const merged = merge(b, current, value, num(b, offset), size);
  const locked = boolBitAt(b, current, 31);

  // LOCK 置位后配置字段不可再改；VALUE 是只读输出。
  b.if(locked, () => {}, (writable) => {
    store(asBody(writable), index, asBody(writable).bitAnd(merged, num(asBody(writable), ~COMP_CSR_VALUE)));
  });
}

export function readComparator(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  const index = b.shiftRightUnsigned(b.subtract(address, num(b, COMP1_BASE)), num(b, 2));
  const result = b.local(types.number, 0);

  for (let each = 0; each < COMPARATORS.length; each += 1)
    b.if(b.equal(types.number, index, num(b, each)), (inner) => {
      const body = asBody(inner);

      body.setLocal(result, csrValue(body, COMPARATORS[each]!, load(body, each)));
    });

  return extract(b, b.getLocal(result), b.bitAnd(address, num(b, 3)), size);
}

export function writeComparator(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const index = b.shiftRightUnsigned(b.subtract(address, num(b, COMP1_BASE)), num(b, 2));

  for (let each = 0; each < COMPARATORS.length; each += 1)
    b.if(b.equal(types.number, index, num(b, each)), (inner) => {
      const body = asBody(inner);
      const current = load(body, each);
      const merged = merge(body, current, value, body.bitAnd(address, num(body, 3)), size);

      body.if(boolBitAt(body, current, 31), () => {}, (writable) => {
        const scope = asBody(writable);

        store(scope, each, scope.bitAnd(merged, num(scope, ~COMP_CSR_VALUE)));
      });
    });
}

/** 中央注册项：COMP 无时间行为。输出引脚路由/中断未建模。 */
export function createComparatorModule(): PeripheralModule {
  return {
    id: 'comp',
    ranges: [{ base: COMP1_BASE, size: COMP_COUNT * 4 }],
    read: readComparator,
    write: writeComparator,
  };
}

export { COMP_CSR, COMP_CSR_EN, COMP_CSR_VALUE, COMP_CSR_LOCK, COMPARATORS };
