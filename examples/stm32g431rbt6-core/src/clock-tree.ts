import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { PERIPH, RCC_RCC_STATE } from './layout';
import { asBody, bool, boolAnd, boolBitAt, boolOr, num, readWordAt, u32, writeWordAt } from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import { USARTS, updateUsartBitPeriod } from './usart';

/**
 * STM32G431RBT6 时钟树（RM0440 第 5 章）与 RCC 外设门控。
 *
 * 时钟树在每次**改变时钟的 RCC 写入**时重算一次，结果缓存在 `periph` 的 RCC
 * 窗口尾部（0xA0–0xFF，GPIO 从 0x100 开始，互不重叠）。指令块与空闲 JIT 快路径
 * 不读时钟树：宿主若要动态 CPU 周期，只需在服务块/RCC 写入后读取
 * `CLOCK_CACHE.hclkHz`（或调用 `readHclkHz`）并按 `CLOCK_CACHE.epoch` 失效
 * 已翻译块的周期常量。
 *
 * 频率单位是 Hz；本模块不定义「一个周期多少皮秒」的常量，周期换算由宿主决定。
 *
 * 模型边界：
 * - HSI16 固定 16 MHz；HSE 只有在 `Machine.hseFrequency` 显式给出时才可用，
 *   0/缺省表示未焊接晶振，HSERDY 永远不会置位；不模拟 PF0/PF1 上的模拟晶振与
 *   起振时间。配置必须挂在 Machine 实例上，不能使用进程级全局覆盖。
 * - LSE/LSI 理想稳定：使能即 ready，默认 32768 Hz / 32000 Hz。
 * - PLL 的 M/N/P/Q/R 按 RM0440 的范围校验；越界配置视为不锁定（PLLRDY=0），
 *   系统时钟不会切到 PLL。
 * - AHB/APB 分频、定时器 APB 倍频、USART/I2C/ADC/RTC 时钟选择按寄存器实现。
 * - 时钟门控与复位只提供查询/复位副作用；总线是否据此屏蔽寄存器访问仍由
 *   `bus.ts`/各外设决定。
 */

/** RCC 寄存器偏移（RM0440 表 5.5.1）。 */
export const RCC_CR = 0x00;
export const RCC_ICSCR = 0x04;
export const RCC_CFGR = 0x08;
export const RCC_PLLCFGR = 0x0c;
export const RCC_CIER = 0x18;
export const RCC_CIFR = 0x1c;
export const RCC_CICR = 0x20;
export const RCC_AHB1RSTR = 0x28;
export const RCC_AHB2RSTR = 0x2c;
export const RCC_AHB3RSTR = 0x30;
export const RCC_APB1RSTR1 = 0x38;
export const RCC_APB1RSTR2 = 0x3c;
export const RCC_APB2RSTR = 0x40;
export const RCC_AHB1ENR = 0x48;
export const RCC_AHB2ENR = 0x4c;
export const RCC_AHB3ENR = 0x50;
export const RCC_APB1ENR1 = 0x58;
export const RCC_APB1ENR2 = 0x5c;
export const RCC_APB2ENR = 0x60;
export const RCC_CCIPR = 0x88;
export const RCC_BDCR = 0x90;
export const RCC_CSR = 0x94;
export const RCC_CRRCR = 0x98;
export const RCC_CCIPR2 = 0x9c;

/** RCC 寄存器后备区的有效字窗口；0xA0 起是时钟缓存。 */
export const RCC_REGISTER_END = 0xa0;

/** 时钟缓存字（相对 `RCC_RCC_STATE`，全部 4 字节对齐）。 */
export const CLOCK_CACHE = {
  /** 频率树的代数；0 表示尚未写过时钟寄存器，宿主沿用初始 `clockFrequency`。 */
  epoch: 0xa0,
  sysHz: 0xa4,
  hclkHz: 0xa8,
  pclk1Hz: 0xac,
  pclk2Hz: 0xb0,
  timApb1Hz: 0xb4,
  timApb2Hz: 0xb8,
  usart1Hz: 0xbc,
  usart2Hz: 0xc0,
  usart3Hz: 0xc4,
  uart4Hz: 0xc8,
  lpuart1Hz: 0xcc,
  i2c1Hz: 0xd0,
  i2c2Hz: 0xd4,
  i2c3Hz: 0xd8,
  adc12Hz: 0xdc,
  pllVcoHz: 0xe0,
  /** 当前系统时钟源（0/1=HSI，2=HSE，3=PLL），即 CFGR.SWS 的模型状态。 */
  sws: 0xe4,
  /** 控制标志：bit0=HSI 被软件显式关闭，bit1=复位标志已由 RMVF 清除。 */
  control: 0xe8,
  /** 内部复位源缓存；CSR 读取时合成，RMVF 清掉。 */
  resetFlags: 0xec,
  rtcHz: 0xf0,
  hseHz: 0xf4,
  lseHz: 0xf8,
  lsiHz: 0xfc,
} as const;

