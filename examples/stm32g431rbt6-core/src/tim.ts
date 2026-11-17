import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  GPIO_SYNC,
  PERIPH,
  IRQ_DIRTY,
  SERVICE_IRQ,
  SERVICE_PIN_SYNC,
  TIM,
  TIM_SIZE,
  TIM_STATE,
  TIM_STATE_STRIDE,
  gpioAfr0State,
  gpioAfr1State,
  gpioModerState,
} from './layout';
import type { AccessSize } from './layout';
import {
  asBody,
  bool,
  boolAnd,
  boolBitAt,
  boolOr,
  markService,
  num,
  readWord,
  readWordAt,
  u32,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import type { AlternateDriver } from './machine';
import { PERIPHERAL_CLOCKS, clockGateEnabled, clockGateResetHeld } from './clock-tree';
import type { ClockGate, PeripheralClockName } from './clock-tree';
import { NO_DEADLINE_PS, setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { InterruptSource, PeripheralModule } from './peripheral';
import { refreshTick } from './tick';

/**
 * STM32G431 TIM1/2/3/4/6/7/8/15/16/17。
 *
 * 支持矩阵（主通道，不冒充互补/死区输出）：
 * - 时基：16/32 位递增/递减、PSC/ARR/CNT、UG、PSC/ARR/CCR 预装载、RCR、OPM；
 * - 对齐：CMS=0 边沿对齐；CMS=1/2/3 为基础中心对齐（0→ARR、ARR→0 两端翻转 DIR，
 *   并按端点/比较事件推进），不区分 CMS 子模式的 UEV/标志细节；
 * - 输入捕获：直接 TIx、CCxS、ICxPSC 基础分频、CCxP/CCxNP 边沿极性、
 *   CCxIF/CCxOF、读 CCR 清 CCxIF；
 * - 输出比较：OC1M=000–111（冻结/置位/清零/翻转/PWM1/PWM2），CCxE/CCxP、
 *   BDTR.MOE 对高级定时器输出的门控；
 * - 中断：DIER/SR/EGR 与真实 IRQ 线。
 *
 * 明确不建模：编码器/从模式/外部时钟、输入滤波、间接/交叉捕获映射、break 输入、
 * DMA 请求、死区/互补输出、TIM1/8 的 CH5/CH6。
 * TIM6/7 只有更新计数；TIM15/16/17 的通道数、MOE 与 RCR 与真实实例不同，本表按
 * 实例分别声明。ARR 的硬件复位值不是 0，因此首次访问时惰性初始化，而不是相信 DDL
 * memory 的零填充。
 *
 * 时间用整数皮秒累计：每个定时器保存绝对 `lastPs` 和不足一个 CK_PSC 周期的余量。
 * 这样跨多次溢出、停止/重新使能都不会把旧时间算给新配置。默认时钟是
 * `machine().clockFrequency`；`setTimerClockProvider` 留给后续 RCC/APB 倍频接入。
 */

const CR1 = 0x00;
const CR2 = 0x04;
const SMCR = 0x08;
const DIER = 0x0c;
const SR = 0x10;
const EGR = 0x14;
const CCMR1 = 0x18;
const CCMR2 = 0x1c;
const CCER = 0x20;
const CNT = 0x24;
const PSC = 0x28;
const ARR = 0x2c;
const RCR = 0x30;
const CCR1 = 0x34;
const CCR2 = 0x38;
const CCR3 = 0x3c;
const CCR4 = 0x40;
const BDTR = 0x44;

export const TIM1_BASE = 0x40012c00;
export const TIM8_BASE = 0x40013400;
export const TIM15_BASE = 0x40014000;
export const TIM16_BASE = 0x40014400;
export const TIM17_BASE = 0x40014800;

export const TIMER_SIZE = 0x400;
/** 每个实例在 `tim` memory 中的寄存器窗口：0x00–0x47，正好覆盖到 BDTR。 */
export const TIMER_REGISTER_STRIDE = 0x48;
const CR1_CEN = 1 << 0;
const CR1_UDIS = 1 << 1;
const CR1_URS = 1 << 2;
const CR1_OPM = 1 << 3;
const CR1_DIR = 1 << 4;
const CR1_ARPE = 1 << 7;

const DIER_UIE = 1 << 0;
const DIER_CC1IE = 1 << 1;
const DIER_CC2IE = 1 << 2;
const DIER_CC3IE = 1 << 3;
const DIER_CC4IE = 1 << 4;
const DIER_COMIE = 1 << 5;
const DIER_TIE = 1 << 6;
const DIER_BIE = 1 << 7;

const SR_UIF = 1 << 0;
const SR_CC1IF = 1 << 1;
const SR_CC2IF = 1 << 2;
const SR_CC3IF = 1 << 3;
const SR_CC4IF = 1 << 4;
const SR_COMIF = 1 << 5;
const SR_TIF = 1 << 6;
const SR_BIF = 1 << 7;
const SR_CC1OF = 1 << 9;
const SR_CC2OF = 1 << 10;
const SR_CC3OF = 1 << 11;
const SR_CC4OF = 1 << 12;

const EGR_UG = 1 << 0;
const EGR_COMG = 1 << 5;
const EGR_TG = 1 << 6;
const EGR_BG = 1 << 7;

const BDTR_MOE = 1 << 15;

const CCR_OFFSETS = [CCR1, CCR2, CCR3, CCR4] as const;
const CCR_FLAGS = [SR_CC1IF, SR_CC2IF, SR_CC3IF, SR_CC4IF] as const;
const CCR_OVERCAPTURE = [SR_CC1OF, SR_CC2OF, SR_CC3OF, SR_CC4OF] as const;

export type TimerKind = 'advanced' | 'general' | 'basic';

export interface TimerPin {
  readonly name: string;
  readonly port: number;
  readonly pin: number;
  readonly af: number;
  readonly channel: number;
}

export interface TimerIrqLine {
  readonly irq: number;
  /** SR 中哪些标志会驱动这条 IRQ；同名使能位在 DIER 中。 */
  readonly flags: number;
}

export interface TimerConfig {
  readonly index: number;
  readonly name: string;
  readonly base: number;
  readonly kind: TimerKind;
  readonly bits: 16 | 32;
  readonly channels: number;
  readonly hasRcr: boolean;
  readonly hasBdtr: boolean;
  readonly hasCcmr3: boolean;
  /** `tim` memory 中的实例槽位。 */
  readonly memoryIndex: number;
  readonly irqLines: readonly TimerIrqLine[];
  /** 主通道（非互补）外部引脚；输入捕获也使用同一张表。 */
  readonly pins: readonly TimerPin[];
  readonly statePrefix: string;
}

const pin = (name: string, af: number, channel: number): TimerPin => {
  const port = name.charCodeAt(1) - 'A'.charCodeAt(0);

  return { name, port, pin: Number(name.slice(2)), af, channel };
};

const oneLine = (irq: number, flags: number): readonly TimerIrqLine[] => [{ irq, flags }];

const advancedLines = (base: number): readonly TimerIrqLine[] => [
  { irq: base, flags: SR_BIF },
  { irq: base + 1, flags: SR_UIF },
  { irq: base + 2, flags: SR_COMIF | SR_TIF },
  { irq: base + 3, flags: SR_CC1IF | SR_CC2IF | SR_CC3IF | SR_CC4IF },
];

/**
 * 真实 G431 实例表。TIM8 与 TIM1 共用高级定时器实现；LPTIM1 的寄存器/行为不是通用
 * TIM 布局，不在这里冒充。
 */
export const TIMERS: readonly TimerConfig[] = [
  {
    index: 1,
    name: 'TIM1',
    base: TIM1_BASE,
    kind: 'advanced',
    bits: 16,
    channels: 4,
    hasRcr: true,
    hasBdtr: true,
    hasCcmr3: true,
    memoryIndex: 0,
    irqLines: advancedLines(24),
    pins: [
      pin('PA8', 6, 1),
      pin('PA9', 6, 2),
      pin('PA10', 6, 3),
      pin('PA11', 6, 4),
      pin('PC0', 2, 1),
      pin('PC1', 2, 2),
      pin('PC2', 2, 3),
      pin('PC3', 2, 4),
    ],
    statePrefix: 'tim1',
  },
  {
    index: 2,
    name: 'TIM2',
    base: 0x40000000,
    kind: 'general',
    bits: 32,
    channels: 4,
    hasRcr: false,
    hasBdtr: false,
    hasCcmr3: false,
    memoryIndex: 1,
    irqLines: oneLine(28, SR_UIF | SR_CC1IF | SR_CC2IF | SR_CC3IF | SR_CC4IF | SR_TIF),
    pins: [
      pin('PA0', 1, 1),
      pin('PA1', 1, 2),
      pin('PA2', 1, 3),
      pin('PA3', 1, 4),
      pin('PA5', 1, 1),
      pin('PA15', 1, 1),
      pin('PB3', 1, 2),
      pin('PB10', 1, 3),
      pin('PB11', 1, 4),
    ],
    statePrefix: 'tim2',
  },
  {
    index: 3,
    name: 'TIM3',
    base: 0x40000400,
    kind: 'general',
    bits: 16,
    channels: 4,
    hasRcr: false,
    hasBdtr: false,
    hasCcmr3: false,
    memoryIndex: 2,
    irqLines: oneLine(29, SR_UIF | SR_CC1IF | SR_CC2IF | SR_CC3IF | SR_CC4IF | SR_TIF),
    pins: [
      pin('PA6', 2, 1),
      pin('PA7', 2, 2),
      pin('PB0', 2, 3),
      pin('PB1', 2, 4),
      pin('PB4', 2, 1),
      pin('PB5', 2, 2),
      pin('PC6', 2, 1),
      pin('PC7', 2, 2),
      pin('PC8', 2, 3),
      pin('PC9', 2, 4),
    ],
    statePrefix: 'tim3',
  },
  {
    index: 4,
    name: 'TIM4',
    base: 0x40000800,
    kind: 'general',
    bits: 16,
    channels: 4,
    hasRcr: false,
    hasBdtr: false,
    hasCcmr3: false,
    memoryIndex: 3,
    irqLines: oneLine(30, SR_UIF | SR_CC1IF | SR_CC2IF | SR_CC3IF | SR_CC4IF | SR_TIF),
    pins: [pin('PB6', 2, 1), pin('PB7', 2, 2), pin('PB8', 2, 3), pin('PB9', 2, 4)],
    statePrefix: 'tim4',
  },
  {
    index: 6,
    name: 'TIM6',
    base: 0x40001000,
    kind: 'basic',
    bits: 16,
    channels: 0,
    hasRcr: false,
    hasBdtr: false,
    hasCcmr3: false,
    memoryIndex: 4,
    irqLines: oneLine(54, SR_UIF),
    pins: [],
    statePrefix: 'tim6',
  },
  {
    index: 7,
    name: 'TIM7',
    base: 0x40001400,
    kind: 'basic',
    bits: 16,
    channels: 0,
    hasRcr: false,
    hasBdtr: false,
    hasCcmr3: false,
    memoryIndex: 5,
    irqLines: oneLine(55, SR_UIF),
    pins: [],
    statePrefix: 'tim7',
  },
  {
    index: 8,
    name: 'TIM8',
    base: TIM8_BASE,
    kind: 'advanced',
    bits: 16,
    channels: 4,
    hasRcr: true,
    hasBdtr: true,
    hasCcmr3: true,
    memoryIndex: 6,
    irqLines: advancedLines(43),
    pins: [pin('PC6', 4, 1), pin('PC7', 4, 2), pin('PC8', 4, 3), pin('PC9', 4, 4)],
    statePrefix: 'tim8',
  },
  {
    index: 15,
    name: 'TIM15',
    base: TIM15_BASE,
    kind: 'advanced',
    bits: 16,
    channels: 2,
    hasRcr: true,
    hasBdtr: true,
    hasCcmr3: false,
    memoryIndex: 7,
    irqLines: oneLine(24, SR_UIF | SR_CC1IF | SR_CC2IF | SR_COMIF | SR_TIF | SR_BIF),
    pins: [pin('PA2', 9, 1), pin('PA3', 9, 2), pin('PB14', 1, 1), pin('PB15', 1, 2)],
    statePrefix: 'tim15',
  },
  {
    index: 16,
    name: 'TIM16',
    base: TIM16_BASE,
    kind: 'advanced',
    bits: 16,
    channels: 1,
    hasRcr: true,
    hasBdtr: true,
    hasCcmr3: false,
    memoryIndex: 8,
    irqLines: oneLine(25, SR_UIF | SR_CC1IF | SR_COMIF | SR_TIF | SR_BIF),
    pins: [pin('PA6', 1, 1), pin('PB8', 1, 1)],
    statePrefix: 'tim16',
  },
  {
    index: 17,
    name: 'TIM17',
    base: TIM17_BASE,
    kind: 'advanced',
    bits: 16,
    channels: 1,
    hasRcr: true,
    hasBdtr: true,
    hasCcmr3: false,
    memoryIndex: 9,
    irqLines: oneLine(26, SR_UIF | SR_CC1IF | SR_COMIF | SR_TIF | SR_BIF),
    pins: [pin('PA7', 1, 1), pin('PB9', 1, 1)],
    statePrefix: 'tim17',
  },
];

export const TIMER_COUNT = TIMERS.length;
export const TIMER_MEMORY_SIZE = TIMER_COUNT * TIMER_REGISTER_STRIDE;

if (TIMER_MEMORY_SIZE > TIM_SIZE)
  throw new Error(
    `stm32g431rbt6: timer registers need 0x${TIMER_MEMORY_SIZE.toString(16)} bytes, tim memory has 0x${TIM_SIZE.toString(16)}`,
  );

export interface TimerCaptureInput {
  readonly config: TimerConfig;
  readonly channel: number;
  readonly pin: TimerPin;
}

/**
 * 描述表里所有可做捕获输入的引脚。精确边沿由中央引脚观察 hook 调用
 * `observeTimerInputByPin` 送入；这里不再另维护两条硬编码通道。
 */
export const TIMER_CAPTURE_INPUTS: readonly TimerCaptureInput[] = TIMERS.flatMap((config) =>
  config.pins.map((pin) => ({ config, channel: pin.channel, pin })),
);

export function timerCaptureInputs(): readonly TimerCaptureInput[] {
  return TIMER_CAPTURE_INPUTS;
}

/** 中央接线用：去重后的可捕获引脚名（PA15/PB4 等）。 */
export function timerCapturePinNames(): readonly string[] {
  return [...new Set(TIMER_CAPTURE_INPUTS.map((input) => input.pin.name))];
}

/** 中央接线用：某个真实引脚映射到的所有捕获通道。 */
export function timerCaptureInputsOnPin(pinName: string): readonly TimerCaptureInput[] {
  return TIMER_CAPTURE_INPUTS.filter((input) => input.pin.name === pinName);
}

const timerClockName = (config: TimerConfig): PeripheralClockName =>
  `tim${config.index}` as PeripheralClockName;

const gpioClockName = (port: number): PeripheralClockName =>
  `gpio${String.fromCharCode('A'.charCodeAt(0) + port)}` as PeripheralClockName;

/** 中央 DDL/adapter 生成 armed 门控所需的纯描述字段；不包含 timer 算法。 */
export interface TimerCaptureGateDescriptor {
  readonly pinId: number;
  readonly pinName: string;
  readonly port: number;
  readonly pin: number;
  readonly af: number;
  readonly timerName: string;
  readonly timerIndex: number;
  readonly channel: number;
  readonly timerMemoryOffset: number;
  readonly cr1Offset: number;
  readonly ccmrOffset: number;
  readonly ccxsShift: number;
  readonly ccerOffset: number;
  readonly ccerShift: number;
  readonly moderState: string;
  readonly moderShift: number;
  readonly afrState: string;
  readonly afrShift: number;
  readonly timerClockGate: ClockGate;
  readonly gpioClockGate: ClockGate;
}

const CAPTURE_PIN_IDS = new Map(timerCapturePinNames().map((name, index) => [name, index]));

/**
 * 从 `TIMER_CAPTURE_INPUTS` 派生的全部捕获门控描述。`pinId` 与
 * `timerCapturePinNames()` 的下标一致；中央只消费当前接线的 PA15/PB4 即可。
 * DDL 可用这些字段生成纯 `captureArmed(pinId)`，不要另写 TIM/GPIO 位域。
 */
export function timerCaptureGateDescriptors(): readonly TimerCaptureGateDescriptor[] {
  return TIMER_CAPTURE_INPUTS.map((input) => {
    const { config, channel, pin } = input;

    return {
      pinId: CAPTURE_PIN_IDS.get(pin.name)!,
      pinName: pin.name,
      port: pin.port,
      pin: pin.pin,
      af: pin.af,
      timerName: config.name,
      timerIndex: config.index,
      channel,
      timerMemoryOffset: config.memoryIndex * TIMER_REGISTER_STRIDE,
      cr1Offset: CR1,
      ccmrOffset: channel <= 2 ? CCMR1 : CCMR2,
      ccxsShift: ((channel - 1) % 2) * 8,
      ccerOffset: CCER,
      ccerShift: (channel - 1) * 4,
      moderState: gpioModerState(pin.port),
      moderShift: pin.pin * 2,
      afrState: pin.pin < 8 ? gpioAfr0State(pin.port) : gpioAfr1State(pin.port),
      afrShift: (pin.pin & 7) * 4,
      timerClockGate: PERIPHERAL_CLOCKS[timerClockName(config)],
      gpioClockGate: PERIPHERAL_CLOCKS[gpioClockName(pin.port)],
    };
  });
}

const maskOf = (config: TimerConfig): number => (config.bits === 32 ? 0xffffffff : 0xffff);

const stateName = (config: TimerConfig, field: string): string => `${config.statePrefix}${field}`;
const readS = (b: Body, config: TimerConfig, field: string): Value<number> =>
  b.readState(stateName(config, field), types.number);
const writeS = (b: Body, config: TimerConfig, field: string, value: Value<number>): void => {
  // LastPs/AccumPs 是绝对/余量 ps，必须保持 number 安全整数；不能走 u32，
  // 否则 2^32 ps (4.294967296 ms) 后会回卷。
  const timeField = field === 'LastPs' || field === 'AccumPs';

  b.writeState(stateName(config, field), timeField ? value : u32(b, value));
};

const timerOffset = (config: TimerConfig): number => config.memoryIndex * TIMER_REGISTER_STRIDE;

const loadReg = (b: Body, config: TimerConfig, offset: number): Value<number> =>
  u32(b, readWordAt(b, TIM, timerOffset(config) + offset));
const storeReg = (b: Body, config: TimerConfig, offset: number, value: Value<number>): void =>
  writeWordAt(b, TIM, timerOffset(config) + offset, u32(b, value));

const hotBase = (config: TimerConfig): number => TIM_STATE + config.memoryIndex * TIM_STATE_STRIDE;

const loadHot = (b: Body, config: TimerConfig, word: number): Value<number> =>
  u32(b, readWordAt(b, PERIPH, hotBase(config) + word * 4));

const storeHot = (b: Body, config: TimerConfig, word: number, value: Value<number>): void =>
  writeWordAt(b, PERIPH, hotBase(config) + word * 4, u32(b, value));

const ccrHot = (config: TimerConfig, channel: number): number => channel - 1;

const outHot = (config: TimerConfig, channel: number): number => 4 + channel - 1;

const readOutRaw = (b: Body, config: TimerConfig, channel: number): Value<number> =>
  loadHot(b, config, outHot(config, channel));

const writeOutRaw = (b: Body, config: TimerConfig, channel: number, value: Value<number>): void =>
  storeHot(b, config, outHot(config, channel), value);

const readCcrActive = (b: Body, config: TimerConfig, channel: number): Value<number> =>
  loadHot(b, config, ccrHot(config, channel));

const writeCcrActive = (
  b: Body,
  config: TimerConfig,
  channel: number,
  value: Value<number>,
): void => storeHot(b, config, ccrHot(config, channel), value);

const bits = (b: Body, value: Value<number>, shift: number, width: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(value, num(b, shift)), num(b, (1 << width) - 1));

const extract = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
};

const placedValue = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
};

