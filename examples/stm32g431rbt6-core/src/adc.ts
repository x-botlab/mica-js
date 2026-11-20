import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { ANALOG, IRQ_DIRTY, SERVICE_IRQ, PeripheralSlot, gpioModerState } from './layout';
import {
  ADC12_COMMON_BASE,
  ADC12_IRQ,
  ADC1_BASE,
  ADC2_BASE,
  ADC_CCR,
  ADC_CCR_CKMODE_SHIFT,
  ADC_CCR_VBATSEL,
  ADC_CCR_VREFEN,
  ADC_CDR,
  ADC_CFGR,
  ADC_CFGR2,
  ADC_CFGR_ALIGN,
  ADC_CFGR_CONT,
  ADC_CFGR_OVRMOD,
  ADC_CFGR_RES_SHIFT,
  ADC_CR,
  ADC_CR_ADCAL,
  ADC_CR_ADCALDIF,
  ADC_CR_ACTION_MASK,
  ADC_CR_ADDIS,
  ADC_CR_ADEN,
  ADC_CR_ADSTP,
  ADC_CR_JADSTP,
  ADC_CR_ADSTART,
  ADC_CR_JADSTART,
  ADC_CR_ADVREGEN,
  ADC_CR_DEEPPWD,
  ADC_CSR,
  ADC_CALFACT,
  ADC_DIFSEL,
  ADC_DR,
  ADC_IER,
  ADC_IER_MASK,
  ADC_ISR,
  ADC_ISR_ADRDY,
  ADC_ISR_EOC,
  ADC_ISR_EOS,
  ADC_ISR_EOSMP,
  ADC_ISR_MASK,
  ADC_ISR_OVR,
  ADC_JDR1,
  ADC_JDR4,
  ADC_JSQR,
  ADC_LAST_REGISTER,
  ADC_MIN_REFERENCE,
  ADC_MIN_VDDA,
  ADC_PRESCALER,
  ADC_SAMPLE_CYCLES,
  ADC_SAR_CYCLES,
  ADC_SMPR1,
  ADC_SMPR2,
  ADC_SQR1,
  ADC_SQR2,
  ADC_SQR3,
  ADC_SQR4,
  ADC_VBAT_DIVIDER,
  ADC_VREFINT_NOMINAL,
  ADC_CHANNEL_PINS,
  ADC_FULL_SCALE,
  ADC_RESOLUTION_BITS,
} from './adc-layout';
import type { AdcPin } from './adc-layout';
import {
  ADC_COMMON_STATE,
  ADC_STATE_BASE,
  ADC_STATE_STRIDE,
  extractAt,
  extract,
  loadStateAt,
  merge,
  place,
  readRegister,
  readRegisterAt,
  writeRegister,
  writeRegisterAt,
} from './analog';
import {
  asBody,
  bool,
  boolAnd,
  boolBit,
  boolBitAt,
  boolOr,
  bitField,
  markService,
  num,
  u32,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import { refreshTick } from './tick';
import {
  setPeripheralActive,
  setPeripheralDeadline,
} from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431RBT6 ADC1/ADC2 的规则组模型。
 *
 * 固件可见的寄存器是真实映射（ISR/IER/CR/CFGR/CFGR2/SMPR/TR/SQR/DR/JSQR/OFR/
 * JDR/AWD/DIFSEL/CALFACT/GCOMP），每个实例 0x100 字节、公共区 0x300 起。寄存器映像
 * 存在 DDL 的 `analog` memory，内部相位（64 位剩余时间、当前 rank、忙标志）在
 * 每个实例 0xE0–0xF0，不会暴露给固件（保留区读回 0/写忽略）。
 *
 * 已实现：
 * - 深度掉电/稳压器/ADEN/ADRDY、ADDIS、ADCAL（校准瞬间完成并保留 CALFACT）、
 *   ADSTART/ADSTP；
 * - 12/10/8/6 位分辨率、左右对齐、单次/连续、扫描序列 1–16 rank；
 * - 保留寄存器读 0/写忽略，IER/CR 保留位屏蔽，partial byte/half 访问按真实掩码；
 * - 理想 N 位量化 `floor(Vin/Vref × 2^N)`（钳制 0..2^N-1），EOC/EOS/EOSMP/OVR；
 *   OVRMOD 只控制 DR 保留/覆盖，OVR 在 EOC 未读时总会置位；DR 高位保留字节读不清 EOC；
 * - 软件触发转换的有限时间语义：时长为 `(采样时钟 + SAR 时钟) / ADC 时钟`，
 *   64 位 ps 存储，由外部 `advanceAdc` 按经过的皮秒推进；一次推进最多完成一个
 *   rank，但把超出时间结转到下一 rank，不丢失/重置时长；
 * - 每个外部通道按真实引脚采样电压，经 `readSample` 读取电阻网络求解结果；
 *   采样电压被钳制到 0..VREF+，参考取 VREFP 引脚，VDDA 决定 ADC 是否能就绪；
 * - 内部 ADC1_IN17 从 VBAT 引脚按 /3 分压，ADC1_IN18 使用 VREFINT 标称值；
 * - 中断挂起条件 `(ISR & IER & 0x7FF) != 0`，两个实例共用 ADC1_2 IRQ 18。
 *
 * 未实现/明确限制：
 * - DMA 请求与 DMA 相关 OVR 时序；
 * - 注入组转换（JADSTART/JSQR/JDR 只保存，不产生 JEOC/JEOS）；
 * - 外部硬件触发（EXTSEL/EXTEN 保存但不触发）、间断模式、自动注入；
 * - 模拟看门狗、过采样求和/移位、偏移/增益补偿、差分输入；
 * - 温度传感器与 OPAMP 内部输出通道返回“无数据”（不伪造读数）；
 * - ADC 输入采样电容、源阻抗、串扰、噪声等电气非理想性。
 *
 * 供电/参考约束：VDDA 低于 1.6 V 或 VREFP 浮空/低于 0.1 V 时不产生转换完成事件；
 * 外部通道还要求对应 GPIO MODER=11（模拟模式）。转换中止时清 ADSTART，不写 DR、
 * 不置 EOC，因此 HAL 轮询会超时而不是读到编造的数据。
 */

export const ADC_TICK_PS = 1_000_000;
/** 一次推进最多完成一个 rank；与 1 µs 节拍配合时足以覆盖最快转换。 */
export const ADC_MODEL_STATE = 0xe0;
/** 64 位剩余时间（ps）拆成低/高两个 32 位字；低核频 + 大采样可超过 2^32。 */
export const ADC_MODEL_REMAINING_LO = ADC_MODEL_STATE;
export const ADC_MODEL_REMAINING_HI = ADC_MODEL_STATE + 4;
export const ADC_MODEL_RANK = ADC_MODEL_STATE + 8;
export const ADC_MODEL_BUSY = ADC_MODEL_STATE + 12;
const ADC_TIME_SCALE = 4_294_967_296;
/** CR 持久位；动作位由 writeControl 单独处理，保留位恒为 0。 */
const ADC_CR_PERSISTENT_MASK = ADC_CR_ADVREGEN | ADC_CR_DEEPPWD | ADC_CR_ADCALDIF;
/** 已实现寄存器的字索引位图（0–31 与 32–63）。保留偏移不落进 analog 状态别名。 */
const ADC_REGISTER_MASK_LO = 0x0f09f77f;
const ADC_REGISTER_MASK_HI = 0x0001330f;

const isAdcRegisterAt = (wordOffset: number): boolean => {
  const index = wordOffset >>> 2;

  if (index < 32) return (ADC_REGISTER_MASK_LO & (1 << index)) !== 0;
  if (index < 64) return (ADC_REGISTER_MASK_HI & (1 << (index - 32))) !== 0;

  return false;
};

const isKnownRegister = (b: Body, wordOffset: Value<number>): Value<boolean> => {
  const index = b.shiftRightUnsigned(wordOffset, num(b, 2));
  const low = b.bitAnd(b.shiftRightUnsigned(num(b, ADC_REGISTER_MASK_LO), index), num(b, 1));
  const high = b.bitAnd(
    b.shiftRightUnsigned(num(b, ADC_REGISTER_MASK_HI), b.subtract(index, num(b, 32))),
    num(b, 1),
  );
  const bit = b.select(
    types.number,
    b.lessThan(index, num(b, 32)),
    () => low,
    () => high,
  );

  return boolAnd(
    b,
    b.lessThanOrEqual(wordOffset, num(b, ADC_LAST_REGISTER)),
    b.notEqual(types.number, bit, num(b, 0)),
  );
};

export interface AdcConfig {
  readonly index: 1 | 2;
  readonly base: number;
  readonly stateBase: number;
  readonly pins: Readonly<Record<number, AdcPin>>;
}

export const ADCS: readonly AdcConfig[] = [
  {
    index: 1,
    base: ADC1_BASE,
    stateBase: ADC_STATE_BASE,
    pins: ADC_CHANNEL_PINS[0]!,
  },
  {
    index: 2,
    base: ADC2_BASE,
    stateBase: ADC_STATE_BASE + ADC_STATE_STRIDE,
    pins: ADC_CHANNEL_PINS[1]!,
  },
];

const stateOf = (config: AdcConfig, offset: number): number => config.stateBase + offset;

const loadReg = (b: Body, config: AdcConfig, offset: number): Value<number> =>
  loadStateAt(b, config.stateBase, offset);

const storeReg = (b: Body, config: AdcConfig, offset: number, value: Value<number>): void => {
  writeWordAt(b, ANALOG, stateOf(config, offset), value);
};

const loadModel = (b: Body, config: AdcConfig, offset: number): Value<number> =>
  loadStateAt(b, config.stateBase, offset);

const storeModel = (b: Body, config: AdcConfig, offset: number, value: Value<number>): void => {
  writeWordAt(b, ANALOG, stateOf(config, offset), value);
};

/** 读 64 位剩余时间（ps），高字按有符号解释，允许短时间出现负 remaining。 */
const loadRemaining = (b: Body, config: AdcConfig): Value<number> => {
  const low = loadModel(b, config, ADC_MODEL_REMAINING_LO);
  const high = b.shiftRight(loadModel(b, config, ADC_MODEL_REMAINING_HI), num(b, 0));

  return b.add(low, b.multiply(high, num(b, ADC_TIME_SCALE)));
};

/** 写 64 位剩余时间；负值用二补码保存，避免负数被截成巨大正数。 */
const storeRemaining = (b: Body, config: AdcConfig, value: Value<number>): void => {
  const high = b.floor(b.divide(value, num(b, ADC_TIME_SCALE)));
  const low = b.subtract(value, b.multiply(high, num(b, ADC_TIME_SCALE)));

  storeModel(b, config, ADC_MODEL_REMAINING_LO, u32(b, low));
  storeModel(b, config, ADC_MODEL_REMAINING_HI, u32(b, high));
};

const loadHarness = (b: Body, offset: number): Value<number> =>
  loadStateAt(b, ADC_COMMON_STATE, offset);

/** 常量索引表选择：用惰性 select 生成一串常量分支。 */
function selectConstant(b: Body, index: Value<number>, values: readonly number[]): Value<number> {
  let result = num(b, values[values.length - 1] ?? 0);

  for (let i = values.length - 2; i >= 0; i -= 1) {
    const fallback = result;

    result = b.select(
      types.number,
      b.equal(types.number, index, num(b, i)),
      (inner) => inner.constant(types.number, values[i] ?? 0),
      () => fallback,
    );
  }

  return result;
}

/** ADC 时钟分频：CKMODE=0 用异步 PRESC，CKMODE=1/2/3 用 HCLK/1/2/4。 */
function adcClockDivisor(b: Body): Value<number> {
  const ccr = loadHarness(b, ADC_CCR);
  const ckmode = bitField(b, ccr, ADC_CCR_CKMODE_SHIFT, 2);
  const presc = bitField(b, ccr, 18, 4);
  const asynchronous = selectConstant(b, presc, ADC_PRESCALER);

  return b.select(
    types.number,
    b.equal(types.number, ckmode, num(b, 0)),
    () => asynchronous,
    (inner) =>
      inner.select(
        types.number,
        inner.equal(types.number, ckmode, inner.constant(types.number, 1)),
        (one) => one.constant(types.number, 1),
        (other) =>
          other.select(
            types.number,
            other.equal(types.number, ckmode, other.constant(types.number, 2)),
            (two) => two.constant(types.number, 2),
            (four) => four.constant(types.number, 4),
          ),
      ),
  );
}

/** 通道的 SMP[2:0]：G4 的 SMPR1 是通道 0–9，SMPR2 是通道 10–18。 */
function sampleTimeCode(b: Body, config: AdcConfig, channel: Value<number>): Value<number> {
  const low = b.lessThan(channel, num(b, 10));
  const register = b.select(
    types.number,
    low,
    (inner) => loadReg(asBody(inner), config, ADC_SMPR1),
    (inner) => loadReg(asBody(inner), config, ADC_SMPR2),
  );
  const index = b.select(
    types.number,
    low,
    () => channel,
    (inner) => inner.subtract(channel, inner.constant(types.number, 10)),
  );

  return b.bitAnd(
    b.shiftRightUnsigned(register, b.multiply(index, num(b, 3))),
    num(b, 7),
  );
}

/** 一次规则转换的时间（ps）：采样时钟 + SAR 时钟，按 ADC 时钟换算。 */
export function adcConversionTimePs(
  b: Body,
  config: AdcConfig,
  channel: Value<number>,
): Value<number> {
  const cfgr = loadReg(b, config, ADC_CFGR);
  const resolution = bitField(b, cfgr, ADC_CFGR_RES_SHIFT, 2);
  const sampleCycles = selectConstant(b, sampleTimeCode(b, config, channel), ADC_SAMPLE_CYCLES);
  const sarCycles = selectConstant(b, resolution, ADC_SAR_CYCLES);
  const divisor = adcClockDivisor(b);
  const clock = b.divide(num(b, machine().clockFrequency), divisor);
  const cycles = b.add(sampleCycles, sarCycles);
  const ps = b.divide(b.multiply(cycles, num(b, 1_000_000_000_000)), clock);

  return b.max(num(b, 1), b.ceil(ps));
}

/** 读取 VREFP 的可用参考电压；浮空/欠压时 valid=false，voltage 回落为 0。 */
function reference(b: Body): { readonly valid: Value<boolean>; readonly voltage: Value<number> } {
  const sample = b.local(types.sample, b.readSample('VREFP'));
  const status = b.field(b.getLocal(sample), 'status');
  const voltageOptional = b.field(b.getLocal(sample), 'voltage');
  const voltage = b.select(
    types.number,
    b.isNone(voltageOptional),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(voltageOptional),
  );
  const statusValid = b.equal(
    types.sampleStatus,
    status,
    b.constant(types.sampleStatus, types.sampleStatus.members.valid),
  );
  const valid = boolAnd(
    b,
    statusValid,
    b.greaterThan(voltage, num(b, ADC_MIN_REFERENCE)),
  );

  return { valid, voltage };
}

/** VDDA 是否达到 ADC 工作电压。 */
function analogPowered(b: Body): Value<boolean> {
  const sample = b.local(types.sample, b.readSample('VDDA'));
  const status = b.field(b.getLocal(sample), 'status');
  const voltageOptional = b.field(b.getLocal(sample), 'voltage');
  const voltage = b.select(
    types.number,
    b.isNone(voltageOptional),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(voltageOptional),
  );
  const statusValid = b.equal(
    types.sampleStatus,
    status,
    b.constant(types.sampleStatus, types.sampleStatus.members.valid),
  );

  return boolAnd(b, statusValid, b.greaterThan(voltage, num(b, ADC_MIN_VDDA)));
}

function pinMode(b: Body, pin: AdcPin): Value<number> {
  const moder = b.readState(gpioModerState(pin.port), types.number);

  return bitField(b, moder, pin.bit * 2, 2);
}

/**
 * 计算运行期通道号的输入电压与可用性。外部通道只有在 GPIO MODER=11 且采样有效时
 * 才可用；内部通道按 CCR 的使能位与固定/真实来源计算。
 */
function channelInput(
  b: Body,
  config: AdcConfig,
  channel: Value<number>,
): { readonly valid: Value<boolean>; readonly voltage: Value<number> } {
  const valid = b.local(types.bool, false);
  const voltage = b.local(types.number, 0);

  const external = (pin: AdcPin): ((inner: Body) => void) => (inner) => {
    const sample = inner.local(types.sample, inner.readSample(pin.pin));
    const status = inner.field(inner.getLocal(sample), 'status');
    const voltageOptional = inner.field(inner.getLocal(sample), 'voltage');
    const statusValid = inner.equal(
      types.sampleStatus,
      status,
      inner.constant(types.sampleStatus, types.sampleStatus.members.valid),
    );
    const present = inner.not(inner.isNone(voltageOptional));
    const analogMode = inner.equal(
      types.number,
      pinMode(inner, pin),
      inner.constant(types.number, 3),
    );
    const sampled = inner.select(
      types.number,
      inner.isNone(voltageOptional),
      (none) => none.constant(types.number, 0),
      (presentVoltage) => presentVoltage.nonNull(voltageOptional),
    );

    inner.setLocal(valid, boolAnd(inner, boolAnd(inner, statusValid, present), analogMode));
    inner.setLocal(voltage, sampled);
  };

  for (const [key, pin] of Object.entries(config.pins)) {
    const number = Number(key);

    b.if(b.equal(types.number, channel, num(b, number)), external(pin));
  }

  const ccr = loadHarness(b, ADC_CCR);

  if (config.index === 1) {
    // ADC1_IN16 是温度传感器：没有环境温度输入，不伪造读数。
    b.if(b.equal(types.number, channel, num(b, 17)), (inner) => {
      const body = asBody(inner);

      body.if(boolBit(inner, ccr, ADC_CCR_VBATSEL), (enabled) => {
        const scope = asBody(enabled);
        const sample = scope.local(types.sample, scope.readSample('VBAT'));
        const status = scope.field(scope.getLocal(sample), 'status');
        const voltageOptional = scope.field(scope.getLocal(sample), 'voltage');
        const statusValid = scope.equal(
          types.sampleStatus,
          status,
          scope.constant(types.sampleStatus, types.sampleStatus.members.valid),
        );
        const present = scope.not(scope.isNone(voltageOptional));
        const sampled = scope.select(
          types.number,
          scope.isNone(voltageOptional),
          (none) => none.constant(types.number, 0),
          (presentVoltage) => presentVoltage.nonNull(voltageOptional),
        );

        scope.setLocal(valid, boolAnd(scope, statusValid, present));
        scope.setLocal(voltage, scope.divide(sampled, scope.constant(types.number, ADC_VBAT_DIVIDER)));
      });
    });
    b.if(b.equal(types.number, channel, num(b, 18)), (inner) => {
      const body = asBody(inner);

      body.if(boolBit(inner, ccr, ADC_CCR_VREFEN), (enabled) => {
        const scope = asBody(enabled);

        scope.setLocal(valid, bool(scope, true));
        scope.setLocal(voltage, num(scope, ADC_VREFINT_NOMINAL));
      });
    });
  }

  // 差分模式未实现：DIFSEL 对应位置 1 时按“无数据”处理，避免把单端电压伪造成差分值。
  const difsel = loadReg(b, config, 0xb0);

  b.if(
    b.notEqual(
      types.number,
      b.bitAnd(b.shiftRightUnsigned(difsel, channel), num(b, 1)),
      num(b, 0),
    ),
    (inner) => inner.setLocal(valid, bool(asBody(inner), false)),
  );

  return { valid: b.getLocal(valid), voltage: b.getLocal(voltage) };
}

/** 规则序列长度：SQR1.L + 1。 */
const sequenceLength = (b: Body, config: AdcConfig): Value<number> =>
  b.add(
    b.bitAnd(loadReg(b, config, ADC_SQR1), num(b, 0xf)),
    num(b, 1),
  );

/** 运行期 rank（0 基）对应的 SQR 通道号。 */
function sequenceChannel(b: Body, config: AdcConfig, rank: Value<number>): Value<number> {
  const result = b.local(types.number, 0);
  const ranks: readonly [number, number, number][] = [
    [0, ADC_SQR1, 6],
    [1, ADC_SQR1, 12],
    [2, ADC_SQR1, 18],
    [3, ADC_SQR1, 24],
    [4, ADC_SQR2, 0],
    [5, ADC_SQR2, 6],
    [6, ADC_SQR2, 12],
    [7, ADC_SQR2, 18],
    [8, ADC_SQR2, 24],
    [9, ADC_SQR3, 0],
    [10, ADC_SQR3, 6],
    [11, ADC_SQR3, 12],
    [12, ADC_SQR3, 18],
    [13, ADC_SQR3, 24],
    [14, ADC_SQR4, 0],
    [15, ADC_SQR4, 6],
  ];

  for (const [index, offset, shift] of ranks)
    b.if(b.equal(types.number, rank, num(b, index)), (inner) => {
      const body = asBody(inner);

      inner.setLocal(result, bitField(body, loadReg(body, config, offset), shift, 5));
    });

  return b.getLocal(result);
}

function scheduleRank(
  b: Body,
  config: AdcConfig,
  rank: number | Value<number>,
  channel: Value<number>,
  overshoot?: Value<number>,
): void {
  const duration = adcConversionTimePs(b, config, channel);

  storeModel(
    b,
    config,
    ADC_MODEL_RANK,
    typeof rank === 'number' ? num(b, rank) : rank,
  );
  storeRemaining(
    b,
    config,
    overshoot === undefined ? duration : b.subtract(duration, overshoot),
  );
  storeModel(b, config, ADC_MODEL_BUSY, num(b, 1));
}

function markPending(b: Body, config: AdcConfig): void {
  b.if(adcPending(b, config), (inner) => {
    const body = asBody(inner);

    body.writeState(IRQ_DIRTY, bool(body, true));
    markService(body, SERVICE_IRQ);
  });
}

/** 完成当前 rank：写 DR、置标志、按序列/连续配置调度下一次转换。 */
function completeRank(b: Body, config: AdcConfig, overshoot: Value<number>): void {
  const rank = loadModel(b, config, ADC_MODEL_RANK);
  const channel = sequenceChannel(b, config, rank);
  const input = channelInput(b, config, channel);
  const ref = reference(b);
  const ready = boolAnd(b, boolAnd(b, input.valid, ref.valid), analogPowered(b));

  b.if(
    ready,
    (ok) => finishRank(asBody(ok), config, rank, input.voltage, ref.voltage, overshoot),
    (invalid) => abortConversion(asBody(invalid), config),
  );
}

function finishRank(
  b: Body,
  config: AdcConfig,
  rank: Value<number>,
  voltage: Value<number>,
  referenceVoltage: Value<number>,
  overshoot: Value<number>,
): void {
  const cfgr = loadReg(b, config, ADC_CFGR);
  const resolution = bitField(b, cfgr, ADC_CFGR_RES_SHIFT, 2);
  const fullScale = selectConstant(b, resolution, ADC_FULL_SCALE);
  const bits = selectConstant(b, resolution, ADC_RESOLUTION_BITS);
  const scale = b.shiftLeft(num(b, 1), bits);
  // 理想 N 位 ADC：code = clamp(floor(Vin / Vref × 2^N), 0, 2^N-1)。
  const clamped = b.min(
    b.max(
      b.floor(b.multiply(b.divide(voltage, referenceVoltage), scale)),
      num(b, 0),
    ),
    fullScale,
  );
  const aligned = b.select(
    types.number,
    boolBit(b, cfgr, ADC_CFGR_ALIGN),
    (shifted) =>
      shifted.shiftLeft(clamped, shifted.subtract(shifted.constant(types.number, 16), bits)),
    () => clamped,
  );
  const data = b.bitAnd(aligned, num(b, 0xffff));
  const length = sequenceLength(b, config);
  const nextRank = b.add(rank, num(b, 1));
  const last = b.greaterThanOrEqual(nextRank, length);
  const isr = loadReg(b, config, ADC_ISR);
  const eocSet = boolBit(b, isr, ADC_ISR_EOC);
  const overrunPreserve = boolAnd(
    b,
    eocSet,
    b.not(boolBit(b, cfgr, ADC_CFGR_OVRMOD)),
  );
  const flags = b.bitOr(
    num(b, ADC_ISR_EOC | ADC_ISR_EOSMP),
    b.select(
      types.number,
      last,
      (inner) => inner.constant(types.number, ADC_ISR_EOS),
      (inner) => inner.constant(types.number, 0),
    ),
  );
  // OVR 与新数据是否保留无关：只要上一次 EOC 未读就置位；OVRMOD 只决定 DR 是否覆盖。
  const nextIsr = b.select(
    types.number,
    eocSet,
    (over) => over.bitOr(over.bitOr(isr, flags), over.constant(types.number, ADC_ISR_OVR)),
    (stored) => stored.bitOr(isr, flags),
  );
  const nextData = b.select(
    types.number,
    overrunPreserve,
    (inner) => loadReg(asBody(inner), config, ADC_DR),
    () => data,
  );

  storeReg(b, config, ADC_ISR, nextIsr);
  storeReg(b, config, ADC_DR, nextData);

  b.if(last, (finished) => {
    const body = asBody(finished);

    body.if(
      boolBit(body, cfgr, ADC_CFGR_CONT),
      (continuous) => {
        const scope = asBody(continuous);

        scheduleRank(scope, config, 0, sequenceChannel(scope, config, num(scope, 0)), overshoot);
      },
      (single) => {
        const scope = asBody(single);
        const control = loadReg(scope, config, ADC_CR);

        storeModel(scope, config, ADC_MODEL_BUSY, num(scope, 0));
        storeRemaining(scope, config, num(scope, 0));
        storeReg(scope, config, ADC_CR, scope.bitAnd(control, num(scope, ~ADC_CR_ADSTART)));
      },
    );
  }, (more) => {
    const body = asBody(more);

    scheduleRank(body, config, nextRank, sequenceChannel(body, config, nextRank), overshoot);
  });

  markPending(b, config);
}

function abortConversion(b: Body, config: AdcConfig): void {
  const control = loadReg(b, config, ADC_CR);

  storeModel(b, config, ADC_MODEL_BUSY, num(b, 0));
  storeRemaining(b, config, num(b, 0));
  storeReg(b, config, ADC_CR, b.bitAnd(control, num(b, ~ADC_CR_ADSTART)));
}

/**
 * 把两个 ADC 实例的“下一次事件”合并到一个活动槽：有转换时活动，deadline 取两路
 * 剩余时间的最小值；全部空闲时清除槽位。`tick.ts` 只依赖这个槽，不需要认识 ADC。
 */
function refreshAdcSlot(b: Body): void {
  const slot = PeripheralSlot.Analog;
  const busy1 = adcBusy(b, ADCS[0]!);
  const busy2 = adcBusy(b, ADCS[1]!);
  const active = boolOr(b, busy1, busy2);
  const remaining1 = b.select(
    types.number,
    busy1,
    (inner) => loadRemaining(asBody(inner), ADCS[0]!),
    (inner) => inner.constant(types.number, 1_000_000_000_000_000),
  );
  const remaining2 = b.select(
    types.number,
    busy2,
    (inner) => loadRemaining(asBody(inner), ADCS[1]!),
    (inner) => inner.constant(types.number, 1_000_000_000_000_000),
  );
  const deadline = b.max(num(b, 1), b.min(remaining1, remaining2));

  setPeripheralActive(b, slot, active);
  setPeripheralDeadline(
    b,
    slot,
    b.select(types.number, active, () => deadline, (inner) => inner.constant(types.number, 0)),
  );
  refreshTick(b);
}

/**
 * 推进转换。一次调用最多完成 4 个 rank：只要 elapsed 覆盖下一 rank，就继续，
 * 超出时间通过 `scheduleRank(..., overshoot)` 结转。中央 deadline 合同通常保证
 * elapsed <= 一个 rank；4 次展开覆盖常见小序列，连续/长序列剩余时间保留在
 * remaining 中，deadline 会被 clamp 到 1 ps，下一次服务继续，不丢事件。
 */
export function advanceAdc(b: Body, elapsedPs: Value<number>): void {
  const MAX_RANKS = 4;

  for (const config of ADCS) {
    b.if(
      b.notEqual(types.number, loadModel(b, config, ADC_MODEL_BUSY), num(b, 0)),
      (busy) => {
        const body = asBody(busy);
        const remaining = body.local(
          types.number,
          body.subtract(loadRemaining(body, config), elapsedPs),
        );

        for (let step = 0; step < MAX_RANKS; step += 1)
          body.if(
            boolAnd(
              body,
              body.notEqual(types.number, loadModel(body, config, ADC_MODEL_BUSY), num(body, 0)),
              body.lessThanOrEqual(body.getLocal(remaining), num(body, 0)),
            ),
            (hit) => {
              const scope = asBody(hit);
              const overshoot = scope.subtract(num(scope, 0), scope.getLocal(remaining));

              completeRank(scope, config, overshoot);
              scope.setLocal(remaining, loadRemaining(scope, config));
            },
          );

        body.if(
          body.notEqual(types.number, loadModel(body, config, ADC_MODEL_BUSY), num(body, 0)),
          (waiting) => storeRemaining(asBody(waiting), config, asBody(waiting).getLocal(remaining)),
          () => {},
        );
      },
    );
  }

  refreshAdcSlot(b);
}

/** 是否有 ADC 正在转换；供 `tick.ts` 决定节拍粒度。 */
export function adcActive(b: Body): Value<boolean> {
  let active: Value<boolean> = bool(b, false);

  for (const config of ADCS)
    active = boolOr(
      b,
      active,
      b.notEqual(types.number, loadModel(b, config, ADC_MODEL_BUSY), num(b, 0)),
    );

  return active;
}

export function adcBusy(b: Body, config: AdcConfig): Value<boolean> {
  return b.notEqual(types.number, loadModel(b, config, ADC_MODEL_BUSY), num(b, 0));
}

/** 单个 ADC 的中断挂起条件。 */
export function adcPending(b: Body, config: AdcConfig): Value<boolean> {
  const isr = loadReg(b, config, ADC_ISR);
  const ier = loadReg(b, config, ADC_IER);

  return b.notEqual(
    types.number,
    b.bitAnd(b.bitAnd(isr, ier), num(b, ADC_ISR_MASK)),
    num(b, 0),
  );
}

/** ADC1_2 共用中断线的挂起条件。 */
export function adcIrqPending(b: Body): Value<boolean> {
  return boolOr(b, adcPending(b, ADCS[0]!), adcPending(b, ADCS[1]!));
}

export function adcRegion(b: Body, address: Value<number>): Value<boolean> {
  return boolAnd(
    b,
    b.greaterThanOrEqual(address, num(b, ADC1_BASE)),
    b.lessThan(address, num(b, ADC12_COMMON_BASE + 0x10)),
  );
}

export function inAdcRegionStatic(address: number): boolean {
  return address >= ADC1_BASE && address < ADC12_COMMON_BASE + 0x10;
}

/** 清 ISR 的写 1 位。 */
function acknowledgeFlags(b: Body, config: AdcConfig, placed: Value<number>): void {
  storeReg(
    b,
    config,
    ADC_ISR,
    b.bitAnd(loadReg(b, config, ADC_ISR), b.bitNot(placed)),
  );
}

/** 按静态偏移读一个 ADC 实例。 */
export function readAdcAt(
  b: Body,
  config: AdcConfig,
  offset: number,
  size: number,
): Value<number> {
  const wordOffset = offset & 0xfc;

  if (wordOffset === ADC_DR) {
    const dr = loadReg(b, config, ADC_DR);
    const isr = loadReg(b, config, ADC_ISR);
    // 只有访问覆盖 DR[15:0] 的字节才清 EOC；读高位保留字节不产生副作用。
    const touchesData =
      size === 4 || (size === 2 && (offset & 3) === 0) || (size === 1 && (offset & 3) <= 1);

    if (touchesData)
      b.if(boolBit(b, isr, ADC_ISR_EOC), (clear) => {
        const body = asBody(clear);

        storeReg(body, config, ADC_ISR, body.bitAnd(isr, num(body, ~ADC_ISR_EOC)));
      });

    return extractAt(b, b.bitAnd(dr, num(b, 0xffff)), offset, size);
  }

  if (!isAdcRegisterAt(wordOffset)) return num(b, 0);

  return readRegisterAt(b, config.stateBase, offset, size);
}

/** 按运行期偏移读一个 ADC 实例。 */
export function readAdc(
  b: Body,
  config: AdcConfig,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0xfc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, ADC_DR)),
    (dr) => {
      const body = asBody(dr);
      const isr = loadReg(body, config, ADC_ISR);

      body.setLocal(result, body.bitAnd(loadReg(body, config, ADC_DR), num(body, 0xffff)));
      const touchesData =
        size === 4
          ? body.constant(types.bool, true)
          : body.lessThan(
              body.bitAnd(offset, num(body, 3)),
              num(body, size === 2 ? 1 : 2),
            );

      body.if(
        boolAnd(body, touchesData, boolBit(body, isr, ADC_ISR_EOC)),
        (clear) => {
          const scope = asBody(clear);

          storeReg(scope, config, ADC_ISR, scope.bitAnd(isr, num(scope, ~ADC_ISR_EOC)));
        },
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        isKnownRegister(body, wordOffset),
        (readable) => readable.setLocal(result, readRegister(asBody(readable), config.stateBase, wordOffset, 4)),
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

/** 读公共区 CSR/CCR/CDR；CSR 由两个实例的 ISR 合成。 */
export function readAdcCommonAt(b: Body, offset: number, size: number): Value<number> {
  const wordOffset = offset & 0xfc;

  if (wordOffset === ADC_CCR) return readRegisterAt(b, ADC_COMMON_STATE, offset, size);
  if (wordOffset !== ADC_CSR && wordOffset !== ADC_CDR) return num(b, 0);

  const isr1 = loadReg(b, ADCS[0]!, ADC_ISR);
  const isr2 = loadReg(b, ADCS[1]!, ADC_ISR);

  if (wordOffset === ADC_CSR) {
    const value = b.bitOr(
      b.bitAnd(isr1, num(b, ADC_ISR_MASK)),
      b.shiftLeft(b.bitAnd(isr2, num(b, ADC_ISR_MASK)), num(b, 16)),
    );

    return extractAt(b, value, offset, size);
  }

  const dr1 = loadReg(b, ADCS[0]!, ADC_DR);
  const dr2 = loadReg(b, ADCS[1]!, ADC_DR);
  const value = b.bitOr(
    b.bitAnd(dr1, num(b, 0xffff)),
    b.shiftLeft(b.bitAnd(dr2, num(b, 0xffff)), num(b, 16)),
  );

  return extractAt(b, value, offset, size);
}

/** 运行期偏移读公共区。 */
export function readAdcCommon(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0xfc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, ADC_CCR)),
    (ccr) => ccr.setLocal(result, loadHarness(asBody(ccr), ADC_CCR)),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, ADC_CSR)),
        (csr) => {
          const scope = asBody(csr);
          const isr1 = loadReg(scope, ADCS[0]!, ADC_ISR);
          const isr2 = loadReg(scope, ADCS[1]!, ADC_ISR);

          scope.setLocal(
            result,
            scope.bitOr(
              scope.bitAnd(isr1, num(scope, ADC_ISR_MASK)),
              scope.shiftLeft(scope.bitAnd(isr2, num(scope, ADC_ISR_MASK)), num(scope, 16)),
            ),
          );
        },
        (cdr) => {
          const scope = asBody(cdr);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, ADC_CDR)),
            (hit) => {
              const body2 = asBody(hit);
              const dr1 = loadReg(body2, ADCS[0]!, ADC_DR);
              const dr2 = loadReg(body2, ADCS[1]!, ADC_DR);

              body2.setLocal(
                result,
                body2.bitOr(
                  body2.bitAnd(dr1, num(body2, 0xffff)),
                  body2.shiftLeft(body2.bitAnd(dr2, num(body2, 0xffff)), num(body2, 16)),
                ),
              );
            },
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