export const CLOCK_FLAG_HSI_OFF = 1;
export const CLOCK_FLAG_RESET_FLAGS_CLEARED = 2;

/** 上电/引脚复位 + BOR 复位标志（PINRSTF bit26、BORRSTF bit27）。 */
export const RESET_FLAGS_DEFAULT = 0x0c000000;

export const HSI_HZ = 16_000_000;
export const LSE_DEFAULT_HZ = 32_768;
export const LSI_DEFAULT_HZ = 32_000;
export const MAX_SYSCLK_HZ = 170_000_000;

/** PLL VCO 输入/输出范围（RM0440 表 5.7.2）。 */
const PLL_INPUT_MIN_HZ = 2_660_000;
const PLL_INPUT_MAX_HZ = 16_000_000;
const PLL_VCO_MIN_HZ = 96_000_000;
const PLL_VCO_MAX_HZ = 344_000_000;

export interface ClockSources {
  /** 复位后、固件尚未写时钟寄存器时宿主使用的 CPU 频率（默认 16 MHz = reset HSI）。 */
  readonly fallbackHz: number;
  /** HSI16 实际频率（RM0440 固定为 16 MHz）。 */
  readonly hsiHz: number;
  /** HSE 晶振频率；0 表示未提供，HSERDY 永远为 0。 */
  readonly hseHz: number;
  readonly lseHz: number;
  readonly lsiHz: number;
}

/**
 * `Machine` 的可选时钟扩展；主代理/中央把它加进 `machine.ts` 后本模块自动采用。
 * 时钟源必须挂在 Machine 实例上，不能使用进程级全局覆盖：同一进程会同时存在
 * HSE=0 与 HSE=24 MHz 的板，全局变量会污染翻译缓存。
 */
interface MachineClockSources {
  readonly clockFrequency: number;
  readonly hseFrequency?: number;
  readonly lseFrequency?: number;
  readonly lsiFrequency?: number;
  readonly profile?: string;
}

const finite = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;

/** 当前翻译上下文的时钟源。只在翻译期调用。 */
export function clockSources(): ClockSources {
  const current = machine() as MachineClockSources;

  return {
    fallbackHz: finite(current.clockFrequency, HSI_HZ),
    hsiHz: HSI_HZ,
    hseHz: finite(current.hseFrequency, 0),
    lseHz: finite(current.lseFrequency, LSE_DEFAULT_HZ),
    lsiHz: finite(current.lsiFrequency, LSI_DEFAULT_HZ),
  };
}

/**
 * 时钟源配置指纹。中央必须把它（以及 `machine.profile`）纳入 JIT 块缓存键：
 * 同一 cyclePs/PC/字节在不同 HSE/LSE/LSI 配置下会生成不同 service 块。
 */
export function clockConfigKey(): string {
  const current = machine() as MachineClockSources;
  const sources = clockSources();

  return `${current.profile ?? 'unknown'}:${sources.fallbackHz}:${sources.hseHz}:${sources.lseHz}:${sources.lsiHz}`;
}

const loadReg = (b: Body, offset: number): Value<number> =>
  readWordAt(b, PERIPH, RCC_RCC_STATE + offset);
const loadCache = (b: Body, offset: number): Value<number> =>
  readWordAt(b, PERIPH, RCC_RCC_STATE + offset);
const storeCache = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, PERIPH, RCC_RCC_STATE + offset, u32(b, value));
};

const bit = (b: Body, value: Value<number>, index: number): Value<boolean> =>
  boolBitAt(b, value, index);

const atLeast = (b: Body, value: Value<number>, minimum: number): Value<boolean> =>
  b.greaterThanOrEqual(value, num(b, minimum));
const atMost = (b: Body, value: Value<number>, maximum: number): Value<boolean> =>
  b.lessThanOrEqual(value, num(b, maximum));

/** 按运行期下标取常量表；越界返回最后一个（表尾放安全默认值）。 */
function pickConstant(b: Body, index: Value<number>, values: readonly number[]): Value<number> {
  let result = num(b, values[values.length - 1] ?? 0);

  for (let position = values.length - 2; position >= 0; position -= 1)
    result = b.select(
      types.number,
      b.equal(types.number, index, num(b, position)),
      (inner) => inner.constant(types.number, values[position]!),
      () => result,
    );

  return result;
}

/** 按运行期下标选择一个 Value；越界返回 0。 */
function pickValue(b: Body, index: Value<number>, values: readonly Value<number>[]): Value<number> {
  let result: Value<number> = num(b, 0);

  for (let position = values.length - 1; position >= 0; position -= 1)
    result = b.select(
      types.number,
      b.equal(types.number, index, num(b, position)),
      () => values[position]!,
      () => result,
    );

  return result;
}

const when = (b: Body, condition: Value<boolean>, value: Value<number>): Value<number> =>
  b.select(
    types.number,
    condition,
    () => value,
    (inner) => inner.constant(types.number, 0),
  );

