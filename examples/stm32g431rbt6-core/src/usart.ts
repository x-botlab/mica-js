import { types } from '@mica-js/sdk/model';
import type { Local, Value } from '@mica-js/sdk/model';
import {
  GPIO_SYNC,
  IRQ_DIRTY,
  PERIPH,
  SERVICE_IRQ,
  RCC_RCC_STATE,
  SERVICE_PIN_SYNC,
  TICK_PS,
  TX_MASK,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
  USART_STATE,
  USART_STATE_STRIDE,
  gpioAfr0State,
  gpioAfr1State,
  gpioModerState,
  txState,
} from './layout';
import type { TxField } from './layout';
import {
  LPUART1_BASE,
  UART4_BASE,
  USART_EXT_TX_STATE,
  USART_EXT_TX_STRIDE,
  USART_RX_BITS,
  USART_RX_DATA_FE,
  USART_RX_DATA_IDLE,
  USART_RX_DATA_MASK,
  USART_RX_DATA_NE,
  USART_RX_DATA_ORE,
  USART_RX_DATA_RXNE,
  USART_RX_FIELDS,
  USART_RX_PHASE_FRAME_DONE,
  USART_RX_PHASE_INDEX_SHIFT,
  USART_RX_PHASE_LINE_HIGH,
  USART_RX_PHASE_STAGE_MASK,
  USART_RX_STAGE_DATA,
  USART_RX_STAGE_IDLE,
  USART_RX_STAGE_START,
  USART_RX_STAGE_STOP,
  USART_RX_STATE,
  USART_RX_STRIDE,
  USART_CLOCK_CACHE_OFFSETS,
  USART_RX_TIME_FIELDS,
  USART_TX_BITS,
  USART_TX_FIELDS,
  USART_TX_TIME_FIELDS,
} from './usart-layout';
import { PORTS, machine } from './machine';
import type { AlternateDriver } from './machine';
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
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { syncPin } from './gpio';
import { refreshTick } from './tick';

/**
 * STM32G431RBT6 的串口模型（USART1/2/3、UART4、LPUART1）。
 *
 * 支持异步 8N1 的发送与接收：
 * - 发送沿用原来的 TXE/TC、TDR 队列、逐位引脚输出；补充位相位刷新与跨长时间推进时
 *   一次消费多个位，避免长节拍漏位；
 * - 接收按 RXD 引脚的真实电平采样，起始位中点复核，8 个数据位 LSB first，停止位中点
 *   完成一帧；RXNE、ORE、FE、NE、IDLE 由接收状态机产生；
 * - BRR 按 OVER8 计算 USART 位时长；LPUART1 用 256×BRR 的 LPUART 公式；
 * - ICR 清除 RX 错误/IDLE 标志，RQR.RXFRQ 清空 RXNE/RDR；RDR 读清 RXNE；
 * - RXNEIE、IDLEIE、EIE 参与中断挂起；ISR 提供 TEACK/REACK；
 * - UE=0 或 RE=0 时取消半帧接收；复位由 `periph`/`txMask` 的初始值完成。
 *
 * 明确不建模：同步模式、硬件流控、LIN/IrDA/智能卡、DMA、FIFO、9 位数据、奇偶校验、
 * 多处理器地址过滤、自动波特率、接收超时、PRESC 预分频与 STOP≠1 的停止位。CR2/CR3
 * 中这些模式的配置位可以保存，但不会改变 8N1 的位时序。NE 用「起始位中点复核失败」
 * 近似，不做真机的三取二多数采样。
 *
 * 未启用接收器时，`txMask` 的高位为零：`refreshTick` 不会因 RX 收紧节拍，服务块也
 * 不做任何 RXD 采样。RX 内部状态放在 `periph` 的空闲区（见 `usart-layout.ts`），
 * 因此不增加 DDL state，也不影响 USART1–3 原有的发送状态布局。
 */

export type UsartKind = 'usart' | 'uart' | 'lpuart';

export interface UsartPin {
  readonly port: number;
  readonly pin: number;
  readonly af: number;
}

export interface UsartConfig {
  readonly index: number;
  readonly kind: UsartKind;
  readonly base: number;
  readonly irq: number;
  readonly txPins: readonly UsartPin[];
  readonly rxPins: readonly UsartPin[];
  /** 原生 USART1–3 继续发布到原有通道；UART4/LPUART1 可由中央适配器传入通道名。 */
  readonly txChannel?: string;
}

export const USARTS: readonly UsartConfig[] = [
  {
    index: 1,
    kind: 'usart',
    base: USART1_BASE,
    irq: 37,
    txPins: [
      { port: 0, pin: 9, af: 7 },
      { port: 1, pin: 6, af: 7 },
      { port: 2, pin: 4, af: 7 },
    ],
    rxPins: [
      { port: 0, pin: 10, af: 7 },
      { port: 1, pin: 7, af: 7 },
      { port: 2, pin: 5, af: 7 },
    ],
    txChannel: 'uart1Tx',
  },
  {
    index: 2,
    kind: 'usart',
    base: USART2_BASE,
    irq: 38,
    txPins: [
      { port: 0, pin: 2, af: 7 },
      { port: 0, pin: 14, af: 7 },
      { port: 1, pin: 3, af: 7 },
    ],
    rxPins: [
      { port: 0, pin: 3, af: 7 },
      { port: 0, pin: 15, af: 7 },
      { port: 1, pin: 4, af: 7 },
    ],
    txChannel: 'uart2Tx',
  },
  {
    index: 3,
    kind: 'usart',
    base: USART3_BASE,
    irq: 39,
    txPins: [
      { port: 1, pin: 10, af: 7 },
      { port: 1, pin: 9, af: 7 },
      { port: 2, pin: 10, af: 7 },
    ],
    rxPins: [
      { port: 1, pin: 11, af: 7 },
      { port: 1, pin: 8, af: 7 },
      { port: 2, pin: 11, af: 7 },
    ],
    txChannel: 'uart3Tx',
  },
  {
    index: 4,
    kind: 'uart',
    base: UART4_BASE,
    irq: 52,
    txPins: [{ port: 2, pin: 10, af: 5 }],
    rxPins: [{ port: 2, pin: 11, af: 5 }],
  },
  {
    index: 5,
    kind: 'lpuart',
    base: LPUART1_BASE,
    irq: 91,
    txPins: [
      { port: 0, pin: 2, af: 12 },
      { port: 1, pin: 11, af: 8 },
      { port: 2, pin: 1, af: 8 },
    ],
    rxPins: [
      { port: 0, pin: 3, af: 12 },
      { port: 1, pin: 10, af: 8 },
      { port: 2, pin: 0, af: 8 },
    ],
  },
];

const CR1 = 0x00;
const CR2 = 0x04;
const CR3 = 0x08;
const BRR = 0x0c;
const GTPR = 0x10;
const RTOR = 0x14;
const RQR = 0x18;
const ISR = 0x1c;
const ICR = 0x20;
const RDR = 0x24;
const TDR = 0x28;
const PRESC = 0x2c;