/** 静态地址读 ADC 区间（含 ADC1/ADC2/公共区）。 */
export function readAdcAddressAt(b: Body, address: number, size: number): Value<number> {
  if (address < ADC2_BASE) return readAdcAt(b, ADCS[0]!, address - ADC1_BASE, size);
  if (address < ADC12_COMMON_BASE) {
    if (address >= ADC2_BASE + 0x100) return num(b, 0);

    return readAdcAt(b, ADCS[1]!, address - ADC2_BASE, size);
  }

  return readAdcCommonAt(b, address - ADC12_COMMON_BASE, size);
}

/** 运行期地址读 ADC 区间。 */
export function readAdcAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    b.lessThan(address, num(b, ADC2_BASE)),
    (first) => {
      const body = asBody(first);

      body.setLocal(
        result,
        readAdc(body, ADCS[0]!, body.subtract(address, num(body, ADC1_BASE)), size),
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.lessThan(address, num(body, ADC12_COMMON_BASE)),
        (second) => {
          const scope = asBody(second);

          scope.if(
            scope.lessThan(address, num(scope, ADC2_BASE + 0x100)),
            (hit) => {
              const body2 = asBody(hit);

              body2.setLocal(
                result,
                readAdc(body2, ADCS[1]!, body2.subtract(address, num(body2, ADC2_BASE)), size),
              );
            },
          );
        },
        (common) => {
          const scope = asBody(common);

          scope.setLocal(
            result,
            readAdcCommon(scope, scope.subtract(address, num(scope, ADC12_COMMON_BASE)), size),
          );
        },
      );
    },
  );

  return b.getLocal(result);
}