/** AHB HPRE：0xxx=1，1000..1011=2..16，1100..1111=64..512。用一次移位代替 16 层 select。 */
function ahbDividerValue(b: Body, encoded: Value<number>): Value<number> {
  const shift = b.select(
    types.number,
    b.lessThan(encoded, num(b, 12)),
    (inner) => inner.subtract(encoded, inner.constant(types.number, 7)),
    (inner) => inner.subtract(encoded, inner.constant(types.number, 6)),
  );

  return b.select(
    types.number,
    b.lessThan(encoded, num(b, 8)),
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.shiftLeft(inner.constant(types.number, 1), shift),
  );
}

/** APB PPRE：0xx=1，100..111=2..16。 */
function apbDividerValue(b: Body, encoded: Value<number>): Value<number> {
  return b.select(
    types.number,
    b.lessThan(encoded, num(b, 4)),
    (inner) => inner.constant(types.number, 1),
    (inner) =>
      inner.shiftLeft(
        inner.constant(types.number, 1),
        inner.subtract(encoded, inner.constant(types.number, 3)),
      ),
  );
}

const divide = (b: Body, value: Value<number>, divisor: Value<number>): Value<number> => {
  const safe = b.select(
    types.number,
    b.greaterThan(divisor, num(b, 0)),
    () => divisor,
    (inner) => inner.constant(types.number, 1),
  );

  return b.floor(b.divide(value, safe));
};

function effectiveHsiOn(
  b: Body,
  cr: Value<number>,
  flags: Value<number>,
  sws: Value<number>,
  pll: Value<number>,
): Value<boolean> {
  const requested = bit(b, cr, 8);
  const defaultOn = b.not(bit(b, flags, 0));
  const systemSource = b.lessThan(sws, num(b, 2));
  const pllSourceHsi = boolAnd(
    b,
    bit(b, pll, 24),
    b.equal(types.number, b.bitAnd(pll, num(b, 3)), num(b, 2)),
  );

  return boolOr(b, boolOr(b, requested, defaultOn), boolOr(b, systemSource, pllSourceHsi));
}

/** 供 RCC 读合成使用：HSI 是否实际在运行（复位默认、系统源或 PLL 源强制保持）。 */
export function hsiClockOn(
  b: Body,
  cr: Value<number>,
  flags: Value<number>,
  sws: Value<number>,
  pll: Value<number>,
): Value<boolean> {
  return effectiveHsiOn(b, cr, flags, sws, pll);
}

/** 供 RCC 读合成使用：PLL 是否锁定。 */
export function pllLocked(
  b: Body,
  cr: Value<number>,
  pll: Value<number>,
  hsiReady: Value<boolean>,
  hseReady: Value<boolean>,
): Value<boolean> {
  return pllState(b, cr, pll, hsiReady, hseReady, clockSources()).locked;
}

interface PllState {
  readonly locked: Value<boolean>;
  readonly vcoHz: Value<number>;
  readonly rHz: Value<number>;
  readonly pHz: Value<number>;
  readonly qHz: Value<number>;
  readonly rReady: Value<boolean>;
  readonly pReady: Value<boolean>;
  readonly qReady: Value<boolean>;
}

/**
 * PLL 的锁定与各输出。锁定只看 VCO 输入/输出范围；输出使能位（PLLREN/PEN/QEN）
 * 只影响对应输出是否可用，不影响 PLLRDY——与 RM0440 一致。
 */