const BIT_COUNT = 10;
const PICOSECONDS_PER_SECOND = 1_000_000_000_000;
/** JS 安全整数上限；低时钟 + 极大 BRR 的位时长截到这个上限。 */
const MAX_SAFE_TIME_PS = Number.MAX_SAFE_INTEGER;

const CR1_UE = 1 << 0;
const CR1_RE = 1 << 2;
const CR1_TE = 1 << 3;
const CR1_IDLEIE = 1 << 4;
const CR1_RXNEIE = 1 << 5;
const CR1_OVER8 = 1 << 15;
const CR3_EIE = 1 << 0;
const CR3_DMAR = 1 << 6;
const CR3_DMAT = 1 << 7;
const CR3_OVRDIS = 1 << 12;

const ISR_FE = 1 << 1;
const ISR_NE = 1 << 2;
const ISR_ORE = 1 << 3;
const ISR_IDLE = 1 << 4;
const ISR_RXNE = 1 << 5;
const ISR_TEACK = 1 << 21;
const ISR_REACK = 1 << 22;

const ICR_FECF = 1 << 1;
const ICR_NCF = 1 << 2;
const ICR_ORECF = 1 << 3;
const ICR_IDLECF = 1 << 4;
const RQR_RXFRQ = 1 << 3;

const defaultTxChannels: Readonly<Record<number, string | undefined>> = {
  1: 'uart1Tx',
  2: 'uart2Tx',
  3: 'uart3Tx',
};

export type UsartTxChannels = Readonly<Record<number, string | undefined>>;

/** 5 路串口的寄存器影子连续排布；TIM 已迁到独立的 `tim` memory。 */
const registerBase = (config: UsartConfig): number =>
  USART_STATE + (config.index - 1) * USART_STATE_STRIDE;

const extTxBase = (config: UsartConfig): number =>
  USART_EXT_TX_STATE + (config.index - 4) * USART_EXT_TX_STRIDE;

const rxBase = (config: UsartConfig): number =>
  USART_RX_STATE + (config.index - 1) * USART_RX_STRIDE;

const txMaskBit = (config: UsartConfig): number => 1 << (config.index - 1);

const rxMaskBit = (config: UsartConfig): number => 1 << (8 + config.index - 1);

const load = (b: Body, config: UsartConfig, offset: number): Value<number> =>
  readWordAt(b, PERIPH, registerBase(config) + offset);

const loadAt = (b: Body, config: UsartConfig, offset: Value<number>): Value<number> =>
  readWord(b, PERIPH, b.add(num(b, registerBase(config)), offset));

const storeAt = (
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  value: Value<number>,
): void => {
  writeWord(b, PERIPH, b.add(num(b, registerBase(config)), offset), value);
};

const loadRx = (b: Body, config: UsartConfig, field: keyof typeof USART_RX_FIELDS): Value<number> =>
  readWordAt(b, PERIPH, rxBase(config) + USART_RX_FIELDS[field]);

const storeRx = (
  b: Body,
  config: UsartConfig,
  field: keyof typeof USART_RX_FIELDS,
  value: Value<number>,
): void => {
  writeWordAt(b, PERIPH, rxBase(config) + USART_RX_FIELDS[field], u32(b, value));
};

/** 32 位 word 对拼成安全整数；时间字段单位 ps。 */
const timeFromWords = (b: Body, lo: Value<number>, hi: Value<number>): Value<number> =>
  b.add(u32(b, lo), b.multiply(u32(b, hi), num(b, 0x1_0000_0000)));

/** 安全整数拆成 lo/hi 两个 32 位 word。 */
function timeWords(
  b: Body,
  value: Value<number>,
): { readonly lo: Value<number>; readonly hi: Value<number> } {
  const hi = b.floor(b.divide(b.max(value, num(b, 0)), num(b, 0x1_0000_0000)));

  return {
    hi,
    lo: b.subtract(b.max(value, num(b, 0)), b.multiply(hi, num(b, 0x1_0000_0000))),
  };
}

const readRxTime = (b: Body, config: UsartConfig): Value<number> =>
  timeFromWords(
    b,
    readWordAt(b, PERIPH, rxBase(config) + USART_RX_TIME_FIELDS.RemainingLo),
    readWordAt(b, PERIPH, rxBase(config) + USART_RX_TIME_FIELDS.RemainingHi),
  );

const writeRxTime = (b: Body, config: UsartConfig, value: Value<number>): void => {
  const words = timeWords(b, value);

  writeWordAt(b, PERIPH, rxBase(config) + USART_RX_TIME_FIELDS.RemainingLo, words.lo);
  writeWordAt(b, PERIPH, rxBase(config) + USART_RX_TIME_FIELDS.RemainingHi, words.hi);
};

const readExtTime = (b: Body, config: UsartConfig, field: 'Remaining' | 'Period'): Value<number> =>
  field === 'Remaining'
    ? timeFromWords(
        b,
        readWordAt(b, PERIPH, extTxBase(config) + USART_TX_TIME_FIELDS.RemainingLo),
        readWordAt(b, PERIPH, extTxBase(config) + USART_TX_TIME_FIELDS.RemainingHi),
      )
    : timeFromWords(
        b,
        readWordAt(b, PERIPH, extTxBase(config) + USART_TX_TIME_FIELDS.PeriodLo),
        readWordAt(b, PERIPH, extTxBase(config) + USART_TX_TIME_FIELDS.PeriodHi),
      );

const writeExtTime = (
  b: Body,
  config: UsartConfig,
  field: 'Remaining' | 'Period',
  value: Value<number>,
): void => {
  const words = timeWords(b, value);
  const base =
    field === 'Remaining' ? USART_TX_TIME_FIELDS.RemainingLo : USART_TX_TIME_FIELDS.PeriodLo;

  writeWordAt(b, PERIPH, extTxBase(config) + base, words.lo);
  writeWordAt(b, PERIPH, extTxBase(config) + base + 4, words.hi);
};

const readTx = (b: Body, config: UsartConfig, field: TxField): Value<number> => {
  if (config.index <= 3) return b.readState(txState(config.index, field), types.number);
  if (field === 'Remaining' || field === 'Period') return readExtTime(b, config, field);

  return readWordAt(b, PERIPH, extTxBase(config) + USART_TX_FIELDS[field]);
};

const writeTx = (
  b: Body,
  config: UsartConfig,
  field: Exclude<TxField, 'Publish'>,
  value: Value<number>,
): void => {
  if (config.index <= 3) {
    // Remaining/Period 是 number state，不能截成 32 位；低时钟/低波特率的位时长可超过 4.295 ms。
    b.writeState(
      txState(config.index, field),
      field === 'Remaining' || field === 'Period' ? value : u32(b, value),
    );

    return;
  }

  if (field === 'Remaining' || field === 'Period') {
    writeExtTime(b, config, field, value);

    return;
  }

  writeWordAt(b, PERIPH, extTxBase(config) + USART_TX_FIELDS[field], u32(b, value));
};

/**
 * 发送发布状态。原生 USART1–3 沿用 DDL 的 `-1` 哨兵；UART4/LPUART1 没有 DDL
 * state，使用 `0x100 | byte` 表示有待发布字节，0 表示没有。
 */