/** 写 CR：硬件动作位（ADEN/ADDIS/ADSTART/ADSTP/ADCAL/…）按真实顺序处理。 */
function writeControl(
  b: Body,
  config: AdcConfig,
  current: Value<number>,
  merged: Value<number>,
  placed: Value<number>,
): void {
  const baseline = b.bitOr(
    b.bitAnd(merged, num(b, ADC_CR_PERSISTENT_MASK)),
    b.bitAnd(current, num(b, ADC_CR_ACTION_MASK)),
  );
  const control = b.local(types.number, baseline);

  // 深度掉电优先：清使能/就绪/转换与相位。
  b.if(boolBitAt(b, b.getLocal(control), 29), (deep) => {
    const body = asBody(deep);
    const isr = loadReg(body, config, ADC_ISR);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~(ADC_CR_ADEN | ADC_CR_ADSTART | ADC_CR_JADSTART))),
    );
    storeReg(body, config, ADC_ISR, body.bitAnd(isr, num(body, ~ADC_ISR_ADRDY)));
    storeModel(body, config, ADC_MODEL_BUSY, num(body, 0));
    storeRemaining(body, config, num(body, 0));
  });

  // 稳压器关闭后 ADC 不得保持使能。
  b.if(b.not(boolBitAt(b, b.getLocal(control), 28)), (regulatorOff) => {
    const body = asBody(regulatorOff);
    const isr = loadReg(body, config, ADC_ISR);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~(ADC_CR_ADEN | ADC_CR_ADSTART | ADC_CR_JADSTART))),
    );
    storeReg(body, config, ADC_ISR, body.bitAnd(isr, num(body, ~ADC_ISR_ADRDY)));
    storeModel(body, config, ADC_MODEL_BUSY, num(body, 0));
    storeRemaining(body, config, num(body, 0));
  });

  // ADDIS：停止并关闭。ADSTP/JADSTP：只停对应组。
  b.if(boolBitAt(b, placed, 1), (disable) => {
    const body = asBody(disable);
    const isr = loadReg(body, config, ADC_ISR);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~(ADC_CR_ADEN | ADC_CR_ADSTART | ADC_CR_JADSTART | ADC_CR_ADDIS | ADC_CR_ADSTP | ADC_CR_JADSTP))),
    );
    storeReg(body, config, ADC_ISR, body.bitAnd(isr, num(body, ~ADC_ISR_ADRDY)));
    storeModel(body, config, ADC_MODEL_BUSY, num(body, 0));
    storeRemaining(body, config, num(body, 0));
  });
  b.if(boolBitAt(b, placed, 4), (stop) => {
    const body = asBody(stop);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~(ADC_CR_ADSTART | ADC_CR_ADSTP))),
    );
    storeModel(body, config, ADC_MODEL_BUSY, num(body, 0));
    storeRemaining(body, config, num(body, 0));
  });
  b.if(boolBitAt(b, placed, 5), (stopInjected) => {
    const body = asBody(stopInjected);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~(ADC_CR_JADSTART | ADC_CR_JADSTP))),
    );
  });

  // 校准：模型按立即完成处理，CALFACT 保持软件可读值（不伪造工厂校准）。
  b.if(boolBitAt(b, placed, 31), (calibrate) => {
    const body = asBody(calibrate);

    body.setLocal(
      control,
      body.bitAnd(body.getLocal(control), num(body, ~ADC_CR_ADCAL)),
    );
  });

  // 使能 ADC：需要 VDDA 有效、非深度掉电且稳压器已开。
  b.if(boolBitAt(b, placed, 0), (enable) => {
    const body = asBody(enable);
    const canEnable = boolAnd(
      body,
      body.not(boolBitAt(body, body.getLocal(control), 29)),
      boolAnd(
        body,
        boolBitAt(body, body.getLocal(control), 28),
        analogPowered(body),
      ),
    );

    body.if(canEnable, (ok) => {
      const scope = asBody(ok);
      const isr = loadReg(scope, config, ADC_ISR);

      storeReg(scope, config, ADC_ISR, scope.bitOr(isr, num(scope, ADC_ISR_ADRDY)));
      scope.setLocal(
        control,
        scope.bitOr(scope.getLocal(control), num(scope, ADC_CR_ADEN)),
      );
    }, (fail) => {
      const scope = asBody(fail);

      scope.setLocal(
        control,
        scope.bitAnd(scope.getLocal(control), num(scope, ~ADC_CR_ADEN)),
      );
    });
  });

  // 启动规则组：软件触发下立即锁存 rank 0。
  b.if(boolBitAt(b, placed, 2), (start) => {
    const body = asBody(start);
    const canStart = boolAnd(
      body,
      boolBitAt(body, body.getLocal(control), 0),
      boolAnd(
        body,
        body.not(boolBitAt(body, body.getLocal(control), 1)),
        body.equal(types.number, loadModel(body, config, ADC_MODEL_BUSY), num(body, 0)),
      ),
    );

    body.if(canStart, (ok) => {
      const scope = asBody(ok);

      scope.setLocal(
        control,
        scope.bitOr(scope.getLocal(control), num(scope, ADC_CR_ADSTART)),
      );
      storeReg(scope, config, ADC_CR, scope.getLocal(control));
      const sq1 = bitField(scope, loadReg(scope, config, ADC_SQR1), 6, 5);

      scheduleRank(scope, config, 0, sq1);
    }, (fail) => {
      const scope = asBody(fail);

      scope.setLocal(
        control,
        scope.bitAnd(scope.getLocal(control), num(scope, ~ADC_CR_ADSTART)),
      );
    });
  });

  // 注入组只维护状态位，不产生转换。
  b.if(boolBitAt(b, placed, 3), (startInjected) => {
    const body = asBody(startInjected);

    body.setLocal(
      control,
      body.bitOr(body.getLocal(control), num(body, ADC_CR_JADSTART)),
    );
  });

  storeReg(b, config, ADC_CR, b.getLocal(control));
  refreshAdcSlot(b);
  markPending(b, config);
}