function pllState(
  b: Body,
  cr: Value<number>,
  pll: Value<number>,
  hsiReady: Value<boolean>,
  hseReady: Value<boolean>,
  sources: ClockSources,
): PllState {
  const pllOn = bit(b, cr, 24);
  const source = b.bitAnd(pll, num(b, 3));
  const sourceIsHsi = b.equal(types.number, source, num(b, 2));
  const sourceIsHse = b.equal(types.number, source, num(b, 3));
  // 不用嵌套 select：每个分支只在自己的 builder 上返回常量，避免 IR_SCOPE。
  const sourceReady = boolOr(
    b,
    boolAnd(b, sourceIsHsi, hsiReady),
    boolAnd(b, sourceIsHse, hseReady),
  );
  const hsiSource = when(b, sourceIsHsi, num(b, sources.hsiHz));
  const hseSource = when(b, sourceIsHse, num(b, sources.hseHz));
  const sourceHz = b.bitOr(hsiSource, hseSource);
  const m = b.add(b.bitAnd(b.shiftRightUnsigned(pll, num(b, 4)), num(b, 0xf)), num(b, 1));
  const n = b.bitAnd(b.shiftRightUnsigned(pll, num(b, 8)), num(b, 0x7f));
  const inputHz = divide(b, sourceHz, m);
  const vcoHz = b.multiply(inputHz, n);
  const inputOk = boolAnd(
    b,
    atLeast(b, inputHz, PLL_INPUT_MIN_HZ),
    atMost(b, inputHz, PLL_INPUT_MAX_HZ),
  );
  const vcoOk = boolAnd(b, atLeast(b, vcoHz, PLL_VCO_MIN_HZ), atMost(b, vcoHz, PLL_VCO_MAX_HZ));
  const nOk = boolAnd(b, atLeast(b, n, 8), atMost(b, n, 127));
  const locked = boolAnd(
    b,
    boolAnd(b, pllOn, sourceReady),
    boolAnd(b, nOk, boolAnd(b, inputOk, vcoOk)),
  );
  const rDiv = b.multiply(
    b.add(b.bitAnd(b.shiftRightUnsigned(pll, num(b, 25)), num(b, 3)), num(b, 1)),
    num(b, 2),
  );
  const rHz = divide(b, vcoHz, rDiv);
  const qDiv = b.multiply(
    b.add(b.bitAnd(b.shiftRightUnsigned(pll, num(b, 21)), num(b, 3)), num(b, 1)),
    num(b, 2),
  );
  const rawP = b.bitAnd(b.shiftRightUnsigned(pll, num(b, 27)), num(b, 0x1f));
  const encodedP = b.bitAnd(b.shiftRightUnsigned(pll, num(b, 16)), num(b, 3));
  const encodedPDiv = pickConstant(b, encodedP, [2, 3, 5, 7, 2]);
  const pDiv = b.select(
    types.number,
    b.notEqual(types.number, rawP, num(b, 0)),
    () => rawP,
    () => encodedPDiv,
  );
  const pHz = divide(b, vcoHz, pDiv);
  const qHz = divide(b, vcoHz, qDiv);

  return {
    locked,
    vcoHz,
    rHz,
    pHz,
    qHz,
    rReady: boolAnd(b, locked, bit(b, pll, 24)),
    pReady: boolAnd(b, locked, bit(b, pll, 16)),
    qReady: boolAnd(b, locked, bit(b, pll, 20)),
  };
}

/** AHB HPRE 编码 → 分频值。 */
export function ahbDivider(encoded: number): number {
  if (encoded < 8) return 1;

  return [1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 8, 16, 64, 128, 256, 512][encoded] ?? 1;
}

/** APB PPRE 编码 → 分频值。 */
export function apbDivider(encoded: number): number {
  return [1, 1, 1, 1, 2, 4, 8, 16][encoded & 7] ?? 1;
}

/** APB 定时器时钟倍频：APB 分频不为 1 时定时器时钟是 PCLK 的两倍。 */
export function timerClockHz(pclkHz: number, apbEncoded: number): number {
  return apbDivider(apbEncoded) === 1 ? pclkHz : pclkHz * 2;
}

/** VOS[1:0] 与 PWR_CR5.R1MODE 的组合 → 该档位允许的最大 HCLK。 */
export function vosLimitHz(vos: number, boost: boolean): number {
  if (vos === 1) return boost ? 170_000_000 : 150_000_000;
  if (vos === 2) return 26_000_000;

  return 0;
}

/**
 * 重算时钟树并写入缓存。`advanceEpoch` 为 true 时递增代数（频率可能变化）；
 * 仅使能/复位位变化时传 false，避免宿主无谓失效 JIT 块。
 */