const readPublish = (b: Body, config: UsartConfig): Value<number> =>
  config.index <= 3
    ? b.readState(txState(config.index, 'Publish'), types.number)
    : readWordAt(b, PERIPH, extTxBase(config) + USART_TX_FIELDS.Publish);

const writePublish = (b: Body, config: UsartConfig, value: Value<number>): void => {
  if (config.index <= 3) b.writeState(txState(config.index, 'Publish'), value);
  else
    writeWordAt(
      b,
      PERIPH,
      extTxBase(config) + USART_TX_FIELDS.Publish,
      b.bitOr(b.bitAnd(u32(b, value), num(b, 0xff)), num(b, 0x100)),
    );
};

const clearPublish = (b: Body, config: UsartConfig): void => {
  if (config.index <= 3) b.writeState(txState(config.index, 'Publish'), num(b, -1));
  else writeWordAt(b, PERIPH, extTxBase(config) + USART_TX_FIELDS.Publish, num(b, 0));
};

const bitPeriod = (b: Body, config: UsartConfig): Value<number> => readTx(b, config, 'Period');

/**
 * 活动 USART 距下一次必须处理的 TX 位边界 / RX 采样点的最小皮秒数。
 *
 * 0 表示没有需要按时间推进的活动。中央的 `refreshTick` 应把 `tickPs` 收紧到这个值；
 * 这样高波特率（位周期 < 1 µs）不会把多个位边沿塞进同一个同步片段，RX 也不会用
 * 同一个当前电平补多个历史采样点。
 */
export function usartNextEventPs(b: Body): Value<number> {
  const mask = b.readState(TX_MASK, types.number);
  const best = b.local(types.number, MAX_SAFE_TIME_PS);
  const found = b.local(types.bool, false);

  const consider = (body: Body, value: Value<number>): void => {
    body.if(body.greaterThan(value, num(body, 0)), (positive) => {
      const scope = asBody(positive);

      scope.if(scope.lessThan(value, scope.getLocal(best)), (shorter) => {
        const inner = asBody(shorter);

        inner.setLocal(best, value);
        inner.setLocal(found, bool(inner, true));
      });
    });
  };

  for (const config of USARTS) {
    b.if(boolBitAt(b, mask, config.index - 1), (tx) => {
      const scope = asBody(tx);

      scope.if(boolBitAt(scope, readTx(scope, config, 'Active'), 0), (active) =>
        consider(asBody(active), readTx(asBody(active), config, 'Remaining')),
      );
    });
    b.if(boolBitAt(b, mask, 8 + config.index - 1), (rx) => {
      const scope = asBody(rx);
      const period = bitPeriod(scope, config);
      const idleDeadline = scope.max(scope.divide(period, num(scope, 8)), num(scope, 1));
      const stage = scope.bitAnd(
        loadRx(scope, config, 'Phase'),
        num(scope, USART_RX_PHASE_STAGE_MASK),
      );

      scope.if(
        scope.equal(types.number, stage, num(scope, USART_RX_STAGE_IDLE)),
        (idle) => consider(asBody(idle), idleDeadline),
        (busy) => consider(asBody(busy), readRxTime(asBody(busy), config)),
      );
    });
  }

  return b.select(
    types.number,
    b.getLocal(found),
    (yes) => yes.getLocal(best),
    (none) => none.constant(types.number, 0),
  );
}

/** 先走中央 refreshTick，再把 USART 的真实下一事件收紧进去。 */
function refreshUsartTick(b: Body): void {
  refreshTick(b);
  const next = usartNextEventPs(b);

  b.if(
    boolAnd(
      b,
      b.greaterThan(next, num(b, 0)),
      b.lessThan(next, b.readState(TICK_PS, types.number)),
    ),
    (shorter) => {
      asBody(shorter).writeState(TICK_PS, next);
    },
  );
}

/** RCC/clock-tree 缓存的该路实际外设时钟；0 表示尚未重算，退回机器时钟。 */
function usartClock(b: Body, config: UsartConfig): Value<number> {
  const offset = USART_CLOCK_CACHE_OFFSETS[config.index] ?? 0;
  const cached = readWordAt(b, PERIPH, RCC_RCC_STATE + offset);
  const fallback = num(b, machine().clockFrequency);

  return b.select(
    types.number,
    b.greaterThan(cached, num(b, 0)),
    () => cached,
    () => fallback,
  );
}

export function usartEnabled(b: Body, config: UsartConfig): Value<boolean> {
  const cr1 = load(b, config, CR1);

  return boolAnd(b, boolBitAt(b, cr1, 0), boolBitAt(b, cr1, 3));
}

/** 接收通道需要 UE=1 且 RE=1；TE 不参与。 */
export function usartReceiverEnabled(b: Body, config: UsartConfig): Value<boolean> {
  const cr1 = load(b, config, CR1);

  return boolAnd(b, boolBitAt(b, cr1, 0), boolBitAt(b, cr1, 2));
}

export function usartTxLevel(b: Body, config: UsartConfig): Value<boolean> {
  const word = readTx(b, config, 'Active');
  const active = boolBitAt(b, word, 0);
  const index = b.bitAnd(b.shiftRightUnsigned(word, num(b, 8)), num(b, 0xff));
  const byte = b.bitAnd(b.shiftRightUnsigned(word, num(b, 16)), num(b, 0xff));
  const start = b.equal(types.number, index, num(b, 0));
  const dataBit = b.bitAnd(b.shiftRightUnsigned(byte, b.subtract(index, num(b, 1))), num(b, 1));
  const level = b.select(
    types.number,
    active,
    (inner) =>
      inner.select(
        types.number,
        start,
        (inner2) => inner2.constant(types.number, 0),
        (inner2) =>
          inner2.select(
            types.number,
            inner2.lessThan(index, inner2.constant(types.number, 9)),
            (inner3) => inner3.bitAnd(dataBit, inner3.constant(types.number, 1)),
            (inner3) => inner3.constant(types.number, 1),
          ),
      ),
    (inner) => inner.constant(types.number, 1),
  );

  return b.notEqual(types.number, level, num(b, 0));
}

/** 标记这些 TX 引脚所在的端口：引脚意图由服务块整口刷新，写块因此保持很小。 */
function syncTxPins(b: Body, config: UsartConfig): void {
  let mask = 0;

  for (const pin of config.txPins) mask |= 1 << pin.port;
  b.writeState(GPIO_SYNC, b.bitOr(b.readState(GPIO_SYNC, types.number), num(b, mask)));
  markService(b, SERVICE_PIN_SYNC);
}

/** 位相位变化后立即刷新 TX 引脚意图；位时序不依赖下一次寄存器写或端口同步。 */
function refreshTxPins(b: Body, config: UsartConfig): void {
  for (const pin of config.txPins) {
    if (PORTS[pin.port]?.pins[pin.pin] === undefined) continue;
    if (PORTS[pin.port]?.pins[pin.pin] === null) continue;
    syncPin(b, pin.port, pin.pin);
  }
}