/** 静态偏移写一个 ADC 实例。 */
export function writeAdcAt(
  b: Body,
  config: AdcConfig,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = offset & 0xfc;

  if (wordOffset === ADC_ISR) {
    acknowledgeFlags(b, config, place(b, value, num(b, offset), size));

    return;
  }
  if (wordOffset === ADC_DR) return;
  // 注入组数据寄存器只读；未建模注入转换时写入必须忽略。
  if (wordOffset >= ADC_JDR1 && wordOffset <= ADC_JDR4) return;
  if (wordOffset === ADC_CR) {
    const placed = place(b, value, num(b, offset), size);
    const current = loadReg(b, config, ADC_CR);
    const merged = merge(b, current, value, num(b, offset), size);

    writeControl(b, config, current, merged, placed);

    return;
  }
  if (!isAdcRegisterAt(wordOffset)) return;

  if (wordOffset === ADC_IER) {
    const current = loadReg(b, config, ADC_IER);
    const merged = merge(b, current, value, num(b, offset), size);

    storeReg(b, config, ADC_IER, b.bitAnd(merged, num(b, ADC_IER_MASK)));
    markPending(b, config);

    return;
  }

  writeRegisterAt(b, config.stateBase, offset, size, value);
}

/** 运行期偏移写一个 ADC 实例。 */
export function writeAdc(
  b: Body,
  config: AdcConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0xfc));
  const placed = place(b, value, offset, size);

  b.if(
    b.equal(types.number, wordOffset, num(b, ADC_ISR)),
    (isr) => acknowledgeFlags(asBody(isr), config, placed),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, ADC_CR)),
        (control) => {
          const scope = asBody(control);
          const current = loadReg(scope, config, ADC_CR);
          const merged = merge(scope, current, value, offset, size);

          writeControl(scope, config, current, merged, placed);
        },
        (rest) => {
          const scope = asBody(rest);

          scope.if(
            scope.notEqual(types.number, wordOffset, num(scope, ADC_DR)),
            (writable) => {
              const body2 = asBody(writable);

              body2.if(
                boolAnd(
                  body2,
                  isKnownRegister(body2, wordOffset),
                  boolOr(
                    body2,
                    body2.lessThan(wordOffset, num(body2, ADC_JDR1)),
                    body2.greaterThan(wordOffset, num(body2, ADC_JDR4)),
                  ),
                ),
                (hit) => {
                  const body3 = asBody(hit);

                  body3.if(
                    body3.equal(types.number, wordOffset, num(body3, ADC_IER)),
                    (ier) => {
                      const scope = asBody(ier);
                      const current = loadReg(scope, config, ADC_IER);
                      const merged = merge(scope, current, value, offset, size);

                      storeReg(scope, config, ADC_IER, scope.bitAnd(merged, num(scope, ADC_IER_MASK)));
                      markPending(scope, config);
                    },
                    (other) => writeRegister(asBody(other), config.stateBase, offset, size, value),
                  );
                },
              );
            },
          );
        },
      );
    },
  );
}