const mergeWord = (
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
};

/** 运行期偏移的 if/else 分派；每个 arm 的 offset 在翻译期已知。 */
interface WordArm {
  readonly offset: number;
  readonly emit: (body: Body) => void;
}

function dispatchWord(
  b: Body,
  offset: Value<number>,
  arms: readonly WordArm[],
  otherwise?: (body: Body) => void,
): void {
  const step = (body: Body, index: number): void => {
    const arm = arms[index];

    if (arm === undefined) {
      otherwise?.(body);

      return;
    }

    body.if(
      body.equal(types.number, offset, num(body, arm.offset)),
      (hit) => arm.emit(asBody(hit)),
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

/** 静态地址已在翻译期命中唯一 register；只 emit 该 arm，不构造其它分支 IR。 */
function dispatchStaticWord(
  b: Body,
  offset: number,
  arms: readonly WordArm[],
  otherwise?: (body: Body) => void,
): void {
  const arm = arms.find((candidate) => candidate.offset === offset);

  if (arm !== undefined) arm.emit(b);
  else otherwise?.(b);
}

export const TIM_CEN_MASK_STATE = 'timCenMask';
export const TIM_CAPTURE_MASK_STATE = 'timCaptureMask';
export const TIMER_SLOT = 0;

/** 定时器时基时钟（Hz）；后续 RCC 可以通过 provider 接入 APB 倍频。 */
export type TimerClockProvider = (b: Body, config: TimerConfig) => Value<number>;

let clockProvider: TimerClockProvider | undefined;

export function setTimerClockProvider(provider: TimerClockProvider | undefined): void {
  clockProvider = provider;
}

function timerClockPs(b: Body, config: TimerConfig): Value<number> {
  const hz = clockProvider?.(b, config) ?? num(b, machine().clockFrequency);

  return b.select(
    types.number,
    b.greaterThan(hz, num(b, 0)),
    (running) => {
      const period = running.floor(
        running.divide(running.constant(types.number, 1_000_000_000_000), hz),
      );

      return running.select(
        types.number,
        running.greaterThan(period, running.constant(types.number, 0)),
        () => period,
        (inner) => inner.constant(types.number, 1),
      );
    },
    (stopped) => stopped.constant(types.number, 0),
  );
}

export const timerActive = (b: Body): Value<boolean> =>
  b.notEqual(types.number, b.readState(TIM_CEN_MASK_STATE, types.number), num(b, 0));

export function timerConfigAt(address: number): TimerConfig | undefined {
  for (const config of TIMERS)
    if (address >= config.base && address < config.base + TIMER_SIZE) return config;

  return undefined;
}

export function timerChannelCount(config: TimerConfig): number {
  return config.channels;
}

function ensureTimer(b: Body, config: TimerConfig): void {
  b.if(b.equal(types.number, readS(b, config, 'Ready'), num(b, 0)), (fresh) => {
    const body = asBody(fresh);
    const reset = maskOf(config);

    storeReg(body, config, ARR, num(body, reset));
    writeS(body, config, 'ArrActive', num(body, reset));
    writeS(body, config, 'PscActive', num(body, 0));
    writeS(body, config, 'LastPs', body.now());
    writeS(body, config, 'AccumPs', num(body, 0));
    writeS(body, config, 'Presc', num(body, 0));
    writeS(body, config, 'Rep', num(body, 0));
    writeS(body, config, 'Ready', num(body, 1));

    for (let channel = 1; channel <= config.channels; channel += 1) {
      writeCcrActive(body, config, channel, num(body, 0));
      writeS(body, config, `Cap${channel}`, num(body, 0));
      writeOutRaw(body, config, channel, num(body, 0));
      writeS(body, config, `Out${channel}`, num(body, 0));
    }
  });
}

function syncTimerAt(b: Body, config: TimerConfig, target: Value<number>): void {
  b.if(boolBitAt(b, loadReg(b, config, CR1), 0), (running) => {
    const body = asBody(running);
    const delta = body.subtract(target, readS(body, config, 'LastPs'));

    body.if(body.greaterThan(delta, num(body, 0)), (positive) => {
      const scope = asBody(positive);
      const clockPs = timerClockPs(scope, config);

      scope.if(
        scope.greaterThan(clockPs, num(scope, 0)),
        (clocked) => {
          const inner = asBody(clocked);
          const total = inner.add(readS(inner, config, 'AccumPs'), delta);
          const cycles = inner.floor(inner.divide(total, clockPs));

          writeS(inner, config, 'AccumPs', inner.subtract(total, inner.multiply(cycles, clockPs)));
          writeS(inner, config, 'LastPs', target);
          inner.if(inner.greaterThan(cycles, num(inner, 0)), (tick) =>
            advanceCounter(asBody(tick), config, cycles),
          );
        },
        (stopped) => {
          const inner = asBody(stopped);

          writeS(inner, config, 'AccumPs', num(inner, 0));
          writeS(inner, config, 'LastPs', target);
        },
      );
    });
  });
}

function isCenterAligned(b: Body, cr1: Value<number>): Value<boolean> {
  return b.notEqual(types.number, b.bitAnd(cr1, num(b, 0x60)), num(b, 0));
}

/**
 * 把 `cycles` 个 CK_PSC 周期推进到计数器。循环在每次预装载更新处切分，因此新
 * ARR/PSC/CCR 会影响更新之后的余下时间；OPM 在第一次真正生效的更新处停止。
 * 中心对齐时在 ARR/0 两端翻转方向，每个端点都是一次潜在更新。
 */
function advanceCounter(b: Body, config: TimerConfig, cycles: Value<number>): void {
  const remaining = b.local(types.number, cycles);
  const stopped = b.local(types.bool, false);
  const HUGE = 0x7fffffff;

  b.while(
    (test) => test.greaterThan(test.getLocal(remaining), test.constant(types.number, 0)),
    (loop) => {
      const body = asBody(loop);
      const cr1 = loadReg(body, config, CR1);
      const center = isCenterAligned(body, cr1);
      const down = boolBitAt(body, cr1, 4);
      const udis = boolBitAt(body, cr1, 1);
      const pscActive = readS(body, config, 'PscActive');
      const pscPeriod = body.add(pscActive, num(body, 1));
      const presc = readS(body, config, 'Presc');
      const toCount = body.subtract(pscPeriod, presc);
      const current = body.getLocal(remaining);

      body.if(
        body.lessThan(current, toCount),
        (short) => {
          const body2 = asBody(short);

          writeS(body2, config, 'Presc', body2.add(presc, current));
          body2.setLocal(remaining, num(body2, 0));
        },
        (enough) => {
          const body2 = asBody(enough);
          const afterFirst = body2.subtract(current, toCount);
          const additional = body2.floor(body2.divide(afterFirst, pscPeriod));
          const available = body2.add(additional, num(body2, 1));
          const cnt = u32(
            body2,
            body2.bitAnd(loadReg(body2, config, CNT), num(body2, maskOf(config))),
          );
          const arr = u32(body2, readS(body2, config, 'ArrActive'));
          const period = body2.add(arr, num(body2, 1));
          const rcr = config.hasRcr
            ? body2.bitAnd(loadReg(body2, config, RCR), num(body2, 0xff))
            : body2.constant(types.number, 0);
          const repRaw = readS(body2, config, 'Rep');
          const rep = body2.select(
            types.number,
            body2.greaterThan(repRaw, rcr),
            () => rcr,
            () => repRaw,
          );
          const firstWrap = body2.select(
            types.number,
            down,
            (inner) => inner.add(cnt, inner.constant(types.number, 1)),
            (inner) => inner.subtract(period, cnt),
          );
          const turnsToUpdate = body2.subtract(body2.add(rcr, num(body2, 1)), rep);
          const edgeSteps = body2.add(
            firstWrap,
            body2.multiply(body2.subtract(turnsToUpdate, num(body2, 1)), period),
          );
          const turnDistance = body2.select(
            types.number,
            down,
            (inner) =>
              inner.select(
                types.number,
                inner.equal(types.number, arr, inner.constant(types.number, 0)),
                (empty) => empty.constant(types.number, 1),
                (normal) =>
                  normal.select(
                    types.number,
                    normal.greaterThan(cnt, normal.constant(types.number, 0)),
                    () => cnt,
                    (zero) => zero.constant(types.number, 0),
                  ),
              ),
            (inner) =>
              inner.select(
                types.number,
                inner.equal(types.number, arr, inner.constant(types.number, 0)),
                (empty) => empty.constant(types.number, 1),
                (normal) =>
                  normal.select(
                    types.number,
                    normal.greaterThan(arr, cnt),
                    (positive) => positive.subtract(arr, cnt),
                    (boundary) => boundary.constant(types.number, 0),
                  ),
              ),
          );
          const stepsToUpdate = body2.select(
            types.number,
            center,
            () => turnDistance,
            (edgeBranch) =>
              edgeBranch.select(
                types.number,
                udis,
                (inner) => inner.constant(types.number, HUGE),
                () => edgeSteps,
              ),
          );
          const chunk = body2.select(
            types.number,
            body2.lessThan(available, stepsToUpdate),
            () => available,
            () => stepsToUpdate,
          );

          const upTotal = body2.add(cnt, chunk);
          const upWraps = body2.floor(body2.divide(upTotal, period));
          const upNext = body2.subtract(upTotal, body2.multiply(upWraps, period));
          const distance = body2.subtract(chunk, cnt);
          const downWraps = body2.select(
            types.number,
            body2.greaterThan(distance, num(body2, 0)),
            (inner) => {
              const innerBody = asBody(inner);
              const raw = innerBody.subtract(innerBody.add(distance, period), num(innerBody, 1));

              return innerBody.floor(innerBody.divide(raw, period));
            },
            (inner) => inner.constant(types.number, 0),
          );
          const downNext = body2.add(body2.subtract(cnt, chunk), body2.multiply(downWraps, period));
          const wraps = body2.select(
            types.number,
            down,
            () => downWraps,
            () => upWraps,
          );
          const next = body2.select(
            types.number,
            down,
            () => downNext,
            () => upNext,
          );

          storeReg(body2, config, CNT, body2.bitAnd(next, num(body2, maskOf(config))));

          for (let channel = 1; channel <= config.channels; channel += 1)
            body2.if(
              body2.equal(types.number, captureSelection(body2, config, channel), num(body2, 0)),
              (output) => {
                const body3 = asBody(output);
                const count = compareMatchCount(body3, config, channel, cnt, chunk, down);

                body3.if(body3.greaterThan(count, num(body3, 0)), (hit) => {
                  const body4 = asBody(hit);

                  setTimerFlag(body4, config, CCR_FLAGS[channel - 1]!);
                  applyMatchLevel(body4, config, channel, count);
                });
              },
            );

          body2.if(
            body2.equal(types.number, chunk, stepsToUpdate),
            (event) => {
              const body3 = asBody(event);
              const consumed = body3.greaterThan(chunk, num(body3, 0));
              const leftover = body3.subtract(
                afterFirst,
                body3.multiply(body3.subtract(chunk, num(body3, 1)), pscPeriod),
              );
              const updateNow = boolAnd(
                body3,
                body3.not(udis),
                body3.select(
                  types.bool,
                  center,
                  (inner) => inner.greaterThanOrEqual(rep, rcr),
                  (inner) => inner.constant(types.bool, true),
                ),
              );

              body3.if(
                updateNow,
                (update) => {
                  const body4 = asBody(update);

                  loadPreloadShadows(body4, config);
                  writeS(body4, config, 'Presc', num(body4, 0));
                  writeS(body4, config, 'Rep', num(body4, 0));
                  setTimerFlag(body4, config, SR_UIF);

                  body4.if(boolBitAt(body4, cr1, 3), (onePulse) => {
                    const body5 = asBody(onePulse);

                    storeReg(
                      body5,
                      config,
                      CR1,
                      body5.bitAnd(loadReg(body5, config, CR1), num(body5, ~CR1_CEN & 0xffffffff)),
                    );
                    clearCenMask(body5, config);
                    wakeTimer(body5);
                    body5.setLocal(remaining, num(body5, 0));
                    body5.setLocal(stopped, bool(body5, true));
                  });
                },
                (noUpdate) => {
                  const body4 = asBody(noUpdate);

                  body4.if(center, (centerBody) => {
                    const body5 = asBody(centerBody);

                    writeS(body5, config, 'Rep', body5.add(rep, num(body5, 1)));
                  });
                },
              );

              body3.if(center, (centerBody) => {
                const body4 = asBody(centerBody);
                const old = loadReg(body4, config, CR1);

                // ARR 与 0 两端都翻转 DIR；DIR 是固件可读的真实方向位。
                storeReg(body4, config, CR1, body4.bitXor(old, num(body4, 0x10)));
              });

              body3.if(consumed, (moved) => {
                const body4 = asBody(moved);

                body4.setLocal(remaining, leftover);
                writeS(body4, config, 'Presc', num(body4, 0));
              });
            },
            (noEvent) => {
              const body3 = asBody(noEvent);
              const leftover = body3.subtract(
                afterFirst,
                body3.multiply(body3.subtract(chunk, num(body3, 1)), pscPeriod),
              );

              writeS(body3, config, 'Presc', leftover);
              body3.setLocal(remaining, num(body3, 0));
              body3.if(
                center,
                () => {},
                (edge) => {
                  const body4 = asBody(edge);

                  writeS(body4, config, 'Rep', body4.add(rep, wraps));
                },
              );
            },
          );
        },
      );
    },
  );

  if (config.channels > 0) publishOutputCache(b, config);
}

function applyMatchLevel(
  b: Body,
  config: TimerConfig,
  channel: number,
  count: Value<number>,
): void {
  const mode = ocMode(b, config, channel);
  const old = readOutRaw(b, config, channel);

  b.if(b.equal(types.number, mode, num(b, 1)), (set) =>
    writeOutRaw(asBody(set), config, channel, num(asBody(set), 1)),
  );
  b.if(b.equal(types.number, mode, num(b, 2)), (clear) =>
    writeOutRaw(asBody(clear), config, channel, num(asBody(clear), 0)),
  );
  b.if(b.equal(types.number, mode, num(b, 3)), (toggle) => {
    const body = asBody(toggle);
    const parity = body.bitAnd(count, num(body, 1));

    writeOutRaw(
      body,
      config,
      channel,
      body.select(
        types.number,
        body.equal(types.number, parity, num(body, 0)),
        () => old,
        (odd) =>
          odd.select(
            types.number,
            odd.notEqual(types.number, old, odd.constant(types.number, 0)),
            (one) => one.constant(types.number, 0),
            (zero) => zero.constant(types.number, 1),
          ),
      ),
    );
  });
}

function compareMatchCount(
  b: Body,
  config: TimerConfig,
  channel: number,
  previous: Value<number>,
  steps: Value<number>,
  down: Value<boolean>,
): Value<number> {
  const ccr = readCcrActive(b, config, channel);
  const arr = u32(b, readS(b, config, 'ArrActive'));
  const period = b.add(arr, num(b, 1));
  const end = b.select(
    types.number,
    down,
    (inner) => inner.subtract(previous, steps),
    (inner) => inner.add(previous, steps),
  );
  const matches = b.select(
    types.number,
    down,
    (inner) =>
      inner.subtract(
        inner.ceil(inner.divide(inner.subtract(previous, ccr), period)),
        inner.ceil(inner.divide(inner.subtract(end, ccr), period)),
      ),
    (inner) =>
      inner.subtract(
        inner.floor(inner.divide(inner.subtract(end, ccr), period)),
        inner.floor(inner.divide(inner.subtract(previous, ccr), period)),
      ),
  );

  return b.select(
    types.number,
    b.lessThan(ccr, period),
    () => matches,
    (invalid) => invalid.constant(types.number, 0),
  );
}

function captureSelection(b: Body, config: TimerConfig, channel: number): Value<number> {
  const shift = channel <= 2 ? (channel % 2 === 1 ? 0 : 8) : channel % 2 === 1 ? 0 : 8;
  const register = channel <= 2 ? CCMR1 : CCMR2;

  return bits(b, loadReg(b, config, register), shift, 2);
}

function ocMode(b: Body, config: TimerConfig, channel: number): Value<number> {
  const shift = channel <= 2 ? (channel % 2 === 1 ? 4 : 12) : channel % 2 === 1 ? 4 : 12;
  const register = channel <= 2 ? CCMR1 : CCMR2;

  return bits(b, loadReg(b, config, register), shift, 3);
}

function preloadEnabled(b: Body, config: TimerConfig, channel: number): Value<boolean> {
  const shift = channel <= 2 ? (channel % 2 === 1 ? 3 : 11) : channel % 2 === 1 ? 3 : 11;
  const register = channel <= 2 ? CCMR1 : CCMR2;

  return boolBitAt(b, loadReg(b, config, register), shift);
}

function loadPreloadShadows(b: Body, config: TimerConfig): void {
  writeS(b, config, 'PscActive', b.bitAnd(loadReg(b, config, PSC), num(b, 0xffff)));
  writeS(b, config, 'ArrActive', b.bitAnd(loadReg(b, config, ARR), num(b, maskOf(config))));

  for (let channel = 1; channel <= config.channels; channel += 1)
    writeCcrActive(
      b,
      config,
      channel,
      b.bitAnd(loadReg(b, config, CCR_OFFSETS[channel - 1]!), num(b, maskOf(config))),
    );
}

function setTimerFlag(b: Body, config: TimerConfig, flag: number): void {
  storeReg(b, config, SR, b.bitOr(loadReg(b, config, SR), num(b, flag)));
  b.if(
    b.notEqual(types.number, b.bitAnd(loadReg(b, config, DIER), num(b, flag)), num(b, 0)),
    (enabled) => {
      const body = asBody(enabled);

      body.writeState(IRQ_DIRTY, bool(body, true));
      markService(body, SERVICE_IRQ);
    },
  );
}

function setCenMask(b: Body, config: TimerConfig): void {
  const bit = 1 << config.memoryIndex;

  b.writeState(
    TIM_CEN_MASK_STATE,
    b.bitOr(b.readState(TIM_CEN_MASK_STATE, types.number), num(b, bit)),
  );
}

function clearCenMask(b: Body, config: TimerConfig): void {
  const bit = 1 << config.memoryIndex;

  b.writeState(
    TIM_CEN_MASK_STATE,
    b.bitAnd(b.readState(TIM_CEN_MASK_STATE, types.number), num(b, ~bit & 0xffffffff)),
  );
}

const MAX_DEADLINE_PS = 0xffffffff;
const NO_DEADLINE = 0x1_0000_0000;

/** 到下一次比较、溢出/更新或中心对齐端点的整数皮秒；0 表示没有未来事件。 */
export function nextTimerDeadlinePs(b: Body): Value<number> {
  const best = b.local(types.number, NO_DEADLINE);
  const found = b.local(types.bool, false);

  for (const config of TIMERS) {
    const bit = 1 << config.memoryIndex;

    b.if(
      b.notEqual(
        types.number,
        b.bitAnd(b.readState(TIM_CEN_MASK_STATE, types.number), num(b, bit)),
        num(b, 0),
      ),
      (active) => {
        const body = asBody(active);
        const clockPs = timerClockPs(body, config);

        body.if(body.greaterThan(clockPs, num(body, 0)), (clocked) => {
          const scope = asBody(clocked);
          const cr1 = loadReg(scope, config, CR1);
          const down = boolBitAt(scope, cr1, 4);
          const center = isCenterAligned(scope, cr1);
          const udis = boolBitAt(scope, cr1, 1);
          const pscActive = readS(scope, config, 'PscActive');
          const pscPeriod = scope.add(pscActive, num(scope, 1));
          const presc = readS(scope, config, 'Presc');
          const accum = readS(scope, config, 'AccumPs');
          const firstCount = scope.subtract(
            scope.multiply(scope.subtract(pscPeriod, presc), clockPs),
            accum,
          );
          const tickPeriod = scope.multiply(pscPeriod, clockPs);
          const cnt = u32(
            scope,
            scope.bitAnd(loadReg(scope, config, CNT), num(scope, maskOf(config))),
          );
          const arr = u32(scope, readS(scope, config, 'ArrActive'));
          const period = scope.add(arr, num(scope, 1));
          const rcr = config.hasRcr
            ? scope.bitAnd(loadReg(scope, config, RCR), num(scope, 0xff))
            : scope.constant(types.number, 0);
          const repRaw = readS(scope, config, 'Rep');
          const rep = scope.select(
            types.number,
            scope.greaterThan(repRaw, rcr),
            () => rcr,
            () => repRaw,
          );
          const turnsToUpdate = scope.subtract(scope.add(rcr, num(scope, 1)), rep);
          const firstWrap = scope.select(
            types.number,
            down,
            (inner) => inner.add(cnt, inner.constant(types.number, 1)),
            (inner) => inner.subtract(period, cnt),
          );
          const turnDistance = scope.select(
            types.number,
            down,
            (inner) =>
              inner.select(
                types.number,
                inner.equal(types.number, arr, inner.constant(types.number, 0)),
                (empty) => empty.constant(types.number, 1),
                (normal) =>
                  normal.select(
                    types.number,
                    normal.greaterThan(cnt, normal.constant(types.number, 0)),
                    () => cnt,
                    (zero) => zero.constant(types.number, 0),
                  ),
              ),
            (inner) =>
              inner.select(
                types.number,
                inner.equal(types.number, arr, inner.constant(types.number, 0)),
                (empty) => empty.constant(types.number, 1),
                (normal) =>
                  normal.select(
                    types.number,
                    normal.greaterThan(arr, cnt),
                    (positive) => positive.subtract(arr, cnt),
                    (boundary) => boundary.constant(types.number, 0),
                  ),
              ),
          );
          const centerStep = scope.select(
            types.number,
            scope.greaterThan(arr, num(scope, 0)),
            () => arr,
            (empty) => empty.constant(types.number, 1),
          );
          const edgeSteps = scope.add(
            firstWrap,
            scope.multiply(scope.subtract(turnsToUpdate, num(scope, 1)), period),
          );
          const centerSteps = scope.add(
            turnDistance,
            scope.multiply(scope.subtract(turnsToUpdate, num(scope, 1)), centerStep),
          );
          const updateSteps = scope.select(
            types.number,
            center,
            () => centerSteps,
            () => edgeSteps,
          );
          const rawUpdateTime = scope.select(
            types.number,
            boolAnd(scope, scope.not(udis), scope.greaterThan(updateSteps, num(scope, 0))),
            (inner) =>
              inner.add(
                firstCount,
                inner.multiply(
                  inner.subtract(updateSteps, inner.constant(types.number, 1)),
                  tickPeriod,
                ),
              ),
            (disabled) => disabled.constant(types.number, MAX_DEADLINE_PS),
          );
          const updateTime = scope.select(
            types.number,
            scope.greaterThan(rawUpdateTime, num(scope, MAX_DEADLINE_PS)),
            (inner) => inner.constant(types.number, MAX_DEADLINE_PS),
            () => rawUpdateTime,
          );

          scope.if(scope.lessThan(updateTime, scope.getLocal(best)), (hit) => {
            const body2 = asBody(hit);

            body2.setLocal(best, updateTime);
            body2.setLocal(found, bool(body2, true));
          });

          const channel = scope.local(types.number, num(scope, 1));
          scope.while(
            (test) =>
              test.lessThanOrEqual(
                test.getLocal(channel),
                test.constant(types.number, config.channels),
              ),
            (loop) => {
              const body2 = asBody(loop);
              const ch = body2.getLocal(channel);
              const ccr = readWord(
                body2,
                PERIPH,
                body2.add(
                  num(body2, hotBase(config)),
                  body2.multiply(body2.subtract(ch, num(body2, 1)), num(body2, 4)),
                ),
              );
              const ccmr = body2.select(
                types.number,
                body2.lessThanOrEqual(ch, num(body2, 2)),
                (low) => loadReg(asBody(low), config, CCMR1),
                (high) => loadReg(asBody(high), config, CCMR2),
              );
              const selection = body2.bitAnd(
                body2.shiftRightUnsigned(
                  ccmr,
                  body2.multiply(body2.bitAnd(ch, num(body2, 1)), num(body2, 8)),
                ),
                num(body2, 3),
              );
              const ccer = loadReg(body2, config, CCER);
              const dier = loadReg(body2, config, DIER);
              const channelEnabled = boolOr(
                body2,
                body2.notEqual(
                  types.number,
                  body2.bitAnd(
                    ccer,
                    body2.shiftLeft(
                      num(body2, 1),
                      body2.multiply(body2.subtract(ch, num(body2, 1)), num(body2, 4)),
                    ),
                  ),
                  num(body2, 0),
                ),
                body2.notEqual(
                  types.number,
                  body2.bitAnd(dier, body2.shiftLeft(num(body2, 1), ch)),
                  num(body2, 0),
                ),
              );
              const maxCompare = body2.select(
                types.number,
                center,
                () => arr,
                (inner) => inner.subtract(period, inner.constant(types.number, 1)),
              );

              body2.if(
                boolAnd(
                  body2,
                  body2.equal(types.number, selection, num(body2, 0)),
                  boolAnd(body2, channelEnabled, body2.lessThanOrEqual(ccr, maxCompare)),
                ),
                (output) => {
                  const body3 = asBody(output);
                  const up = body3.select(
                    types.number,
                    body3.lessThan(cnt, ccr),
                    (inner) => inner.subtract(ccr, cnt),
                    (inner) => inner.add(inner.subtract(period, cnt), ccr),
                  );
                  const downSteps = body3.select(
                    types.number,
                    body3.greaterThan(cnt, ccr),
                    (inner) => inner.subtract(cnt, ccr),
                    (inner) => inner.subtract(inner.add(cnt, period), ccr),
                  );
                  const centerUp = body3.select(
                    types.number,
                    body3.lessThan(cnt, ccr),
                    (inner) => inner.subtract(ccr, cnt),
                    (inner) => inner.add(inner.subtract(arr, cnt), inner.subtract(arr, ccr)),
                  );
                  const centerDown = body3.select(
                    types.number,
                    body3.greaterThan(cnt, ccr),
                    (inner) => inner.subtract(cnt, ccr),
                    (inner) =>
                      inner.select(
                        types.number,
                        inner.equal(types.number, cnt, ccr),
                        (equal) => equal.multiply(arr, equal.constant(types.number, 2)),
                        (below) => below.add(cnt, ccr),
                      ),
                  );
                  const steps = body3.select(
                    types.number,
                    center,
                    (centerBranch) =>
                      centerBranch.select(
                        types.number,
                        down,
                        () => centerDown,
                        () => centerUp,
                      ),
                    (edgeBranch) =>
                      edgeBranch.select(
                        types.number,
                        down,
                        () => downSteps,
                        () => up,
                      ),
                  );
                  const rawCompareTime = body3.select(
                    types.number,
                    body3.greaterThan(steps, num(body3, 0)),
                    (inner) =>
                      inner.add(
                        firstCount,
                        inner.multiply(
                          inner.subtract(steps, inner.constant(types.number, 1)),
                          tickPeriod,
                        ),
                      ),
                    (immediate) => immediate.constant(types.number, 1),
                  );
                  const compareTime = body3.select(
                    types.number,
                    body3.greaterThan(rawCompareTime, num(body3, MAX_DEADLINE_PS)),
                    (inner) => inner.constant(types.number, MAX_DEADLINE_PS),
                    () => rawCompareTime,
                  );

                  body3.if(body3.lessThan(compareTime, body3.getLocal(best)), (hit) => {
                    asBody(hit).setLocal(best, compareTime);
                  });
                },
              );

              body2.setLocal(channel, body2.add(ch, num(body2, 1)));
            },
          );
        });
      },
    );
  }

  return b.select(
    types.number,
    b.getLocal(found),
    (inner) => inner.getLocal(best),
    (none) => none.constant(types.number, 0),
  );
}

function wakeTimer(b: Body, config?: TimerConfig): void {
  const active = timerActive(b);

  if (config !== undefined) {
    for (let channel = 1; channel <= config.channels; channel += 1)
      b.if(
        boolAnd(
          b,
          b.equal(types.number, captureSelection(b, config, channel), num(b, 0)),
          b.not(preloadEnabled(b, config, channel)),
        ),
        (immediate) => {
          const body = asBody(immediate);

          writeCcrActive(
            body,
            config,
            channel,
            body.bitAnd(
              loadReg(body, config, CCR_OFFSETS[channel - 1]!),
              num(body, maskOf(config)),
            ),
          );
        },
      );
  }

  setPeripheralActive(b, TIMER_SLOT, active);
  b.if(
    active,
    (on) => setPeripheralDeadline(asBody(on), TIMER_SLOT, num(asBody(on), 1)),
    (off) => setPeripheralDeadline(asBody(off), TIMER_SLOT, num(asBody(off), NO_DEADLINE_PS)),
  );

  // 寄存器写入是冷路径；这里同步刷新输出缓存，保证 CCER/CCMR/CCR/BDTR 等配置
  // 即使定时器尚未推进也能立即反映到 AlternateDriver。计数热路径在 advance 末尾刷新。
  if (config !== undefined && config.channels > 0) publishOutputCache(b, config);
  refreshTick(b);
}

function updateTimerSlot(b: Body): void {
  const active = timerActive(b);

  setPeripheralActive(b, TIMER_SLOT, active);
  b.if(
    active,
    (on) => {
      const body = asBody(on);

      setPeripheralDeadline(body, TIMER_SLOT, nextTimerDeadlinePs(body));
    },
    (off) => setPeripheralDeadline(asBody(off), TIMER_SLOT, num(asBody(off), NO_DEADLINE_PS)),
  );
  refreshTick(b);
}

/**
 * 计算并缓存每个输出通道的三态：0=不驱动，1=驱动低，2=驱动高。
 * GPIO 的 AlternateDriver 只读这个缓存，不在每个引脚重算 CNT/CCR/OC 模式树。
 */
function publishOutputCache(b: Body, config: TimerConfig): void {
  const cr1 = loadReg(b, config, CR1);
  const ccer = loadReg(b, config, CCER);
  const down = boolBitAt(b, cr1, 4);
  const cnt = u32(b, b.bitAnd(loadReg(b, config, CNT), num(b, maskOf(config))));
  const gate = config.hasBdtr ? boolBitAt(b, loadReg(b, config, BDTR), 15) : undefined;

  for (let channel = 1; channel <= config.channels; channel += 1) {
    const mode = ocMode(b, config, channel);
    const ccr = readCcrActive(b, config, channel);
    const rawOld = readOutRaw(b, config, channel);
    const pwm1 = b.select(
      types.number,
      down,
      (inner) =>
        inner.select(
          types.number,
          inner.greaterThan(cnt, ccr),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
      (inner) =>
        inner.select(
          types.number,
          inner.lessThan(cnt, ccr),
          (yes) => yes.constant(types.number, 1),
          (no) => no.constant(types.number, 0),
        ),
    );
    let raw = rawOld;

    raw = b.select(
      types.number,
      b.equal(types.number, mode, num(b, 4)),
      (inner) => inner.constant(types.number, 0),
      () => raw,
    );
    raw = b.select(
      types.number,
      b.equal(types.number, mode, num(b, 5)),
      (inner) => inner.constant(types.number, 1),
      () => raw,
    );
    raw = b.select(
      types.number,
      b.equal(types.number, mode, num(b, 6)),
      () => pwm1,
      () => raw,
    );
    raw = b.select(
      types.number,
      b.equal(types.number, mode, num(b, 7)),
      (inner) =>
        inner.select(
          types.number,
          inner.equal(types.number, pwm1, inner.constant(types.number, 0)),
          (one) => one.constant(types.number, 1),
          (zero) => zero.constant(types.number, 0),
        ),
      () => raw,
    );
    writeOutRaw(b, config, channel, raw);

    const output = b.equal(types.number, captureSelection(b, config, channel), num(b, 0));
    const enabled = boolAnd(b, output, boolBitAt(b, ccer, (channel - 1) * 4));
    const driving = gate === undefined ? enabled : boolAnd(b, enabled, gate);
    const polarity = boolBitAt(b, ccer, (channel - 1) * 4 + 1);
    const pin = b.select(
      types.bool,
      polarity,
      (inner) => inner.not(inner.notEqual(types.number, raw, inner.constant(types.number, 0))),
      (inner) => inner.notEqual(types.number, raw, inner.constant(types.number, 0)),
    );
    const next = b.select(
      types.number,
      driving,
      (on) =>
        on.select(
          types.number,
          pin,
          (high) => high.constant(types.number, 2),
          (low) => low.constant(types.number, 1),
        ),
      (off) => off.constant(types.number, 0),
    );
    const previous = readS(b, config, `Out${channel}`);
    const changed = b.notEqual(types.number, next, previous);

    writeS(b, config, `Out${channel}`, next);

    if (config.pins.some((candidate) => candidate.channel === channel)) {
      let ports = 0;

      for (const candidate of config.pins)
        if (candidate.channel === channel) ports |= 1 << candidate.port;

      b.if(changed, (sync) => {
        const body = asBody(sync);

        body.writeState(
          GPIO_SYNC,
          body.bitOr(body.readState(GPIO_SYNC, types.number), num(body, ports)),
        );
        markService(body, SERVICE_PIN_SYNC);
      });
    }
  }
}

export function timerChannelActive(b: Body, config: TimerConfig, channel: number): Value<boolean> {
  if (channel < 1 || channel > config.channels) return bool(b, false);

  return b.notEqual(types.number, readS(b, config, `Out${channel}`), num(b, 0));
}

export function timerChannelLevel(b: Body, config: TimerConfig, channel: number): Value<boolean> {
  if (channel < 1 || channel > config.channels) return bool(b, false);

  return b.equal(types.number, readS(b, config, `Out${channel}`), num(b, 2));
}

export function timerDrivers(): readonly AlternateDriver[] {
  const drivers: AlternateDriver[] = [];

  for (const config of TIMERS)
    for (const candidate of config.pins)
      drivers.push({
        port: candidate.port,
        pin: candidate.pin,
        af: candidate.af,
        active: (b) => timerChannelActive(b, config, candidate.channel),
        level: (b) => timerChannelLevel(b, config, candidate.channel),
      });

  return drivers;
}

function captureEdge(
  b: Body,
  config: TimerConfig,
  channel: number,
  levelHigh: Value<boolean>,
): Value<boolean> {
  const ccer = loadReg(b, config, CCER);
  const enabled = boolAnd(
    b,
    b.equal(types.number, captureSelection(b, config, channel), num(b, 1)),
    boolBitAt(b, ccer, (channel - 1) * 4),
  );
  const polarity = boolBitAt(b, ccer, (channel - 1) * 4 + 1);
  const npolarity = boolBitAt(b, ccer, (channel - 1) * 4 + 3);
  const rising = boolOr(b, b.not(polarity), boolAnd(b, polarity, npolarity));
  const falling = boolOr(b, polarity, boolAnd(b, b.not(polarity), npolarity));
  const matches = b.select(
    types.bool,
    levelHigh,
    () => rising,
    () => falling,
  );
  const captured = b.local(types.bool, false);

  const prescaler = b.shiftLeft(
    num(b, 1),
    bits(
      b,
      loadReg(b, config, channel <= 2 ? CCMR1 : CCMR2),
      channel <= 2 ? (channel % 2 === 1 ? 2 : 10) : channel % 2 === 1 ? 2 : 10,
      2,
    ),
  );

  b.if(boolAnd(b, enabled, matches), (hit) => {
    const scope = asBody(hit);
    const count = readS(scope, config, `Cap${channel}`);
    const next = scope.add(count, num(scope, 1));

    scope.if(
      scope.greaterThanOrEqual(next, prescaler),
      (capture) => {
        const body = asBody(capture);
        const sr = loadReg(body, config, SR);
        const current = body.bitAnd(loadReg(body, config, CNT), num(body, maskOf(config)));

        body.if(boolBitAt(body, sr, channel), (over) => {
          const scope2 = asBody(over);

          storeReg(
            scope2,
            config,
            SR,
            scope2.bitOr(loadReg(scope2, config, SR), num(scope2, CCR_OVERCAPTURE[channel - 1]!)),
          );
        });
        storeReg(body, config, CCR_OFFSETS[channel - 1]!, current);
        setTimerFlag(body, config, CCR_FLAGS[channel - 1]!);
        writeS(body, config, `Cap${channel}`, num(body, 0));
        body.setLocal(captured, bool(body, true));
      },
      (defer) => writeS(asBody(defer), config, `Cap${channel}`, next),
    );
  });

  return b.getLocal(captured);
}

/** 把宿主已知的精确外部边沿送入捕获通道；用于后续引脚观察 hook。 */
function inputPinConfigured(b: Body, pin: TimerPin): Value<boolean> {
  const moder = b.readState(gpioModerState(pin.port), types.number);
  const afr = b.readState(
    pin.pin < 8 ? gpioAfr0State(pin.port) : gpioAfr1State(pin.port),
    types.number,
  );
  const mode = b.bitAnd(b.shiftRightUnsigned(moder, num(b, pin.pin * 2)), num(b, 3));
  const af = b.bitAnd(b.shiftRightUnsigned(afr, num(b, (pin.pin & 7) * 4)), num(b, 0xf));
  const clock = gpioClockName(pin.port);

  return [
    clockGateEnabled(b, clock),
    b.not(clockGateResetHeld(b, clock)),
    b.equal(types.number, mode, num(b, 2)),
    b.equal(types.number, af, num(b, pin.af)),
  ].reduce((left, right) => boolAnd(b, left, right));
}

/** 单个描述条目的精确 armed 条件：本脚 AF、direct TIx(CCxS==1)、CCxE、CEN、两个 clockgate。 */
function captureInputArmed(b: Body, input: TimerCaptureInput): Value<boolean> {
  const { config, channel, pin } = input;
  const clock = timerClockName(config);
  const gates = [
    inputPinConfigured(b, pin),
    b.equal(types.number, captureSelection(b, config, channel), num(b, 1)),
    boolBitAt(b, loadReg(b, config, CCER), (channel - 1) * 4),
    boolBitAt(b, loadReg(b, config, CR1), 0),
    clockGateEnabled(b, clock),
    b.not(clockGateResetHeld(b, clock)),
  ];

  return gates.reduce((left, right) => boolAnd(b, left, right));
}

/**
 * 中央 enqueue 门控：只按 `pinName` 的精确描述项判断本脚是否 armed。
 * 不会因为同 channel 的其它候选脚 AF 正确而放行本脚。
 */
export function isTimerCaptureArmedOnPin(b: Body, pinName: string): Value<boolean> {
  let armed: Value<boolean> | undefined;

  for (const input of timerCaptureInputsOnPin(pinName)) {
    const next = captureInputArmed(b, input);

    armed = armed === undefined ? next : boolOr(b, armed, next);
  }

  return armed ?? bool(b, false);
}

/** 单脚精确注入；不检查同 channel 的其它候选脚。 */
function observeTimerInputOnPin(
  b: Body,
  input: TimerCaptureInput,
  timePs: Value<number>,
  levelHigh: Value<boolean>,
): Value<boolean> {
  const { config, channel } = input;
  const captured = b.local(types.bool, false);

  ensureTimer(b, config);
  b.if(
    boolAnd(
      b,
      captureInputArmed(b, input),
      b.greaterThanOrEqual(timePs, readS(b, config, 'LastPs')),
    ),
    (ordered) => {
      const body = asBody(ordered);

      syncTimerAt(body, config, timePs);
      body.if(captureEdge(body, config, channel, levelHigh), (hit) =>
        asBody(hit).setLocal(captured, bool(asBody(hit), true)),
      );
    },
  );

  return b.getLocal(captured);
}

/**
 * 精确外部边沿入口。中央在真实引脚 sample 变化时用该边沿的绝对 `timePs` 调用；
 * `timePs` 是安全整数 ps，不得先截断成 u32（2^32 ps = 4.294967296 ms）。
 * 只有该通道任一候选引脚当前处于 GPIO 复用模式时才捕获。返回是否真的送入了捕获。
 */
export function observeTimerInput(
  b: Body,
  config: TimerConfig,
  channel: number,
  timePs: Value<number>,
  levelHigh: Value<boolean>,
): Value<boolean> {
  const captured = b.local(types.bool, false);

  for (const input of TIMER_CAPTURE_INPUTS) {
    if (input.config !== config || input.channel !== channel) continue;
    b.if(observeTimerInputOnPin(b, input, timePs, levelHigh), (hit) =>
      asBody(hit).setLocal(captured, bool(asBody(hit), true)),
    );
  }

  return b.getLocal(captured);
}

/** 按引脚名把边沿送给描述表里所有映射到该脚的捕获通道；每项只检查本脚。 */
export function observeTimerInputByPin(
  b: Body,
  pinName: string,
  timePs: Value<number>,
  levelHigh: Value<boolean>,
): Value<boolean> {
  const accepted = b.local(types.bool, false);

  for (const input of timerCaptureInputsOnPin(pinName))
    b.if(observeTimerInputOnPin(b, input, timePs, levelHigh), (hit) =>
      asBody(hit).setLocal(accepted, bool(asBody(hit), true)),
    );

  return b.getLocal(accepted);
}

export function advanceTimers(b: Body, elapsedPs?: Value<number>): void {
  void elapsedPs;
  b.if(timerActive(b), (active) => {
    const scope = asBody(active);
    const now = scope.now();

    for (const config of TIMERS) {
      const bit = 1 << config.memoryIndex;

      scope.if(
        scope.notEqual(
          types.number,
          scope.bitAnd(scope.readState(TIM_CEN_MASK_STATE, types.number), num(scope, bit)),
          num(scope, 0),
        ),
        (running) => syncTimerAt(asBody(running), config, now),
      );
    }

    updateTimerSlot(scope);
  });
}

export interface TimerStateSpec {
  readonly name: string;
  readonly initial: number;
}

const timerStateSpecs: TimerStateSpec[] = [
  { name: TIM_CEN_MASK_STATE, initial: 0 },
  { name: TIM_CAPTURE_MASK_STATE, initial: 0 },
];

for (const config of TIMERS) {
  timerStateSpecs.push(
    { name: stateName(config, 'LastPs'), initial: 0 },
    { name: stateName(config, 'AccumPs'), initial: 0 },
    { name: stateName(config, 'Presc'), initial: 0 },
    { name: stateName(config, 'Rep'), initial: 0 },
    { name: stateName(config, 'ArrActive'), initial: maskOf(config) },
    { name: stateName(config, 'PscActive'), initial: 0 },
    { name: stateName(config, 'Ready'), initial: 0 },
  );

  for (let channel = 1; channel <= config.channels; channel += 1)
    timerStateSpecs.push(
      { name: stateName(config, `Cap${channel}`), initial: 0 },
      { name: stateName(config, `Out${channel}`), initial: 0 },
    );
}

/** DDL 资源清单；中央用这些 state 声明 tim 模块的内部状态。 */
export const TIMER_STATE_SPECS: readonly TimerStateSpec[] = Object.freeze(timerStateSpecs);
export const TIMER_STATE_NAMES: readonly string[] = Object.freeze(
  timerStateSpecs.map((spec) => spec.name),
);

function readCcr(b: Body, config: TimerConfig, channel: number): Value<number> {
  const value = b.local(
    types.number,
    b.bitAnd(loadReg(b, config, CCR_OFFSETS[channel - 1]!), num(b, maskOf(config))),
  );

  b.if(
    boolAnd(
      b,
      b.greaterThan(captureSelection(b, config, channel), num(b, 0)),
      boolBitAt(b, loadReg(b, config, CCER), (channel - 1) * 4),
    ),
    (capture) => {
      const body = asBody(capture);

      storeReg(
        body,
        config,
        SR,
        body.bitAnd(loadReg(body, config, SR), num(body, ~CCR_FLAGS[channel - 1]! & 0xffffffff)),
      );
    },
  );

  return b.getLocal(value);
}

function readTimerRegister(
  b: Body,
  config: TimerConfig,
  offset: Value<number>,
  size: number,
  staticOffset?: number,
): Value<number> {
  const wordOffset =
    staticOffset === undefined ? b.bitAnd(offset, num(b, 0x3fc)) : num(b, staticOffset & 0x3fc);
  const result = b.local(types.number, num(b, 0));

  syncTimerAt(b, config, b.now());

  const arms: WordArm[] = [
    { offset: EGR, emit: (body) => body.setLocal(result, num(body, 0)) },
    {
      offset: CNT,
      emit: (body) => {
        let value = body.bitAnd(loadReg(body, config, CNT), num(body, maskOf(config)));

        if (config.bits === 16)
          value = body.select(
            types.number,
            boolBitAt(body, loadReg(body, config, CR1), 11),
            (remap) =>
              remap.select(
                types.number,
                boolBitAt(asBody(remap), loadReg(asBody(remap), config, SR), 0),
                (set) => set.bitOr(value, set.constant(types.number, 0x80000000)),
                () => value,
              ),
            () => value,
          );
        body.setLocal(result, value);
      },
    },
    {
      offset: SR,
      emit: (body) => body.setLocal(result, loadReg(body, config, SR)),
    },
    {
      offset: ARR,
      emit: (body) =>
        body.setLocal(result, body.bitAnd(loadReg(body, config, ARR), num(body, maskOf(config)))),
    },
    {
      offset: PSC,
      emit: (body) =>
        body.setLocal(result, body.bitAnd(loadReg(body, config, PSC), num(body, 0xffff))),
    },
    {
      offset: RCR,
      emit: (body) =>
        body.setLocal(
          result,
          config.hasRcr ? body.bitAnd(loadReg(body, config, RCR), num(body, 0xff)) : num(body, 0),
        ),
    },
  ];

  for (let channel = 1; channel <= config.channels; channel += 1)
    arms.push({
      offset: CCR_OFFSETS[channel - 1]!,
      emit: (body) => body.setLocal(result, readCcr(body, config, channel)),
    });

  // 只回读真实存在的寄存器；TIM6/7 的 CC 寄存器、非高级定时器的 BDTR 等读 0。
  for (const candidate of [CR1, CR2, SMCR, DIER, CCMR1, CCMR2, CCER, BDTR]) {
    if (candidate === CCMR1 || candidate === CCER) {
      if (config.channels === 0) continue;
    } else if (candidate === CCMR2) {
      if (config.channels < 3) continue;
    } else if (candidate === BDTR) {
      if (!config.hasBdtr) continue;
    } else if (candidate === SMCR) {
      if (config.channels === 0) continue;
    }
    arms.push({
      offset: candidate,
      emit: (body) => body.setLocal(result, loadReg(body, config, candidate)),
    });
  }

  if (staticOffset === undefined) dispatchWord(b, wordOffset, arms);
  else dispatchStaticWord(b, staticOffset & 0x3fc, arms);

  return size === 4 ? u32(b, b.getLocal(result)) : extract(b, b.getLocal(result), offset, size);
}

function writeEventGeneration(b: Body, config: TimerConfig, value: Value<number>): void {
  b.if(b.notEqual(types.number, b.bitAnd(value, num(b, EGR_UG)), num(b, 0)), (ug) => {
    const scope = asBody(ug);

    loadPreloadShadows(scope, config);
    storeReg(scope, config, CNT, num(scope, 0));
    writeS(scope, config, 'Presc', num(scope, 0));
    writeS(scope, config, 'Rep', num(scope, 0));
    scope.if(
      boolAnd(
        scope,
        scope.not(boolBitAt(scope, loadReg(scope, config, CR1), 1)),
        scope.not(boolBitAt(scope, loadReg(scope, config, CR1), 2)),
      ),
      (update) => setTimerFlag(asBody(update), config, SR_UIF),
    );
  });

  for (let channel = 1; channel <= config.channels; channel += 1)
    b.if(b.notEqual(types.number, b.bitAnd(value, num(b, 1 << channel)), num(b, 0)), (cc) =>
      setTimerFlag(asBody(cc), config, CCR_FLAGS[channel - 1]!),
    );

  b.if(b.notEqual(types.number, b.bitAnd(value, num(b, EGR_COMG)), num(b, 0)), (com) =>
    setTimerFlag(asBody(com), config, SR_COMIF),
  );
  b.if(b.notEqual(types.number, b.bitAnd(value, num(b, EGR_TG)), num(b, 0)), (trigger) =>
    setTimerFlag(asBody(trigger), config, SR_TIF),
  );
  b.if(b.notEqual(types.number, b.bitAnd(value, num(b, EGR_BG)), num(b, 0)), (brk) =>
    setTimerFlag(asBody(brk), config, SR_BIF),
  );
}

function writeTimerRegister(
  b: Body,
  config: TimerConfig,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
  staticOffset?: number,
): void {
  const wordOffset =
    staticOffset === undefined ? b.bitAnd(offset, num(b, 0x3fc)) : num(b, staticOffset & 0x3fc);
  const placed = placedValue(b, value, offset, size);
  const arms: WordArm[] = [
    {
      offset: EGR,
      emit: (body) => writeEventGeneration(body, config, placed),
    },
    {
      offset: SR,
      emit: (body) => {
        const width = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
        const shift = body.multiply(body.bitAnd(offset, num(body, 3)), num(body, 8));
        const mask = body.shiftLeft(num(body, width), shift);
        const keep = body.bitOr(body.bitNot(mask), placed);

        storeReg(body, config, SR, body.bitAnd(loadReg(body, config, SR), keep));
        body.writeState(IRQ_DIRTY, bool(body, true));
        markService(body, SERVICE_IRQ);
      },
    },
  ];

  const store = (
    body: Body,
    register: number,
    trigger?: (scope: Body, previous: Value<number>, next: Value<number>) => void,
  ): void => {
    const previous = loadReg(body, config, register);
    const next = mergeWord(body, previous, value, offset, size);

    storeReg(body, config, register, next);
    trigger?.(body, previous, next);
  };

  const registerArm = (
    register: number,
    trigger?: (body: Body, previous: Value<number>, next: Value<number>) => void,
  ): void => {
    arms.push({ offset: register, emit: (body) => store(body, register, trigger) });
  };

  registerArm(CR1, (body, previous, next) => {
    const was = boolBitAt(body, previous, 0);
    const running = boolBitAt(body, next, 0);

    body.if(body.notEqual(types.bool, was, running), (change) => {
      const scope = asBody(change);

      scope.if(
        running,
        (start) => {
          const inner = asBody(start);

          writeS(inner, config, 'LastPs', inner.now());
          writeS(inner, config, 'AccumPs', num(inner, 0));
          writeS(inner, config, 'Presc', num(inner, 0));
          setCenMask(inner, config);
        },
        (stop) => {
          const inner = asBody(stop);

          clearCenMask(inner, config);
          writeS(inner, config, 'LastPs', inner.now());
        },
      );
    });

    body.if(
      boolAnd(body, body.not(boolBitAt(body, next, 7)), boolBitAt(body, previous, 7)),
      (immediate) => {
        const scope = asBody(immediate);

        writeS(
          scope,
          config,
          'ArrActive',
          scope.bitAnd(loadReg(scope, config, ARR), num(scope, maskOf(config))),
        );
      },
    );
  });
  registerArm(CR2);
  if (config.channels > 0) registerArm(SMCR);
  registerArm(DIER, (body) => {
    body.if(
      body.notEqual(
        types.number,
        body.bitAnd(loadReg(body, config, SR), loadReg(body, config, DIER)),
        num(body, 0),
      ),
      (pending) => {
        const scope = asBody(pending);

        scope.writeState(IRQ_DIRTY, bool(scope, true));
        markService(scope, SERVICE_IRQ);
      },
    );
  });

  if (config.channels > 0) {
    registerArm(CCMR1);
    if (config.channels > 2) registerArm(CCMR2);
    registerArm(CCER);

    for (let channel = 1; channel <= config.channels; channel += 1)
      registerArm(CCR_OFFSETS[channel - 1]!, (body, _previous, next) => {
        body.if(
          boolAnd(
            body,
            body.equal(types.number, captureSelection(body, config, channel), num(body, 0)),
            body.not(preloadEnabled(body, config, channel)),
          ),
          (immediate) => {
            const scope = asBody(immediate);

            writeCcrActive(scope, config, channel, scope.bitAnd(next, num(scope, maskOf(config))));
          },
        );
      });
  }

  registerArm(CNT, (body, _previous, next) => {
    storeReg(body, config, CNT, body.bitAnd(next, num(body, maskOf(config))));
  });
  registerArm(PSC);
  registerArm(ARR, (body, _previous, next) => {
    body.if(body.not(boolBitAt(body, loadReg(body, config, CR1), 7)), (immediate) => {
      const scope = asBody(immediate);

      writeS(scope, config, 'ArrActive', scope.bitAnd(next, num(scope, maskOf(config))));
    });
  });
  if (config.hasRcr)
    registerArm(RCR, (body, _previous, next) =>
      storeReg(body, config, RCR, body.bitAnd(next, num(body, 0xff))),
    );
  if (config.hasBdtr) registerArm(BDTR);

  if (staticOffset === undefined) dispatchWord(b, wordOffset, arms);
  else dispatchStaticWord(b, staticOffset & 0x3fc, arms);
  wakeTimer(b, config);
}

function selectTimer(
  b: Body,
  address: Value<number>,
  emit: (body: Body, config: TimerConfig) => void,
): void {
  const step = (body: Body, index: number): void => {
    const config = TIMERS[index];

    if (config === undefined) return;

    body.if(
      boolAnd(
        body,
        body.greaterThanOrEqual(address, num(body, config.base)),
        body.lessThan(address, num(body, config.base + TIMER_SIZE)),
      ),
      (hit) => emit(asBody(hit), config),
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

function readTimerAddress(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, num(b, 0));

  selectTimer(b, address, (body, config) => {
    const offset = body.subtract(address, num(body, config.base));

    ensureTimer(body, config);
    body.setLocal(result, readTimerRegister(body, config, offset, size));
  });

  return b.getLocal(result);
}

function writeTimerAddress(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  selectTimer(b, address, (body, config) => {
    const offset = body.subtract(address, num(body, config.base));

    ensureTimer(body, config);
    writeTimerRegister(body, config, offset, size, value);
  });
}

/** 静态地址读：只展开命中的唯一 timer/register。 */
function readTimerAddressStatic(b: Body, address: number, size: number): Value<number> | undefined {
  const config = timerConfigAt(address);

  if (config === undefined) return undefined;
  const offset = address - config.base;

  ensureTimer(b, config);

  return readTimerRegister(b, config, num(b, offset), size, offset);
}

/** 静态地址写：只展开命中的唯一 timer/register。 */
function writeTimerAddressStatic(
  b: Body,
  address: number,
  size: AccessSize,
  value: Value<number>,
): boolean {
  const config = timerConfigAt(address);

  if (config === undefined) return false;
  const offset = address - config.base;

  ensureTimer(b, config);
  writeTimerRegister(b, config, num(b, offset), size, value, offset);

  return true;
}

export function timerIrqPending(b: Body, irq: number): Value<boolean> {
  const result = b.local(types.bool, false);

  for (const config of TIMERS) {
    const flags = config.irqLines
      .filter((line) => line.irq === irq)
      .reduce((mask, line) => mask | line.flags, 0);

    if (flags === 0) continue;
    b.if(
      b.notEqual(
        types.number,
        b.bitAnd(loadReg(b, config, SR), b.bitAnd(loadReg(b, config, DIER), num(b, flags))),
        num(b, 0),
      ),
      (hit) => asBody(hit).setLocal(result, bool(asBody(hit), true)),
    );
  }

  return b.getLocal(result);
}

export function timerInterrupts(): readonly InterruptSource[] {
  const irqs = new Set<number>();

  for (const config of TIMERS) for (const line of config.irqLines) irqs.add(line.irq);

  return [...irqs]
    .sort((left, right) => left - right)
    .map((irq) => ({
      exception: irq + 16,
      pending: (b: Body) => timerIrqPending(b, irq),
      acknowledge: () => {},
    }));
}

/** 中央 `PERIPHERALS`/`FUSED_PERIPHERALS` 使用的模块实例。 */
export const timerModule: PeripheralModule = {
  id: 'tim',
  ranges: TIMERS.map((config) => ({ base: config.base, size: TIMER_SIZE })),
  read: (b, address, size) => readTimerAddress(b, address, size),
  write: (b, address, size, value) => writeTimerAddress(b, address, size, value),
  readStatic: (b, address, size) => readTimerAddressStatic(b, address, size),
  writeStatic: (b, address, size, value) => writeTimerAddressStatic(b, address, size, value),
  slot: TIMER_SLOT,
  advance: (b, elapsedPs) => advanceTimers(b, elapsedPs),
  interrupts: timerInterrupts(),
  alternateDrivers: timerDrivers(),
};

export const TIMER_MODULE = timerModule;
export const TIMER_ACTIVE = timerActive;

export {
  CR1,
  CR2,
  SMCR,
  DIER,
  SR,
  EGR,
  CCMR1,
  CCMR2,
  CCER,
  CNT,
  PSC,
  ARR,
  RCR,
  CCR1,
  CCR2,
  CCR3,
  CCR4,
  BDTR,
  SR_UIF,
  SR_CC1IF,
  SR_CC2IF,
  SR_CC3IF,
  SR_CC4IF,
  SR_COMIF,
  SR_TIF,
  SR_BIF,
  SR_CC1OF,
  SR_CC2OF,
  SR_CC3OF,
  SR_CC4OF,
  EGR_UG,
  EGR_COMG,
  EGR_TG,
  EGR_BG,
  DIER_UIE,
  DIER_CC1IE,
  DIER_CC2IE,
  DIER_CC3IE,
  DIER_CC4IE,
  DIER_COMIE,
  DIER_TIE,
  DIER_BIE,
  CR1_CEN,
  CR1_UDIS,
  CR1_URS,
  CR1_OPM,
  CR1_DIR,
  CR1_ARPE,
  BDTR_MOE,
};