/** 标记该路有发送活动，节拍推进才会看它。 */
function markBusy(b: Body, config: UsartConfig): void {
  b.writeState(TX_MASK, b.bitOr(b.readState(TX_MASK, types.number), num(b, txMaskBit(config))));
  // 发送期间服务节拍要细到位时长量级。
  refreshUsartTick(b);
}

/** 更新接收器在 `txMask` 高位中的活动位；变化时重算服务节拍。 */
function updateRxMask(b: Body, config: UsartConfig, enabled: Value<boolean>): void {
  const bit = rxMaskBit(config);
  const mask = b.readState(TX_MASK, types.number);
  const wasEnabled = b.notEqual(types.number, b.bitAnd(mask, num(b, bit)), num(b, 0));
  const changed = b.notEqual(types.bool, wasEnabled, enabled);
  const next = b.select(
    types.number,
    enabled,
    (inner) => inner.bitOr(mask, inner.constant(types.number, bit)),
    (inner) => inner.bitAnd(mask, inner.constant(types.number, ~bit)),
  );

  b.if(changed, (hit) => {
    const body = asBody(hit);

    body.writeState(TX_MASK, next);
    refreshUsartTick(body);
  });
}

function resetReceiver(b: Body, config: UsartConfig): void {
  storeRx(b, config, 'Phase', num(b, USART_RX_STAGE_IDLE));
  writeRxTime(b, config, num(b, 0));
  storeRx(b, config, 'Shift', num(b, 0));
}