export function updateClockTree(b: Body, advanceEpoch = true): void {
  const sources = clockSources();
  const cr = loadReg(b, RCC_CR);
  const cfgr = loadReg(b, RCC_CFGR);
  const pll = loadReg(b, RCC_PLLCFGR);
  const ccipr = loadReg(b, RCC_CCIPR);
  const bdcr = loadReg(b, RCC_BDCR);
  const csr = loadReg(b, RCC_CSR);
  const flags = loadCache(b, CLOCK_CACHE.control);
  const previousSws = loadCache(b, CLOCK_CACHE.sws);
  const hsiReady = effectiveHsiOn(b, cr, flags, previousSws, pll);
  const hseReady = boolAnd(b, bit(b, cr, 16), bool(b, sources.hseHz > 0));
  const lseReady = bit(b, bdcr, 0);
  const lsiReady = bit(b, csr, 0);
  const pllValues = pllState(b, cr, pll, hsiReady, hseReady, sources);
  const pllUsable = boolAnd(b, pllValues.rReady, atMost(b, pllValues.rHz, MAX_SYSCLK_HZ));

  const requested = b.bitAnd(cfgr, num(b, 3));
  const wantsHsi = b.lessThan(requested, num(b, 2));
  const wantsHse = b.equal(types.number, requested, num(b, 2));
  const wantsPll = b.equal(types.number, requested, num(b, 3));
  const targetReady = boolOr(
    b,
    boolAnd(b, wantsHsi, hsiReady),
    boolOr(b, boolAnd(b, wantsHse, hseReady), boolAnd(b, wantsPll, pllUsable)),
  );
  const selected = b.select(
    types.number,
    targetReady,
    () => requested,
    () => previousSws,
  );
  const selectedIsHsi = b.lessThan(selected, num(b, 2));
  const selectedIsHse = b.equal(types.number, selected, num(b, 2));
  const selectedIsPll = b.equal(types.number, selected, num(b, 3));
  const selectedOk = boolOr(
    b,
    boolAnd(b, selectedIsHsi, hsiReady),
    boolOr(b, boolAnd(b, selectedIsHse, hseReady), boolAnd(b, selectedIsPll, pllUsable)),
  );
  // 当前源被非法关闭（例如直接清 PLLON 而 SWS 仍指向 PLL）时退回 HSI。
  const sws = b.select(
    types.number,
    selectedOk,
    () => selected,
    (inner) => inner.constant(types.number, 0),
  );
  const hsiHzValue = num(b, sources.hsiHz);
  const sysHz = pickValue(b, sws, [hsiHzValue, hsiHzValue, num(b, sources.hseHz), pllValues.rHz]);
  const hpre = b.bitAnd(b.shiftRightUnsigned(cfgr, num(b, 4)), num(b, 0xf));
  const ppre1 = b.bitAnd(b.shiftRightUnsigned(cfgr, num(b, 8)), num(b, 7));
  const ppre2 = b.bitAnd(b.shiftRightUnsigned(cfgr, num(b, 11)), num(b, 7));
  const ahb = ahbDividerValue(b, hpre);
  const apb1 = apbDividerValue(b, ppre1);
  const apb2 = apbDividerValue(b, ppre2);
  const hclkHz = divide(b, sysHz, ahb);
  const pclk1Hz = divide(b, hclkHz, apb1);
  const pclk2Hz = divide(b, hclkHz, apb2);
  const timApb1Hz = b.select(
    types.number,
    b.equal(types.number, apb1, num(b, 1)),
    () => pclk1Hz,
    (inner) => inner.multiply(pclk1Hz, inner.constant(types.number, 2)),
  );
  const timApb2Hz = b.select(
    types.number,
    b.equal(types.number, apb2, num(b, 1)),
    () => pclk2Hz,
    (inner) => inner.multiply(pclk2Hz, inner.constant(types.number, 2)),
  );

  const hsi = when(b, hsiReady, num(b, sources.hsiHz));
  const lse = when(b, lseReady, num(b, sources.lseHz));
  const lsi = when(b, lsiReady, num(b, sources.lsiHz));
  const pllP = when(b, pllValues.pReady, pllValues.pHz);
  const usart1 = pickValue(b, b.bitAnd(ccipr, num(b, 3)), [pclk2Hz, sysHz, hsi, lse]);
  const usart2 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 2)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    lse,
  ]);
  const usart3 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 4)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    lse,
  ]);
  const uart4 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 6)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    lse,
  ]);
  const lpuart1 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 10)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    lse,
  ]);
  const i2c1 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 12)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    num(b, 0),
  ]);
  const i2c2 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 14)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    num(b, 0),
  ]);
  const i2c3 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 16)), num(b, 3)), [
    pclk1Hz,
    sysHz,
    hsi,
    num(b, 0),
  ]);
  const adc12 = pickValue(b, b.bitAnd(b.shiftRightUnsigned(ccipr, num(b, 28)), num(b, 3)), [
    num(b, 0),
    pllP,
    sysHz,
    num(b, 0),
  ]);
  const rtcSel = b.bitAnd(b.shiftRightUnsigned(bdcr, num(b, 8)), num(b, 3));
  const rtcHz = pickValue(b, rtcSel, [
    num(b, 0),
    lse,
    lsi,
    when(b, hseReady, num(b, Math.floor(sources.hseHz / 32))),
  ]);

  if (advanceEpoch) {
    storeCache(b, CLOCK_CACHE.epoch, b.add(loadCache(b, CLOCK_CACHE.epoch), num(b, 1)));
  }

  storeCache(b, CLOCK_CACHE.sws, sws);
  storeCache(b, CLOCK_CACHE.sysHz, sysHz);
  storeCache(b, CLOCK_CACHE.hclkHz, hclkHz);
  storeCache(b, CLOCK_CACHE.pclk1Hz, pclk1Hz);
  storeCache(b, CLOCK_CACHE.pclk2Hz, pclk2Hz);
  storeCache(b, CLOCK_CACHE.timApb1Hz, timApb1Hz);
  storeCache(b, CLOCK_CACHE.timApb2Hz, timApb2Hz);
  storeCache(b, CLOCK_CACHE.usart1Hz, usart1);
  storeCache(b, CLOCK_CACHE.usart2Hz, usart2);
  storeCache(b, CLOCK_CACHE.usart3Hz, usart3);
  storeCache(b, CLOCK_CACHE.uart4Hz, uart4);
  storeCache(b, CLOCK_CACHE.lpuart1Hz, lpuart1);
  storeCache(b, CLOCK_CACHE.i2c1Hz, i2c1);
  storeCache(b, CLOCK_CACHE.i2c2Hz, i2c2);
  storeCache(b, CLOCK_CACHE.i2c3Hz, i2c3);
  storeCache(b, CLOCK_CACHE.adc12Hz, adc12);
  storeCache(b, CLOCK_CACHE.pllVcoHz, when(b, pllValues.locked, pllValues.vcoHz));
  storeCache(b, CLOCK_CACHE.rtcHz, rtcHz);
  storeCache(b, CLOCK_CACHE.hseHz, num(b, sources.hseHz));
  storeCache(b, CLOCK_CACHE.lseHz, num(b, sources.lseHz));
  storeCache(b, CLOCK_CACHE.lsiHz, num(b, sources.lsiHz));

  // USART 位时长由本路实际时钟重算。这样 RCC 改动会改变真实发送时间，而不是
  // 仍按 `clockFrequency` 属性；OVER8/LPUART 的公式仍由 usart.ts 统一解释。
  for (const config of USARTS) {
    const clockHz =
      config.index === 1
        ? usart1
        : config.index === 2
          ? usart2
          : config.index === 3
            ? usart3
            : config.index === 4
              ? uart4
              : lpuart1;

    updateUsartBitPeriod(b, config, clockHz);
  }
}