/** 静态地址写 ADC 区间（含公共区）。 */
export function writeAdcAddressAt(
  b: Body,
  address: number,
  size: number,
  value: Value<number>,
): void {
  if (address < ADC2_BASE) {
    writeAdcAt(b, ADCS[0]!, address - ADC1_BASE, size, value);

    return;
  }
  if (address < ADC12_COMMON_BASE) {
    if (address < ADC2_BASE + 0x100)
      writeAdcAt(b, ADCS[1]!, address - ADC2_BASE, size, value);

    return;
  }

  const offset = address - ADC12_COMMON_BASE;

  if ((offset & 0xfc) === ADC_CCR)
    writeRegisterAt(b, ADC_COMMON_STATE, offset, size, value);
}

/** 运行期地址写 ADC 区间。 */
export function writeAdcAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.if(
    b.lessThan(address, num(b, ADC2_BASE)),
    (first) => {
      const body = asBody(first);

      writeAdc(
        body,
        ADCS[0]!,
        body.subtract(address, num(body, ADC1_BASE)),
        size,
        value,
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.lessThan(address, num(body, ADC12_COMMON_BASE)),
        (second) => {
          const scope = asBody(second);

          scope.if(
            scope.lessThan(address, num(scope, ADC2_BASE + 0x100)),
            (hit) => {
              const body2 = asBody(hit);

              writeAdc(
                body2,
                ADCS[1]!,
                body2.subtract(address, num(body2, ADC2_BASE)),
                size,
                value,
              );
            },
          );
        },
        (common) => {
          const scope = asBody(common);
          const offset = scope.subtract(address, num(scope, ADC12_COMMON_BASE));

          scope.if(
            scope.equal(
              types.number,
              scope.bitAnd(offset, num(scope, 0xfc)),
              num(scope, ADC_CCR),
            ),
            (ccr) => {
              writeRegister(
                asBody(ccr),
                ADC_COMMON_STATE,
                offset,
                size,
                value,
              );
            },
          );
        },
      );
    },
  );
}