function markRxIrq(b: Body): void {
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

function startByte(b: Body, config: UsartConfig, value: Value<number>): void {
  const byte = b.bitAnd(u32(b, value), num(b, 0xff));

  // Active：bit0=活动，bits8–15=位序号，bits16–23=数据字节。字节必须放到高 8 位；
  // 只写低 8 位会让引脚始终发 0，而串口 topic 仍发布原字节。
  writeTx(b, config, 'Active', b.bitOr(b.shiftLeft(byte, num(b, 16)), num(b, 1)));
  writeTx(b, config, 'Remaining', bitPeriod(b, config));
  writePublish(b, config, byte);
  // 起始位从低电平开始；进入发送时也要让引脚立刻反映新相位。
  syncTxPins(b, config);
  markBusy(b, config);
}

/** 发布已开始的字节；只在服务块里调用。 */
function publishByte(b: Body, config: UsartConfig, channel: string | undefined): void {
  const pending = readPublish(b, config);

  if (config.index <= 3) {
    b.if(b.greaterThanOrEqual(pending, num(b, 0)), (inner) => {
      const body = asBody(inner);

      if (channel !== undefined) body.send(channel, pending);
      clearPublish(body, config);
    });

    return;
  }

  b.if(b.notEqual(types.number, b.bitAnd(pending, num(b, 0x100)), num(b, 0)), (inner) => {
    const body = asBody(inner);

    if (channel !== undefined) body.send(channel, body.bitAnd(pending, num(body, 0xff)));
    clearPublish(body, config);
  });
}

function dequeue(b: Body, config: UsartConfig): void {
  const queue = readTx(b, config, 'Queue');
  const count = readTx(b, config, 'Count');

  writeTx(b, config, 'Queue', b.shiftRightUnsigned(queue, num(b, 8)));
  writeTx(b, config, 'Count', b.subtract(count, num(b, 1)));
  startByte(b, config, b.bitAnd(queue, num(b, 0xff)));
}

function enqueue(b: Body, config: UsartConfig, value: Value<number>): void {
  const count = readTx(b, config, 'Count');
  const active = boolBitAt(b, readTx(b, config, 'Active'), 0);

  b.if(
    b.not(active),
    (start) => startByte(asBody(start), config, value),
    (queued) => {
      const body = asBody(queued);

      body.if(body.lessThan(count, num(body, 4)), (room) => {
        const inner = asBody(room);
        const queue = readTx(inner, config, 'Queue');
        const position = inner.multiply(count, inner.constant(types.number, 8));
        const placed = inner.shiftLeft(
          inner.bitAnd(u32(inner, value), inner.constant(types.number, 0xff)),
          position,
        );

        writeTx(inner, config, 'Queue', inner.bitOr(queue, placed));
        writeTx(inner, config, 'Count', inner.add(count, inner.constant(types.number, 1)));
      });
    },
  );
}

/** 推进一个位相位；帧结束时可以立即从队列启动下一字节。 */
function advanceOneBit(b: Body, config: UsartConfig, dirty: Local<boolean>): void {
  const active = readTx(b, config, 'Active');

  b.if(boolBitAt(b, active, 0), (busy) => {
    const scope = asBody(busy);
    const index = scope.bitAnd(
      scope.shiftRightUnsigned(readTx(scope, config, 'Active'), num(scope, 8)),
      num(scope, 0xff),
    );
    const next = scope.add(index, num(scope, 1));

    scope.if(
      scope.greaterThan(next, num(scope, BIT_COUNT)),
      (finished) => {
        const done = asBody(finished);
        const count = readTx(done, config, 'Count');

        writeTx(done, config, 'Active', num(done, 0));
        writeTx(done, config, 'Remaining', num(done, 0));
        done.setLocal(dirty, bool(done, true));
        // 字节结束：TXE/TC 可能变为有效，需要重新扫描异常。
        done.writeState(IRQ_DIRTY, bool(done, true));
        markService(done, SERVICE_IRQ);
        done.if(
          done.greaterThan(count, num(done, 0)),
          (more) => dequeue(asBody(more), config),
          (idle) => {
            const body2 = asBody(idle);

            body2.writeState(
              TX_MASK,
              body2.bitAnd(
                body2.readState(TX_MASK, types.number),
                num(body2, ~txMaskBit(config) & 0xffffffff),
              ),
            );
            // 发送结束后恢复空闲粒度。
            refreshUsartTick(body2);
          },
        );
      },
      (nextBit) => {
        const body2 = asBody(nextBit);
        const current = readTx(body2, config, 'Active');
        const shifted = body2.bitOr(
          body2.bitAnd(current, num(body2, 0xffff00ff)),
          body2.shiftLeft(next, num(body2, 8)),
        );

        writeTx(body2, config, 'Active', shifted);
        writeTx(body2, config, 'Remaining', bitPeriod(body2, config));
        body2.setLocal(dirty, bool(body2, true));
      },
    );
  });
}

/**
 * 发送器按经过时间消费所有到期的位相位。
 *
 * 原来的实现每次服务最多推进一个位：一旦一个长节拍跨过多个位，后续调用会用负的剩余
 * 时间继续「补位」，实际引脚波形会漏位。这里用循环把每个到期位都走完，剩余时间再
 * 写回；队列中的下一字节也在同一次推进里接上。
 */
function advanceTransmitter(b: Body, config: UsartConfig, elapsedPs: Value<number>): void {
  b.if(
    b.notEqual(
      types.number,
      b.bitAnd(b.readState(TX_MASK, types.number), num(b, txMaskBit(config))),
      num(b, 0),
    ),
    (inner) => {
      const body = asBody(inner);
      const dirty = body.local(types.bool, false);
      const active = readTx(body, config, 'Active');
      const remaining = readTx(body, config, 'Remaining');
      const due = boolAnd(
        body,
        boolBitAt(body, active, 0),
        body.lessThanOrEqual(remaining, elapsedPs),
      );

      // 一次服务最多推进一个位；中央必须用 usartNextEventPs 把 tick 收紧到位边界。
      // 超出边界时只消费一个位，剩余时间从下一 bit 的初始剩余中扣除并夹到 1 ps，
      // 不在同一个同步片段里伪造多个引脚边沿。
      body.if(
        due,
        (hit) => {
          const scope = asBody(hit);
          const after = scope.subtract(elapsedPs, remaining);

          advanceOneBit(scope, config, dirty);
          scope.if(boolBitAt(scope, readTx(scope, config, 'Active'), 0), (still) => {
            const next = asBody(still);

            writeTx(
              next,
              config,
              'Remaining',
              next.max(next.subtract(readTx(next, config, 'Remaining'), after), num(next, 1)),
            );
          });
        },
        (notDue) => {
          const scope = asBody(notDue);

          scope.if(
            boolBitAt(scope, active, 0),
            (still) =>
              writeTx(
                asBody(still),
                config,
                'Remaining',
                asBody(still).subtract(readTx(asBody(still), config, 'Remaining'), elapsedPs),
              ),
            (idle) => writeTx(asBody(idle), config, 'Remaining', num(asBody(idle), 0)),
          );
        },
      );
      body.if(body.getLocal(dirty), (refresh) => refreshTxPins(asBody(refresh), config));
    },
  );
}

/** 引脚名；配置表只列 LQFP64 上存在的引脚。 */
function pinName(pin: UsartPin): string | undefined {
  const name = PORTS[pin.port]?.pins[pin.pin];

  return name ?? undefined;
}

function pinHigh(b: Body, pin: UsartPin): Value<boolean> {
  const name = pinName(pin);

  if (name === undefined) return bool(b, true);
  const level = b.field(b.readSample(name), 'level');

  return b.equal(types.logic, level, b.constant(types.logic, types.logic.members.high));
}

/** 当前 USART 选中的 RX 引脚电平；没有匹配的 AF 配置时按空闲高处理。 */
function receiverLevel(b: Body, config: UsartConfig): Value<boolean> {
  const result = b.local(types.bool, true);

  for (const pin of config.rxPins) {
    if (pinName(pin) === undefined) continue;
    const moder = b.readState(gpioModerState(pin.port), types.number);
    const afr = b.readState(
      pin.pin < 8 ? gpioAfr0State(pin.port) : gpioAfr1State(pin.port),
      types.number,
    );
    const mode = b.bitAnd(b.shiftRightUnsigned(moder, num(b, pin.pin * 2)), num(b, 3));
    const af = b.bitAnd(b.shiftRightUnsigned(afr, num(b, (pin.pin & 7) * 4)), num(b, 0xf));
    const selected = boolAnd(
      b,
      b.equal(types.number, mode, num(b, 2)),
      b.equal(types.number, af, num(b, pin.af)),
    );

    b.if(selected, (hit) => {
      const body = asBody(hit);

      body.setLocal(result, pinHigh(body, pin));
    });
  }

  return b.getLocal(result);
}

function setReceiveData(b: Body, config: UsartConfig, value: Value<number>): void {
  storeRx(b, config, 'Data', value);
}

function receiveComplete(
  b: Body,
  config: UsartConfig,
  data: Value<number>,
  stopHigh: Value<boolean>,
): void {
  const current = loadRx(b, config, 'Data');
  const rxne = boolBitAt(b, current, 13);
  const overrunDisabled = boolBitAt(b, load(b, config, CR3), 12);
  const stopError = b.select(
    types.number,
    stopHigh,
    (inner) => inner.constant(types.number, 0),
    (inner) => inner.constant(types.number, USART_RX_DATA_FE),
  );
  const kept = b.bitAnd(
    current,
    num(
      b,
      (0xffffffff &
        ~(
          USART_RX_DATA_MASK |
          USART_RX_DATA_RXNE |
          USART_RX_DATA_FE |
          USART_RX_DATA_NE |
          USART_RX_DATA_ORE
        )) >>>
        0,
    ),
  );
  const received = b.bitOr(
    b.bitOr(kept, b.bitAnd(u32(b, data), num(b, USART_RX_DATA_MASK))),
    b.bitOr(num(b, USART_RX_DATA_RXNE), stopError),
  );

  b.if(
    rxne,
    (overrun) => {
      const scope = asBody(overrun);

      scope.if(
        overrunDisabled,
        () => {},
        (store) => {
          const body = asBody(store);
          const updated = body.bitOr(received, num(body, USART_RX_DATA_ORE));

          setReceiveData(body, config, updated);
          markRxIrq(body);
        },
      );
    },
    (fresh) => {
      const body = asBody(fresh);

      setReceiveData(body, config, received);
      markRxIrq(body);
    },
  );
}

/** 一个采样点：起始位复核、数据位或停止位。 */
function stepReceiver(b: Body, config: UsartConfig, lineHigh: Value<boolean>): void {
  const phase = loadRx(b, config, 'Phase');
  const stage = b.bitAnd(phase, num(b, USART_RX_PHASE_STAGE_MASK));
  const period = bitPeriod(b, config);

  b.if(
    b.equal(types.number, stage, num(b, USART_RX_STAGE_START)),
    (start) => {
      const scope = asBody(start);

      scope.if(
        lineHigh,
        (invalid) => {
          const body = asBody(invalid);

          // 起始位中点仍为高：不是有效起始位。用 NE 近似真机的噪声检测。
          storeRx(body, config, 'Phase', num(body, USART_RX_STAGE_IDLE | USART_RX_PHASE_LINE_HIGH));
          writeRxTime(body, config, num(body, 0));
          setReceiveData(
            body,
            config,
            body.bitOr(loadRx(body, config, 'Data'), num(body, USART_RX_DATA_NE)),
          );
          markRxIrq(body);
        },
        (valid) => {
          const body = asBody(valid);

          storeRx(body, config, 'Phase', num(body, USART_RX_STAGE_DATA));
          storeRx(body, config, 'Shift', num(body, 0));
          writeRxTime(body, config, period);
        },
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, stage, num(body, USART_RX_STAGE_DATA)),
        (data) => {
          const scope = asBody(data);
          const index = scope.bitAnd(
            scope.shiftRightUnsigned(loadRx(scope, config, 'Phase'), num(scope, 8)),
            num(scope, 0xff),
          );
          const shift = loadRx(scope, config, 'Shift');
          const bit = scope.select(
            types.number,
            lineHigh,
            (inner) => inner.shiftLeft(inner.constant(types.number, 1), index),
            (inner) => inner.constant(types.number, 0),
          );
          const next = scope.add(index, num(scope, 1));
          const shifted = scope.bitOr(shift, bit);

          storeRx(scope, config, 'Shift', shifted);
          scope.if(
            scope.equal(types.number, next, num(scope, 8)),
            (stop) => {
              const inner = asBody(stop);

              storeRx(
                inner,
                config,
                'Phase',
                num(inner, USART_RX_STAGE_STOP | USART_RX_PHASE_LINE_HIGH),
              );
              writeRxTime(inner, config, period);
            },
            (more) => {
              const inner = asBody(more);

              storeRx(
                inner,
                config,
                'Phase',
                inner.bitOr(
                  num(inner, USART_RX_STAGE_DATA | USART_RX_PHASE_LINE_HIGH),
                  inner.shiftLeft(next, num(inner, USART_RX_PHASE_INDEX_SHIFT)),
                ),
              );
              writeRxTime(inner, config, period);
            },
          );
        },
        (last) => {
          const scope = asBody(last);

          scope.if(scope.equal(types.number, stage, num(scope, USART_RX_STAGE_STOP)), (stop) => {
            const body2 = asBody(stop);
            const shift = loadRx(body2, config, 'Shift');

            storeRx(
              body2,
              config,
              'Phase',
              body2.bitOr(
                num(body2, USART_RX_STAGE_IDLE),
                body2.select(
                  types.number,
                  lineHigh,
                  (inner) =>
                    inner.constant(
                      types.number,
                      USART_RX_PHASE_LINE_HIGH | USART_RX_PHASE_FRAME_DONE,
                    ),
                  (inner) => inner.constant(types.number, 0),
                ),
              ),
            );
            writeRxTime(body2, config, num(body2, 0));
            receiveComplete(body2, config, shift, lineHigh);
          });
        },
      );
    },
  );
}