/** 缓存字读取（供宿主在服务块中读取，不在指令快路径调用）。 */
export function readClockWord(b: Body, offset: number): Value<number> {
  return loadCache(b, offset);
}

/** 时钟树代数；0 表示固件尚未写过会改变频率的 RCC 寄存器。 */
export function readClockEpoch(b: Body): Value<number> {
  return loadCache(b, CLOCK_CACHE.epoch);
}

const dynamicOrFallback = (b: Body, offset: number, fallback: Value<number>): Value<number> =>
  b.select(
    types.number,
    b.equal(types.number, loadCache(b, CLOCK_CACHE.epoch), num(b, 0)),
    () => fallback,
    (inner) => loadCache(asBody(inner), offset),
  );

/** 当前 HCLK（CPU/AHB 时钟）。尚未配置时钟时返回宿主的 `clockFrequency`。 */
export function readHclkHz(b: Body): Value<number> {
  return dynamicOrFallback(b, CLOCK_CACHE.hclkHz, num(b, clockSources().fallbackHz));
}

export function readSysclkHz(b: Body): Value<number> {
  return dynamicOrFallback(b, CLOCK_CACHE.sysHz, num(b, clockSources().fallbackHz));
}

export function readPclk1Hz(b: Body): Value<number> {
  return dynamicOrFallback(b, CLOCK_CACHE.pclk1Hz, num(b, clockSources().fallbackHz));
}

export function readPclk2Hz(b: Body): Value<number> {
  return dynamicOrFallback(b, CLOCK_CACHE.pclk2Hz, num(b, clockSources().fallbackHz));
}

export interface ClockGate {
  /** 时钟使能寄存器偏移（RCC_AHBxENR/APBxENR）。 */
  readonly enable: number;
  readonly bit: number;
  /** 复位寄存器偏移；-1 表示该外设没有独立复位位。 */
  readonly reset: number;
  readonly resetBit: number;
}