/** ADC12_IRQ 对应的 Cortex-M 异常号（16 + IRQn）。 */
export const ADC12_EXCEPTION = ADC12_IRQ + 16;

/**
 * 中央 `PeripheralModule` 注册项。
 *
 * 两个寄存器区间分开注册，中间 0x5000_0200–0x5000_02FF 保留给未来 ADC3/4/5；
 * 时间行为使用 `PeripheralSlot.Analog`，与 DAC/COMP/OPAMP 共享同一个活动槽。
 * 中断源只声明挂起条件，不在这里清 ADC 标志：HAL 的 handler 通过 ISR 写 1
 * 或读 DR 清除。
 */
export function createAdcModule(): PeripheralModule {
  return {
    id: 'adc12',
    ranges: [
      { base: ADC1_BASE, size: 0x200 },
      { base: ADC12_COMMON_BASE, size: 0x10 },
    ],
    read: readAdcAddress,
    write: writeAdcAddress,
    slot: PeripheralSlot.Analog,
    advance: advanceAdc,
    interrupts: [
      {
        exception: ADC12_EXCEPTION,
        pendingIsPure: true,
        pending: adcIrqPending,
        acknowledge: () => {},
      },
    ],
  };
}

export {
  ADC12_IRQ,
  ADC1_BASE,
  ADC2_BASE,
  ADC12_COMMON_BASE,
  ADC_ISR,
  ADC_IER,
  ADC_CR,
  ADC_CFGR,
  ADC_CFGR2,
  ADC_SMPR1,
  ADC_SMPR2,
  ADC_SQR1,
  ADC_SQR2,
  ADC_SQR3,
  ADC_SQR4,
  ADC_DR,
  ADC_JSQR,
  ADC_CCR,
  ADC_CSR,
  ADC_CDR,
  ADC_DIFSEL,
  ADC_CALFACT,
  ADC_ISR_ADRDY,
  ADC_ISR_EOC,
  ADC_ISR_EOS,
  ADC_ISR_EOSMP,
  ADC_ISR_OVR,
  ADC_CR_ADEN,
  ADC_CR_ADSTART,
  ADC_CR_ADDIS,
  ADC_CR_ADSTP,
  ADC_CR_ADCAL,
  ADC_CR_ADVREGEN,
  ADC_CR_DEEPPWD,
  ADC_CFGR_CONT,
  ADC_CFGR_OVRMOD,
  ADC_CFGR_ALIGN,
  ADC_CFGR_RES_SHIFT,
};