/** 接收器：空闲时用真实 RXD 电平找起始位，忙帧按位中点采样。 */
function advanceReceiver(b: Body, config: UsartConfig, elapsedPs: Value<number>): void {
  b.if(
    b.notEqual(
      types.number,
      b.bitAnd(b.readState(TX_MASK, types.number), num(b, rxMaskBit(config))),
      num(b, 0),
    ),
    (inner) => {
      const body = asBody(inner);
      const lineHigh = receiverLevel(body, config);
      const phase = loadRx(body, config, 'Phase');
      const stage = body.bitAnd(phase, num(body, USART_RX_PHASE_STAGE_MASK));

      body.if(
        body.equal(types.number, stage, num(body, USART_RX_STAGE_IDLE)),
        (idle) => {
          const scope = asBody(idle);

          scope.if(
            lineHigh,
            (high) => {
              const active = asBody(high);
              const frameDone = boolBitAt(active, phase, 17);

              storeRx(
                active,
                config,
                'Phase',
                num(active, USART_RX_STAGE_IDLE | USART_RX_PHASE_LINE_HIGH),
              );
              active.if(frameDone, (done) => {
                const body2 = asBody(done);

                setReceiveData(
                  body2,
                  config,
                  body2.bitOr(loadRx(body2, config, 'Data'), num(body2, USART_RX_DATA_IDLE)),
                );
                markRxIrq(body2);
              });
            },
            (low) => {
              const lowBody = asBody(low);
              const wasHigh = boolBitAt(lowBody, phase, 16);

              lowBody.if(
                wasHigh,
                (start) => {
                  const body2 = asBody(start);
                  const period = bitPeriod(body2, config);
                  const half = body2.divide(period, num(body2, 2));
                  const age = body2.divide(elapsedPs, num(body2, 2));
                  const remaining = body2.max(
                    num(body2, 1),
                    body2.subtract(half, body2.min(age, half)),
                  );

                  // 检测到下降沿时，边沿可能落在本次 elapsed 内；按其中点估计，
                  // 把起始位采样点放到半个位时间之后。
                  storeRx(
                    body2,
                    config,
                    'Phase',
                    num(body2, USART_RX_STAGE_START | USART_RX_PHASE_LINE_HIGH),
                  );
                  writeRxTime(body2, config, remaining);
                  storeRx(body2, config, 'Shift', num(body2, 0));
                },
                (noStart) => {
                  const body2 = asBody(noStart);

                  // 没有先看到高电平：保持等待，避免复位/断开时的持续低电平开帧。
                  storeRx(body2, config, 'Phase', num(body2, USART_RX_STAGE_IDLE));
                },
              );
            },
          );
        },
        (busy) => {
          const scope = asBody(busy);
          const remaining = readRxTime(scope, config);
          const due = scope.lessThanOrEqual(remaining, elapsedPs);

          // 一次服务只消费一个采样点。若调度超出下一个采样边界，只把该采样点
          // 用当前真实电平处理一次，不把同一个 lineSample 复用给多个历史 bit。
          scope.if(
            due,
            (hit) => {
              const inner = asBody(hit);
              const after = inner.subtract(elapsedPs, remaining);

              stepReceiver(inner, config, lineHigh);
              inner.if(
                inner.notEqual(
                  types.number,
                  inner.bitAnd(
                    loadRx(inner, config, 'Phase'),
                    num(inner, USART_RX_PHASE_STAGE_MASK),
                  ),
                  num(inner, USART_RX_STAGE_IDLE),
                ),
                (still) => {
                  const body2 = asBody(still);

                  writeRxTime(
                    body2,
                    config,
                    body2.max(body2.subtract(readRxTime(body2, config), after), num(body2, 1)),
                  );
                },
              );
            },
            (notDue) => {
              const inner = asBody(notDue);

              writeRxTime(inner, config, inner.subtract(remaining, elapsedPs));
            },
          );
        },
      );
    },
  );
}

/** 每个外设节拍推进发送器与接收器；只处理仍在活动的通道。 */
export function advanceUsart(
  b: Body,
  elapsedPs: Value<number>,
  channels: UsartTxChannels = defaultTxChannels,
): void {
  for (const config of USARTS) publishByte(b, config, channels[config.index] ?? config.txChannel);

  const mask = b.readState(TX_MASK, types.number);

  b.if(b.notEqual(types.number, b.bitAnd(mask, num(b, USART_TX_BITS)), num(b, 0)), (tx) => {
    const body = asBody(tx);

    for (const config of USARTS) advanceTransmitter(body, config, elapsedPs);
  });
  b.if(b.notEqual(types.number, b.bitAnd(mask, num(b, USART_RX_BITS)), num(b, 0)), (rx) => {
    const body = asBody(rx);

    for (const config of USARTS)
      body.if(boolBitAt(body, mask, 8 + config.index - 1), (on) => {
        const scope = asBody(on);

        scope.if(
          usartReceiverEnabled(scope, config),
          (enabled) => advanceReceiver(asBody(enabled), config, elapsedPs),
          (disabled) => {
            const off = asBody(disabled);

            // RCC/软件复位可能只清 CR1 而没有走 CR1 写入路径；这里兜底清掉
            // 陈旧的 RX 活动位，避免 CR1=0 时仍扫描 RXD。
            resetReceiver(off, config);
            off.writeState(
              TX_MASK,
              off.bitAnd(
                off.readState(TX_MASK, types.number),
                num(off, ~rxMaskBit(config) & 0xffffffff),
              ),
            );
            refreshUsartTick(off);
          },
        );
      });
  });
}