/** 按 RM0440 表 5.5.3/5.5.4 整理的常用外设门控。 */
export const PERIPHERAL_CLOCKS = {
  gpioA: { enable: RCC_AHB2ENR, bit: 0, reset: RCC_AHB2RSTR, resetBit: 0 },
  gpioB: { enable: RCC_AHB2ENR, bit: 1, reset: RCC_AHB2RSTR, resetBit: 1 },
  gpioC: { enable: RCC_AHB2ENR, bit: 2, reset: RCC_AHB2RSTR, resetBit: 2 },
  gpioD: { enable: RCC_AHB2ENR, bit: 3, reset: RCC_AHB2RSTR, resetBit: 3 },
  gpioE: { enable: RCC_AHB2ENR, bit: 4, reset: RCC_AHB2RSTR, resetBit: 4 },
  gpioF: { enable: RCC_AHB2ENR, bit: 5, reset: RCC_AHB2RSTR, resetBit: 5 },
  adc12: { enable: RCC_AHB2ENR, bit: 13, reset: RCC_AHB2RSTR, resetBit: 13 },
  dac1: { enable: RCC_AHB2ENR, bit: 16, reset: RCC_AHB2RSTR, resetBit: 16 },
  dac3: { enable: RCC_AHB2ENR, bit: 18, reset: RCC_AHB2RSTR, resetBit: 18 },
  rng: { enable: RCC_AHB2ENR, bit: 26, reset: RCC_AHB2RSTR, resetBit: 26 },
  flash: { enable: RCC_AHB1ENR, bit: 8, reset: RCC_AHB1RSTR, resetBit: 8 },
  crc: { enable: RCC_AHB1ENR, bit: 12, reset: RCC_AHB1RSTR, resetBit: 12 },
  dma1: { enable: RCC_AHB1ENR, bit: 0, reset: RCC_AHB1RSTR, resetBit: 0 },
  dma2: { enable: RCC_AHB1ENR, bit: 1, reset: RCC_AHB1RSTR, resetBit: 1 },
  dmamux1: { enable: RCC_AHB1ENR, bit: 2, reset: RCC_AHB1RSTR, resetBit: 2 },
  tim2: { enable: RCC_APB1ENR1, bit: 0, reset: RCC_APB1RSTR1, resetBit: 0 },
  tim3: { enable: RCC_APB1ENR1, bit: 1, reset: RCC_APB1RSTR1, resetBit: 1 },
  tim4: { enable: RCC_APB1ENR1, bit: 2, reset: RCC_APB1RSTR1, resetBit: 2 },
  tim6: { enable: RCC_APB1ENR1, bit: 4, reset: RCC_APB1RSTR1, resetBit: 4 },
  tim7: { enable: RCC_APB1ENR1, bit: 5, reset: RCC_APB1RSTR1, resetBit: 5 },
  spi2: { enable: RCC_APB1ENR1, bit: 14, reset: RCC_APB1RSTR1, resetBit: 14 },
  spi3: { enable: RCC_APB1ENR1, bit: 15, reset: RCC_APB1RSTR1, resetBit: 15 },
  usart2: { enable: RCC_APB1ENR1, bit: 17, reset: RCC_APB1RSTR1, resetBit: 17 },
  usart3: { enable: RCC_APB1ENR1, bit: 18, reset: RCC_APB1RSTR1, resetBit: 18 },
  uart4: { enable: RCC_APB1ENR1, bit: 19, reset: RCC_APB1RSTR1, resetBit: 19 },
  i2c1: { enable: RCC_APB1ENR1, bit: 21, reset: RCC_APB1RSTR1, resetBit: 21 },
  i2c2: { enable: RCC_APB1ENR1, bit: 22, reset: RCC_APB1RSTR1, resetBit: 22 },
  usb: { enable: RCC_APB1ENR1, bit: 23, reset: RCC_APB1RSTR1, resetBit: 23 },
  fdcan: { enable: RCC_APB1ENR1, bit: 25, reset: RCC_APB1RSTR1, resetBit: 25 },
  pwr: { enable: RCC_APB1ENR1, bit: 28, reset: RCC_APB1RSTR1, resetBit: 28 },
  i2c3: { enable: RCC_APB1ENR1, bit: 30, reset: RCC_APB1RSTR1, resetBit: 30 },
  lptim1: { enable: RCC_APB1ENR1, bit: 31, reset: RCC_APB1RSTR1, resetBit: 31 },
  lpuart1: { enable: RCC_APB1ENR2, bit: 0, reset: RCC_APB1RSTR2, resetBit: 0 },
  ucpd1: { enable: RCC_APB1ENR2, bit: 8, reset: RCC_APB1RSTR2, resetBit: 8 },
  syscfg: { enable: RCC_APB2ENR, bit: 0, reset: RCC_APB2RSTR, resetBit: 0 },
  tim1: { enable: RCC_APB2ENR, bit: 11, reset: RCC_APB2RSTR, resetBit: 11 },
  spi1: { enable: RCC_APB2ENR, bit: 12, reset: RCC_APB2RSTR, resetBit: 12 },
  tim8: { enable: RCC_APB2ENR, bit: 13, reset: RCC_APB2RSTR, resetBit: 13 },
  usart1: { enable: RCC_APB2ENR, bit: 14, reset: RCC_APB2RSTR, resetBit: 14 },
  tim15: { enable: RCC_APB2ENR, bit: 16, reset: RCC_APB2RSTR, resetBit: 16 },
  tim16: { enable: RCC_APB2ENR, bit: 17, reset: RCC_APB2RSTR, resetBit: 17 },
  tim17: { enable: RCC_APB2ENR, bit: 18, reset: RCC_APB2RSTR, resetBit: 18 },
  sai1: { enable: RCC_APB2ENR, bit: 21, reset: RCC_APB2RSTR, resetBit: 21 },
} as const satisfies Record<string, ClockGate>;

export type PeripheralClockName = keyof typeof PERIPHERAL_CLOCKS;

/** 时钟使能位。总线/外设可用它判断寄存器访问是否有效。 */
export function clockGateEnabled(b: Body, name: PeripheralClockName): Value<boolean> {
  const gate = PERIPHERAL_CLOCKS[name];

  return bit(b, loadReg(b, gate.enable), gate.bit);
}

/** 对应 RSTR 位是否为 1（外设处于复位保持）。 */
export function clockGateResetHeld(b: Body, name: PeripheralClockName): Value<boolean> {
  const gate = PERIPHERAL_CLOCKS[name];

  if (gate.reset < 0) return bool(b, false);

  return bit(b, loadReg(b, gate.reset), gate.resetBit);
}

/**
 * 外设实际输入时钟：门控关闭或复位保持时为 0。定时器已经包含 APB 倍频。
 * 仅供服务块/外设寄存器访问使用；指令块不要调用。
 */
export function peripheralClockHz(b: Body, name: PeripheralClockName): Value<number> {
  const sources = clockSources();
  const hclk = dynamicOrFallback(b, CLOCK_CACHE.hclkHz, num(b, sources.fallbackHz));
  const pclk1 = dynamicOrFallback(b, CLOCK_CACHE.pclk1Hz, num(b, sources.fallbackHz));
  const pclk2 = dynamicOrFallback(b, CLOCK_CACHE.pclk2Hz, num(b, sources.fallbackHz));
  const pickCache = (offset: number, fallback: Value<number>): Value<number> =>
    b.select(
      types.number,
      b.equal(types.number, readClockEpoch(b), num(b, 0)),
      () => fallback,
      (inner) => loadCache(asBody(inner), offset),
    );

  let hz: Value<number>;

  switch (name) {
    case 'gpioA':
    case 'gpioB':
    case 'gpioC':
    case 'gpioD':
    case 'gpioE':
    case 'gpioF':
    case 'dma1':
    case 'dma2':
    case 'dmamux1':
    case 'crc':
    case 'flash':
      hz = hclk;
      break;
    case 'adc12':
      hz = pickCache(CLOCK_CACHE.adc12Hz, pclk2);
      break;
    case 'usart1':
      hz = pickCache(CLOCK_CACHE.usart1Hz, pclk2);
      break;
    case 'usart2':
      hz = pickCache(CLOCK_CACHE.usart2Hz, pclk1);
      break;
    case 'usart3':
      hz = pickCache(CLOCK_CACHE.usart3Hz, pclk1);
      break;
    case 'uart4':
      hz = pickCache(CLOCK_CACHE.uart4Hz, pclk1);
      break;
    case 'lpuart1':
      hz = pickCache(CLOCK_CACHE.lpuart1Hz, pclk1);
      break;
    case 'i2c1':
      hz = pickCache(CLOCK_CACHE.i2c1Hz, pclk1);
      break;
    case 'i2c2':
      hz = pickCache(CLOCK_CACHE.i2c2Hz, pclk1);
      break;
    case 'i2c3':
      hz = pickCache(CLOCK_CACHE.i2c3Hz, pclk1);
      break;
    case 'tim1':
    case 'tim8':
    case 'tim15':
    case 'tim16':
    case 'tim17':
      hz = pickCache(CLOCK_CACHE.timApb2Hz, pclk2);
      break;
    case 'tim2':
    case 'tim3':
    case 'tim4':
    case 'tim6':
    case 'tim7':
      hz = pickCache(CLOCK_CACHE.timApb1Hz, pclk1);
      break;
    case 'syscfg':
    case 'spi1':
    case 'sai1':
      hz = pclk2;
      break;
    case 'lptim1':
    case 'spi2':
    case 'spi3':
    case 'pwr':
    case 'usb':
    case 'fdcan':
    case 'ucpd1':
      hz = pclk1;
      break;
    // AHB2 外设的寄存器接口按 HCLK；RNG/DAC 的模拟时钟选择不在本模块建模，
    // 需要时由模块自己的 CCIPR 读取决定。
    case 'dac1':
    case 'dac3':
    case 'rng':
      hz = hclk;
      break;
  }

  const usable = boolAnd(b, clockGateEnabled(b, name), b.not(clockGateResetHeld(b, name)));

  return b.select(
    types.number,
    usable,
    () => hz,
    (inner) => inner.constant(types.number, 0),
  );
}

export interface TimerClockTarget {
  readonly name: string;
}

/**
 * `tim.ts` 的 `setTimerClockProvider` 钩子：按实例名返回 APB 时钟（已含倍频），
 * 门控/复位时返回 0。中央在创建 Machine 时调用
 * `setTimerClockProvider(timerClockProvider)`；未接线时定时器退回
 * `machine().clockFrequency`。
 */
export function timerClockProvider(b: Body, target: TimerClockTarget): Value<number> {
  switch (target.name) {
    case 'TIM1':
      return peripheralClockHz(b, 'tim1');
    case 'TIM2':
      return peripheralClockHz(b, 'tim2');
    case 'TIM3':
      return peripheralClockHz(b, 'tim3');
    case 'TIM4':
      return peripheralClockHz(b, 'tim4');
    case 'TIM6':
      return peripheralClockHz(b, 'tim6');
    case 'TIM7':
      return peripheralClockHz(b, 'tim7');
    case 'TIM8':
      return peripheralClockHz(b, 'tim8');
    case 'TIM15':
      return peripheralClockHz(b, 'tim15');
    case 'TIM16':
      return peripheralClockHz(b, 'tim16');
    case 'TIM17':
      return peripheralClockHz(b, 'tim17');
    default:
      return readHclkHz(b);
  }
}

/** USART/UART/LPUART 的实际输入时钟，供中央把 BRR 写入路径接到时钟缓存。 */
export function serialClockHz(b: Body, index: number): Value<number> {
  switch (index) {
    case 1:
      return peripheralClockHz(b, 'usart1');
    case 2:
      return peripheralClockHz(b, 'usart2');
    case 3:
      return peripheralClockHz(b, 'usart3');
    case 4:
      return peripheralClockHz(b, 'uart4');
    case 5:
      return peripheralClockHz(b, 'lpuart1');
    default:
      return num(b, 0);
  }
}