/**
 * TXE 的唯一定义：发送队列未满（`count < 4`），即 TDR 已空、可以再写一个字节。
 * ISR 的 bit7 与 `TXEIE` 的中断挂起条件都用它，避免同一标志位出现两套判定。
 */
function txEmpty(b: Body, config: UsartConfig): Value<boolean> {
  return b.lessThan(readTx(b, config, 'Count'), num(b, 4));
}

function transferComplete(b: Body, config: UsartConfig): Value<boolean> {
  const active = boolBitAt(b, readTx(b, config, 'Active'), 0);
  const count = readTx(b, config, 'Count');

  return boolAnd(b, b.not(active), b.equal(types.number, count, num(b, 0)));
}

function isrValue(b: Body, config: UsartConfig): Value<number> {
  const empty = b.select(
    types.number,
    txEmpty(b, config),
    (inner) => inner.constant(types.number, 1 << 7),
    (inner) => inner.constant(types.number, 0),
  );
  const complete = b.select(
    types.number,
    transferComplete(b, config),
    (inner) => inner.constant(types.number, 1 << 6),
    (inner) => inner.constant(types.number, 0),
  );
  const flags = b.bitAnd(b.shiftRightUnsigned(loadRx(b, config, 'Data'), num(b, 8)), num(b, 0x3e));
  const receiverEnabled = usartReceiverEnabled(b, config);
  const transmitterEnabled = usartEnabled(b, config);
  const teack = b.select(
    types.number,
    transmitterEnabled,
    (inner) => inner.constant(types.number, ISR_TEACK),
    (inner) => inner.constant(types.number, 0),
  );
  const reack = b.select(
    types.number,
    receiverEnabled,
    (inner) => inner.constant(types.number, ISR_REACK),
    (inner) => inner.constant(types.number, 0),
  );

  return b.bitOr(b.bitOr(empty, complete), b.bitOr(flags, b.bitOr(teack, reack)));
}

/** 当前 RX 标志字（按 ISR 位号放在 bit1–5）。 */
function rxFlags(b: Body, config: UsartConfig): Value<number> {
  return b.bitAnd(b.shiftRightUnsigned(loadRx(b, config, 'Data'), num(b, 8)), num(b, 0x3e));
}

function clearReceiveFlags(b: Body, config: UsartConfig, clearMask: Value<number>): void {
  const data = loadRx(b, config, 'Data');
  const updated = b.bitAnd(data, b.bitNot(clearMask));

  storeRx(b, config, 'Data', updated);
  // 标志可能已经消失，下一次中断扫描要重新求值。
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

function flushReceive(b: Body, config: UsartConfig): void {
  const data = loadRx(b, config, 'Data');
  const cleared = b.bitAnd(data, num(b, ~(USART_RX_DATA_RXNE | USART_RX_DATA_MASK) & 0xffffffff));

  storeRx(b, config, 'Data', cleared);
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function readUsart(
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  size: number,
): Value<number> {
  const result = b.local(types.number, 0);

  // 0x400 的 USART 窗口只实现 0x00–0x2F；其余保留地址读 0，不能按 0x3C 掩码别名。
  b.if(b.lessThan(u32(b, offset), num(b, 0x30)), (window) => {
    const w = asBody(window);
    const wordOffset = w.bitAnd(offset, num(w, 0x3c));

    w.if(
      w.equal(types.number, wordOffset, num(w, ISR)),
      (isr) => isr.setLocal(result, isrValue(asBody(isr), config)),
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, RDR)),
          (rdr) => {
            const scope = asBody(rdr);
            const data = loadRx(scope, config, 'Data');

            scope.setLocal(result, scope.bitAnd(data, num(scope, USART_RX_DATA_MASK)));
            // 只有 RDR 低字节 lane 的访问才算读 RDR；读 0x25–0x27 的保留字节
            // 不能清 RXNE。32 位访问也落在 lane 0。
            scope.if(
              boolAnd(
                scope,
                boolBitAt(scope, data, 13),
                scope.equal(types.number, scope.bitAnd(offset, num(scope, 3)), num(scope, 0)),
              ),
              (hit) => {
                const body2 = asBody(hit);

                storeRx(
                  body2,
                  config,
                  'Data',
                  body2.bitAnd(data, num(body2, ~USART_RX_DATA_RXNE & 0xffffffff)),
                );
                body2.writeState(IRQ_DIRTY, bool(body2, true));
                markService(body2, SERVICE_IRQ);
              },
            );
          },
          (rest) => {
            const body2 = asBody(rest);

            body2.if(
              boolOr(
                body2,
                body2.equal(types.number, wordOffset, num(body2, ICR)),
                body2.equal(types.number, wordOffset, num(body2, RQR)),
              ),
              (writeOnly) => writeOnly.setLocal(result, num(writeOnly, 0)),
              (stored) => stored.setLocal(result, loadAt(asBody(stored), config, wordOffset)),
            );
          },
        );
      },
    );
  });

  const value = b.getLocal(result);

  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
}

/** BRR 写入后按该路实际外设时钟重算一次位时长（皮秒）。 */
function storeBitPeriod(
  b: Body,
  config: UsartConfig,
  clockHz: Value<number> = usartClock(b, config),
): void {
  const brr = load(b, config, BRR);
  const cr1 = load(b, config, CR1);
  const over8 = boolBitAt(b, cr1, 15);
  const usartDivisor = b.select(
    types.number,
    over8,
    (inner) => {
      const body = asBody(inner);
      const mantissa = body.bitAnd(body.shiftRightUnsigned(brr, num(body, 4)), num(body, 0xffff));
      const fraction = body.bitAnd(brr, num(body, 7));

      return body.add(body.multiply(mantissa, num(body, 8)), fraction);
    },
    () => brr,
  );
  const divisor = config.kind === 'lpuart' ? b.multiply(brr, num(b, 256)) : usartDivisor;
  const hz = b.select(
    types.number,
    b.greaterThan(clockHz, num(b, 0)),
    () => clockHz,
    (inner) => inner.constant(types.number, 1),
  );
  const computing = b.floor(b.divide(b.multiply(num(b, PICOSECONDS_PER_SECOND), divisor), hz));
  const period = b.select(
    types.number,
    b.greaterThan(computing, num(b, 0)),
    (inner) =>
      inner.select(
        types.number,
        inner.greaterThan(computing, inner.constant(types.number, MAX_SAFE_TIME_PS)),
        (cap) => cap.constant(types.number, MAX_SAFE_TIME_PS),
        () => computing,
      ),
    (inner) => inner.constant(types.number, 1),
  );

  writeTx(b, config, 'Period', period);
}

const layoutMask = (size: number): number => (size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff);

/** 把一次窄写放到目标寄存器字中的位置。 */
function placedValue(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, layoutMask(size))), shift);
}

export function writeUsart(
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  // 0x400 窗口只实现 0x00–0x2F；保留地址写入忽略，不能按 0x3C 掩码别名到真实寄存器。
  b.if(b.lessThan(u32(b, offset), num(b, 0x30)), (window) => {
    const w = asBody(window);
    const wordOffset = w.bitAnd(offset, num(w, 0x3c));

    w.if(
      w.equal(types.number, wordOffset, num(w, TDR)),
      (tdr) => {
        enqueue(asBody(tdr), config, value);
      },
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, RDR)),
          () => {},
          (register) => {
            const scope = asBody(register);

            scope.if(
              scope.equal(types.number, wordOffset, num(scope, ICR)),
              (icr) => {
                const body2 = asBody(icr);
                const placed = placedValue(body2, value, offset, size);
                const clearMask = body2.shiftLeft(
                  body2.bitAnd(placed, num(body2, ICR_FECF | ICR_NCF | ICR_ORECF | ICR_IDLECF)),
                  num(body2, 8),
                );

                clearReceiveFlags(body2, config, clearMask);
              },
              (next) => {
                const body2 = asBody(next);

                body2.if(
                  body2.equal(types.number, wordOffset, num(body2, RQR)),
                  (rqr) => {
                    const body3 = asBody(rqr);
                    const placed = placedValue(body3, value, offset, size);

                    body3.if(
                      body3.notEqual(
                        types.number,
                        body3.bitAnd(placed, num(body3, RQR_RXFRQ)),
                        num(body3, 0),
                      ),
                      (flush) => flushReceive(asBody(flush), config),
                    );
                  },
                  (stored) => {
                    const body3 = asBody(stored);
                    const current = loadAt(body3, config, wordOffset);
                    const width = layoutMask(size);
                    const shift = body3.multiply(
                      body3.bitAnd(offset, num(body3, 3)),
                      num(body3, 8),
                    );
                    const placed = body3.shiftLeft(
                      body3.bitAnd(u32(body3, value), num(body3, width)),
                      shift,
                    );
                    const mask = body3.shiftLeft(num(body3, width), shift);
                    const merged = u32(
                      body3,
                      body3.bitOr(body3.bitAnd(current, body3.bitNot(mask)), placed),
                    );

                    storeAt(body3, config, wordOffset, merged);
                    body3.if(
                      boolOr(
                        body3,
                        body3.equal(types.number, wordOffset, num(body3, CR1)),
                        body3.equal(types.number, wordOffset, num(body3, CR3)),
                      ),
                      (sync) => {
                        const body4 = asBody(sync);

                        syncTxPins(body4, config);
                        body4.writeState(IRQ_DIRTY, bool(body4, true));
                        markService(body4, SERVICE_IRQ);
                        body4.if(
                          body4.equal(types.number, wordOffset, num(body4, CR1)),
                          (cr1Write) => {
                            const body5 = asBody(cr1Write);
                            const receiver = usartReceiverEnabled(body5, config);
                            // 先取旧活动位：updateRxMask 会改写 txMask。
                            const wasEnabled = boolBitAt(
                              body5,
                              body5.readState(TX_MASK, types.number),
                              8 + config.index - 1,
                            );

                            updateRxMask(body5, config, receiver);
                            // RE 关闭时取消半帧；开启时也清掉可能残留的旧相位。
                            body5.if(
                              body5.notEqual(types.bool, receiver, wasEnabled),
                              (transition) => resetReceiver(asBody(transition), config),
                            );
                            body5.if(
                              body5.notEqual(
                                types.bool,
                                boolBitAt(body5, current, 15),
                                boolBitAt(body5, merged, 15),
                              ),
                              (changed) => storeBitPeriod(asBody(changed), config),
                            );
                          },
                        );
                      },
                    );
                    body3.if(body3.equal(types.number, wordOffset, num(body3, BRR)), (brr) =>
                      storeBitPeriod(asBody(brr), config),
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

/**
 * 用实际外设时钟重算某一路的位时长。RCC/clock-tree 在时钟变化后按路调用；BRR、OVER8
 * 与 LPUART 公式仍由这里统一解释，避免时钟模块复制串口位时序知识。
 */
export function updateUsartBitPeriod(b: Body, config: UsartConfig, clockHz: Value<number>): void {
  storeBitPeriod(b, config, clockHz);
}

/**
 * DMA 请求门控：只有 CR3.DMAT/DMAR 使能且 TXE/RXNE 有效时才请求。
 * DMA 数据路径仍由总线真实读 RDR / 写 TDR 完成（读 RDR 清 RXNE、写 TDR 入发送队列），
 * `dma-sources.ts` 应使用本函数替代直接读 ISR 的 `usartReady`。
 */
export function usartDmaRequestReady(b: Body, config: UsartConfig, tx: boolean): Value<boolean> {
  const cr3 = load(b, config, CR3);
  const enabled = tx ? boolBitAt(b, cr3, 7) : boolBitAt(b, cr3, 6);
  const channel = tx ? usartEnabled(b, config) : usartReceiverEnabled(b, config);
  const ready = tx ? txEmpty(b, config) : boolBitAt(b, loadRx(b, config, 'Data'), 13);

  return boolAnd(b, enabled, boolAnd(b, channel, ready));
}

/** USART 的中断挂起条件（TXE/TC 与 RXNE/ORE/FE/NE/IDLE）。 */
export function usartPending(b: Body, config: UsartConfig): Value<boolean> {
  const cr1 = load(b, config, CR1);
  const cr3 = load(b, config, CR3);
  const flags = rxFlags(b, config);
  const rxneOrOverrun = b.notEqual(
    types.number,
    b.bitAnd(flags, num(b, ISR_RXNE | ISR_ORE)),
    num(b, 0),
  );
  const errors = b.notEqual(
    types.number,
    b.bitAnd(flags, num(b, ISR_FE | ISR_NE | ISR_ORE | ISR_IDLE)),
    num(b, 0),
  );
  const idle = b.notEqual(types.number, b.bitAnd(flags, num(b, ISR_IDLE)), num(b, 0));

  return boolOr(
    b,
    boolOr(
      b,
      boolAnd(b, boolBitAt(b, cr1, 7), txEmpty(b, config)),
      boolAnd(b, boolBitAt(b, cr1, 6), transferComplete(b, config)),
    ),
    boolOr(
      b,
      boolAnd(b, boolBitAt(b, cr1, 5), rxneOrOverrun),
      boolOr(b, boolAnd(b, boolBitAt(b, cr3, 0), errors), boolAnd(b, boolBitAt(b, cr1, 4), idle)),
    ),
  );
}

/** 注册 USART 的 TX 引脚复用驱动。 */
export function usartDrivers(): readonly AlternateDriver[] {
  const drivers: AlternateDriver[] = [];

  for (const config of USARTS) {
    for (const pin of config.txPins) {
      drivers.push({
        port: pin.port,
        pin: pin.pin,
        af: pin.af,
        active: (b) => usartEnabled(b, config),
        level: (b) => usartTxLevel(b, config),
      });
    }
  }

  return drivers;
}

export {
  CR1,
  CR2,
  CR3,
  BRR,
  ISR,
  ICR,
  RDR,
  TDR,
  RQR,
  GTPR,
  RTOR,
  PRESC,
  USART_TX_BITS,
  USART_RX_BITS,
  USART_STATE,
  USART_STATE_STRIDE,
  txState,
};
