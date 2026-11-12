import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  SFR,
  SFR_AUXR,
  SFR_IE,
  SFR_P_SW1,
  SFR_P_SW2,
  SFR_S2BUF,
  SFR_S2CON,
  SFR_SBUF,
  SFR_SCON,
  SFR_T2H,
  SFR_T2L,
  SFR_TH1,
  SFR_TL1,
  SFR_TMOD,
  asBody,
  boolean,
  number,
  periph8,
  periph16,
  readSfrBit,
  readSfrLatch,
  readSfr,
  setPeriph8,
  setPeriph16,
  sfrBitIsSet,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import { UART_BASE } from './layout';
import {
  DRIVE_RESISTANCE,
  GROUND_PIN,
  SUPPLY_PIN,
  registerAlternateDriver,
  syncPin,
} from './ports';
import type { Peripheral } from './types';

/**
 * 串行口 1 与串行口 2（STC15F2K60S2 只具备这两个 UART）。
 *
 * `advance` 会被复制进每一条指令的 IR，因此它只做「读一次忙标志 → 按位相位推进」；
 * 波特率位时间在控制寄存器写入时算好存进 `periph`，单位是系统时钟周期（16 位）。
 * 发送用「帧字右移」而不是逐位展开，接收用一个 3 段状态机。
 *
 * 位时间 `period`（系统时钟周期）：
 * - 模式 0：`12`，`AUXR.UART_M0x6=1` 时为 `2`（再折半作为半位时钟相位）；
 * - 模式 2：`SMOD=0 → 64`，`SMOD=1 → 32`；
 * - 模式 1/3 且 T2 作发生器：`4 * (T2x12 ? 1 : 12) * (65536 - [T2H,T2L])`；
 * - 模式 1/3 且 T1 模式 0/1（16 位）：`4 * (T1x12 ? 1 : 12) * (65536 - [TH1,TL1])`；
 * - 模式 1/3 且 T1 模式 2（8 位重装）：`(SMOD ? 16 : 32) * (T1x12 ? 1 : 12) * (256 - TH1)`；
 * - 串口 2（模式 0/1）：同 T2 公式。
 *
 * 简化：
 * - 模式 0 只输出 TXD 上的同步移位时钟并置 TI；RXD 上的串行数据输出、以及由 REN 启动的
 *   同步移位接收都不建模（模式 0 下接收通道恒关）；
 * - 自动地址识别（SADDR/SADEN）不建模，多机通信只实现 SM2/RB8 过滤；
 * - 中继广播（CLK_DIV.Tx_Rx）不建模；
 * - 串口 2 只实现 P1.0/P1.1，`P_SW2.S2_S=1` 时外设不驱动引脚、接收端恒为空闲（本器件没有 P4）。
 */

const SFR_PCON = 0x87;
/** IE2：ES2 = bit0；`kernel/ir.ts` 没有导出这个地址。 */
const SFR_IE2 = 0xaf;

const SCON_SM0 = 7;
const SCON_SM1 = 6;
const SCON_SM2 = 5;
const SCON_REN = 4;
const SCON_TB8 = 3;
const SCON_RB8 = 2;
const SCON_TI = 1;
const SCON_RI = 0;

const PCON_SMOD = 7;
const PCON_SMOD0 = 6;

const AUXR_T1X12 = 6;
const AUXR_UART_M0X6 = 5;
const AUXR_T2X12 = 2;
const AUXR_S1ST2 = 0;

const IE_ES = 4;
const IP_PS = 4;
const IE2_ES2 = 0;
const IP2_PS2 = 0;

const P_SW1_S1_S1 = 7;
const P_SW1_S1_S0 = 6;
const P_SW2_S2_S = 0;

/** 每个引擎在 `periph` 里的 16 字节窗口；位相位与位时间都以系统时钟周期计。 */
const FLAGS = 0x0;
const TX_COUNT = 0x1;
const TX_WORD = 0x2;
const RX_STAGE = 0x4;
const RX_INDEX = 0x5;
const RX_SHIFT = 0x6;
const RX_BUFFER = 0x7;
/** 模式 0 的半位标记（bit0）；异步接收时存本帧的数据位数。 */
const HALF = 0x8;
const TX_PHASE = 0xa;
const RX_PHASE = 0xc;
const BIT_PERIOD = 0xe;

const F_TX_ACTIVE = 0x01;
/** TXD 当前为低；模式 0 时它就是同步移位时钟的电平。 */
const F_LINE_LOW = 0x02;
const F_RX_LAST = 0x04;
const F_TX_NINTH = 0x08;
const F_RX_NINTH = 0x10;
/** 镜像 SCON/S2CON 的 REN（模式 0 下恒为 0），供 `advance` 一次比较判断是否需要接收。 */
const F_REN = 0x20;

const RX_IDLE = 0;
const RX_START = 1;
const RX_DATA = 2;
const RX_STOP = 3;

/** 位时间的上限：65535 个系统时钟周期（1 MHz 时约 65 ms/位）。 */
const MAX_PERIOD = 0xffff;

interface Engine {
  readonly id: 'uart1' | 'uart2';
  readonly base: number;
  readonly control: number;
  readonly buffer: number;
  /** SCON 有 SM1；S2CON 只有 S2SM0。 */
  readonly sm1Bit: number;
  readonly sm0Bit: number;
  readonly sm2Bit: number;
  readonly renBit: number;
  readonly tb8Bit: number;
  readonly rb8Bit: number;
  readonly tiBit: number;
  readonly riBit: number;
  /** 只有串口 1 有模式 0（同步移位寄存器）。 */
  readonly synchronous: boolean;
}

const UART1: Engine = {
  id: 'uart1',
  base: UART_BASE,
  control: SFR_SCON,
  buffer: SFR_SBUF,
  sm0Bit: SCON_SM0,
  sm1Bit: SCON_SM1,
  sm2Bit: SCON_SM2,
  renBit: SCON_REN,
  tb8Bit: SCON_TB8,
  rb8Bit: SCON_RB8,
  tiBit: SCON_TI,
  riBit: SCON_RI,
  synchronous: true,
};

const UART2: Engine = {
  id: 'uart2',
  base: UART_BASE + 0x10,
  control: SFR_S2CON,
  buffer: SFR_S2BUF,
  sm0Bit: 7,
  sm1Bit: -1,
  sm2Bit: 5,
  renBit: 4,
  tb8Bit: 3,
  rb8Bit: 2,
  tiBit: 1,
  riBit: 0,
  synchronous: false,
};

/** 串口 1 的 RXD/TXD 三组复用位置，下标与 S1_S1:S1_S0 一致（11 无效）。 */
const UART1_TXD_PINS = [
  { port: 3, bit: 1 },
  { port: 3, bit: 7 },
  { port: 1, bit: 7 },
] as const;

/* ------------------------------------------------------------------ */
/* 取值辅助                                                            */
/* ------------------------------------------------------------------ */

const flagIsSet = (b: Body, base: number, mask: number): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(periph8(b, base + FLAGS), number(b, mask)), number(b, 0));

const setFlag = (b: Body, base: number, mask: number, on: Value<boolean>): void => {
  const current = periph8(b, base + FLAGS);
  const set = b.bitOr(current, number(b, mask));
  const clear = b.bitAnd(current, number(b, 0xff & ~mask));

  b.if(
    on,
    (yes) => setPeriph8(asBody(yes), base + FLAGS, set),
    (no) => setPeriph8(asBody(no), base + FLAGS, clear),
  );
};

/** 只改 SFR 锁存器的某一位，不触发写钩子（外设内部置位 TI/RI/RB8/FE 用）。 */
const setControlBit = (b: Body, address: number, bit: number, on: Value<boolean>): void => {
  const mask = 1 << bit;
  const current = readSfrLatch(b, address);
  const set = b.bitOr(current, number(b, mask));
  const clear = b.bitAnd(current, number(b, 0xff & ~mask));
  const index = number(b, address & 0x7f);

  b.if(
    on,
    (yes) => asBody(yes).store8(SFR, index, set),
    (no) => asBody(no).store8(SFR, index, clear),
  );
};

/** 引脚电平：`high` 记 1，其余记 0。 */
const pinLevel = (b: Body, pin: string): Value<number> => {
  const level = b.field(b.readSample(pin), 'level');
  const high = b.equal(types.logic, level, b.constant(types.logic, types.logic.members.high));
  const one = number(b, 1);
  const zero = number(b, 0);

  return b.select(
    types.number,
    high,
    () => one,
    () => zero,
  );
};

const s1Position = (b: Body): Value<number> =>
  b.bitOr(
    b.shiftLeft(readSfrBit(b, SFR_P_SW1, P_SW1_S1_S1), number(b, 1)),
    readSfrBit(b, SFR_P_SW1, P_SW1_S1_S0),
  );

const s2OnP4 = (b: Body): Value<boolean> => sfrBitIsSet(b, SFR_P_SW2, P_SW2_S2_S);

/** 串口 1 的工作模式 0..3；SMOD0=1 时 SCON.7 是 FE，模式按 SM0=0 解释。 */
const modeOf = (b: Body, engine: Engine): Value<number> => {
  if (engine.sm1Bit < 0) return readSfrBit(b, engine.control, engine.sm0Bit);

  const sm1 = readSfrBit(b, engine.control, engine.sm1Bit);
  const frameError = sfrBitIsSet(b, SFR_PCON, PCON_SMOD0);
  const zero = number(b, 0);
  const sm0Bit = readSfrBit(b, engine.control, engine.sm0Bit);
  const sm0 = b.select(
    types.number,
    frameError,
    () => zero,
    () => sm0Bit,
  );

  return b.add(b.shiftLeft(sm0, number(b, 1)), sm1);
};

/** 一帧里的数据位数：模式 1 → 8（第 9 位是停止位），模式 2/3 → 9。 */
const frameDataBits = (b: Body, engine: Engine): Value<number> => {
  const nine =
    engine.sm1Bit < 0
      ? sfrBitIsSet(b, engine.control, engine.sm0Bit)
      : b.greaterThanOrEqual(modeOf(b, engine), number(b, 2));
  const eightValue = number(b, 8);
  const nineValue = number(b, 9);

  return b.select(
    types.number,
    nine,
    () => nineValue,
    () => eightValue,
  );
};

/** 非零除数：重装值为 0 表示满量程。 */
const nonZero = (b: Body, value: Value<number>, fallback: number): Value<number> => {
  const zero = number(b, 0);
  const replacement = number(b, fallback);

  return b.select(
    types.number,
    b.equal(types.number, value, zero),
    () => replacement,
    () => value,
  );
};

const clampPeriod = (b: Body, value: Value<number>): Value<number> => {
  const one = number(b, 1);
  const high = number(b, MAX_PERIOD);
  const atLeastOne = b.select(
    types.number,
    b.lessThan(value, one),
    () => one,
    () => value,
  );

  return b.select(
    types.number,
    b.greaterThan(atLeastOne, high),
    () => high,
    () => atLeastOne,
  );
};

/**
 * 串口是否已经被配置：只有 SCON/S2CON 的模式位或接收使能非零时，TXD 才由串口接管。
 *
 * 复位后 SCON=0，P3.1 就是普通端口引脚；固件写 SCON 选择模式（或打开接收）之后，
 * 串口才把 TXD 驱动到空闲高电平。这样 P3.1 既能当 TXD 用，也能在串口未被使用时
 * 当普通 GPIO 读回锁存值。
 */
const serialConfigured = (b: Body, engine: Engine): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(readSfr(b, engine.control), number(b, 0xd0)), number(b, 0));

/** TXD 复用输出的电平：TXD 为低时输出低。 */
const txdLevel = (b: Body, engine: Engine): Value<boolean> =>
  b.not(flagIsSet(b, engine.base, F_LINE_LOW));

for (const [position, pin] of UART1_TXD_PINS.entries()) {
  registerAlternateDriver({
    id: `uart1-txd-${position}`,
    port: pin.port,
    bit: pin.bit,
    enabled: (b) =>
      b.and(b.equal(types.number, s1Position(b), number(b, position)), (inner) =>
        serialConfigured(asBody(inner), UART1),
      ),
    level: (b) => txdLevel(b, UART1),
  });
}

registerAlternateDriver({
  id: 'uart2-txd',
  port: 1,
  bit: 1,
  enabled: (b) => b.and(b.not(s2OnP4(b)), (inner) => serialConfigured(asBody(inner), UART2)),
  level: (b) => txdLevel(b, UART2),
});

/* ------------------------------------------------------------------ */
/* 外设                                                                */
/* ------------------------------------------------------------------ */

export function createUart(): Peripheral {
  /** 位时间（系统时钟周期）；模式 0 再折半，`advance` 因此只有一种阈值。 */
  const computePeriod = (b: Body, engine: Engine): Value<number> => {
    const one = number(b, 1);
    const four = number(b, 4);
    const twelve = number(b, 12);
    const sixteen = number(b, 16);
    const thirtyTwo = number(b, 32);

    const t2x12 = sfrBitIsSet(b, SFR_AUXR, AUXR_T2X12);
    const t2Prescale = b.select(
      types.number,
      t2x12,
      () => one,
      () => twelve,
    );
    // TH1/TL1/T2H/T2L 有定时器的读钩子（返回实时计数），波特率要用重装锁存值。
    const t2High = readSfrLatch(b, SFR_T2H);
    const t2Low = readSfrLatch(b, SFR_T2L);
    const t2Divisor = nonZero(
      b,
      b.subtract(number(b, 0x1_0000), b.add(b.shiftLeft(t2High, number(b, 8)), t2Low)),
      0x1_0000,
    );
    const t2Period = b.multiply(t2Divisor, b.multiply(t2Prescale, four));

    if (engine.id === 'uart2') return clampPeriod(b, t2Period);

    const mode = modeOf(b, UART1);
    const smod = sfrBitIsSet(b, SFR_PCON, PCON_SMOD);
    const t1x12 = sfrBitIsSet(b, SFR_AUXR, AUXR_T1X12);
    const useT2 = sfrBitIsSet(b, SFR_AUXR, AUXR_S1ST2);
    const m0x6 = sfrBitIsSet(b, SFR_AUXR, AUXR_UART_M0X6);

    const t1Prescale = b.select(
      types.number,
      t1x12,
      () => one,
      () => twelve,
    );
    const t1Mode = b.bitOr(
      b.shiftLeft(readSfrBit(b, SFR_TMOD, 5), number(b, 1)),
      readSfrBit(b, SFR_TMOD, 4),
    );
    const t1EightBit = b.equal(types.number, t1Mode, number(b, 2));
    const t1Halted = b.equal(types.number, t1Mode, number(b, 3));

    const th1 = readSfrLatch(b, SFR_TH1);
    const tl1 = readSfrLatch(b, SFR_TL1);
    const t1SixteenBitValue = nonZero(
      b,
      b.subtract(number(b, 0x1_0000), b.add(b.shiftLeft(th1, number(b, 8)), tl1)),
      0x1_0000,
    );
    const t1EightBitValue = nonZero(b, b.subtract(number(b, 0x100), th1), 0x100);

    const t1Divisor = b.select(
      types.number,
      t1EightBit,
      () => t1EightBitValue,
      () => t1SixteenBitValue,
    );
    const t1EightBitScale = b.select(
      types.number,
      smod,
      () => sixteen,
      () => thirtyTwo,
    );
    const t1Scale = b.select(
      types.number,
      t1EightBit,
      () => t1EightBitScale,
      () => four,
    );
    const t1Period = b.multiply(t1Divisor, b.multiply(t1Prescale, t1Scale));
    const maxPeriod = number(b, MAX_PERIOD);
    const t1Effective = b.select(
      types.number,
      t1Halted,
      () => maxPeriod,
      () => t1Period,
    );

    const timerPeriod = b.select(
      types.number,
      useT2,
      () => t2Period,
      () => t1Effective,
    );
    const mode0Fast = number(b, 1);
    const mode0Slow = number(b, 6);
    const mode2Fast = number(b, 32);
    const mode2Slow = number(b, 64);
    const mode0Period = b.select(
      types.number,
      m0x6,
      () => mode0Fast,
      () => mode0Slow,
    );
    const mode2Period = b.select(
      types.number,
      smod,
      () => mode2Fast,
      () => mode2Slow,
    );
    const isModeZero = b.equal(types.number, mode, number(b, 0));
    const isModeTwo = b.equal(types.number, mode, number(b, 2));

    return clampPeriod(
      b,
      b.select(
        types.number,
        isModeZero,
        () => mode0Period,
        (inner) =>
          asBody(inner).select(
            types.number,
            isModeTwo,
            () => mode2Period,
            () => timerPeriod,
          ),
      ),
    );
  };

  const storePeriod = (b: Body, engine: Engine): void => {
    setPeriph16(b, engine.base + BIT_PERIOD, computePeriod(b, engine));
  };

  const syncUart1Pins = (b: Body): void => {
    for (const pin of UART1_TXD_PINS) syncPin(b, pin.port, pin.bit);
  };

  /** 采样 RXD：串口 1 按 S1_S1:S1_S0 选脚，串口 2 固定 P1.0。 */
  const sampleRxd = (b: Body, engine: Engine): Value<number> => {
    if (engine.id === 'uart2') {
      const level = pinLevel(b, 'P1_0');
      const idle = number(b, 1);

      return b.select(
        types.number,
        s2OnP4(b),
        () => idle,
        () => level,
      );
    }

    const position = s1Position(b);
    const p30 = pinLevel(b, 'P3_0');
    const p36 = pinLevel(b, 'P3_6');
    const p16 = pinLevel(b, 'P1_6');
    const first = b.equal(types.number, position, number(b, 0));
    const second = b.equal(types.number, position, number(b, 1));

    return b.select(
      types.number,
      first,
      () => p30,
      (inner) =>
        asBody(inner).select(
          types.number,
          second,
          () => p36,
          () => p16,
        ),
    );
  };

  /** 把 TXD 的当前电平写进复用输出。 */
  const writeTxdPin = (b: Body, engine: Engine): void => {
    const high = b.resistor(SUPPLY_PIN, number(b, DRIVE_RESISTANCE));
    const low = b.resistor(GROUND_PIN, number(b, DRIVE_RESISTANCE));
    const intent = b.select(
      types.intent,
      txdLevel(b, engine),
      () => high,
      () => low,
    );

    if (engine.id === 'uart2') {
      b.writeIntent('P1_1', intent);

      return;
    }

    const position = s1Position(b);
    const first = b.equal(types.number, position, number(b, 0));
    const second = b.equal(types.number, position, number(b, 1));

    b.if(
      first,
      (firstBody) => asBody(firstBody).writeIntent('P3_1', intent),
      (rest) =>
        asBody(rest).if(
          second,
          (secondBody) => asBody(secondBody).writeIntent('P3_7', intent),
          (third) => asBody(third).writeIntent('P1_7', intent),
        ),
    );
  };

  const setLineLow = (b: Body, engine: Engine, low: Value<boolean>): void => {
    setFlag(b, engine.base, F_LINE_LOW, low);
  };

  /** 写 SBUF/S2BUF：装载帧字并启动一帧。 */
  const startTransmit = (b: Body, engine: Engine, value: Value<number>): void => {
    const one = number(b, 1);
    const zero = number(b, 0);
    const nineBit = b.greaterThanOrEqual(modeOf(b, engine), number(b, 2));
    const tb8 = readSfrBit(b, engine.control, engine.tb8Bit);
    const ninth = b.select(
      types.number,
      nineBit,
      () => tb8,
      () => zero,
    );
    const eightCount = number(b, 8);
    const nineCount = number(b, 9);
    const count = b.select(
      types.number,
      nineBit,
      () => nineCount,
      () => eightCount,
    );

    setPeriph8(b, engine.base + TX_WORD, value);
    setPeriph8(b, engine.base + TX_WORD + 1, ninth);
    setPeriph8(b, engine.base + TX_COUNT, count);
    setPeriph8(b, engine.base + HALF, zero);
    setPeriph16(b, engine.base + TX_PHASE, zero);
    // 一次写完发送相关的标志位，避免逐位 read-modify-write。
    const kept = b.bitAnd(
      periph8(b, engine.base + FLAGS),
      number(b, 0xff & ~(F_TX_ACTIVE | F_LINE_LOW | F_TX_NINTH)),
    );
    const ninthFlag = number(b, F_TX_NINTH);
    const ninthBit = b.select(
      types.number,
      b.equal(types.number, ninth, one),
      () => ninthFlag,
      () => zero,
    );

    setPeriph8(
      b,
      engine.base + FLAGS,
      b.bitOr(kept, b.bitOr(number(b, F_TX_ACTIVE | F_LINE_LOW), ninthBit)),
    );
    storePeriod(b, engine);
    writeTxdPin(b, engine);
  };

  /** 异步帧的一步：帧字右移一位；计数到 0 时输出停止位并置 TI。 */
  const stepAsync = (b: Body, engine: Engine): void => {
    const count = periph8(b, engine.base + TX_COUNT);

    b.if(
      b.equal(types.number, count, number(b, 0)),
      (stop) => {
        const body = asBody(stop);

        // 停止位开始发送时置 TI。
        setLineLow(body, engine, boolean(body, false));
        setFlag(body, engine.base, F_TX_ACTIVE, boolean(body, false));
        setControlBit(body, engine.control, engine.tiBit, boolean(body, true));
        markIrqDirty(body);
      },
      (next) => {
        const body = asBody(next);
        const word = periph16(body, engine.base + TX_WORD);

        setLineLow(
          body,
          engine,
          body.equal(types.number, body.bitAnd(word, number(body, 1)), number(body, 0)),
        );
        setPeriph16(body, engine.base + TX_WORD, body.shiftRightUnsigned(word, number(body, 1)));
        setPeriph8(body, engine.base + TX_COUNT, body.subtract(count, number(body, 1)));
      },
    );
  };

  /** 模式 0 的同步移位：半位翻转一次时钟，8 个位后置 TI。 */
  const stepShift = (b: Body, engine: Engine): void => {
    const half = b.notEqual(
      types.number,
      b.bitAnd(periph8(b, engine.base + HALF), number(b, 1)),
      number(b, 0),
    );

    b.if(
      half,
      (second) => {
        const body = asBody(second);
        const count = periph8(body, engine.base + TX_COUNT);

        setPeriph8(body, engine.base + HALF, number(body, 0));
        setLineLow(body, engine, boolean(body, true));
        body.if(
          body.equal(types.number, count, number(body, 1)),
          (done) => {
            const branch = asBody(done);

            setPeriph8(
              branch,
              engine.base + FLAGS,
              branch.bitAnd(
                periph8(branch, engine.base + FLAGS),
                number(branch, 0xff & ~(F_TX_ACTIVE | F_LINE_LOW)),
              ),
            );
            setControlBit(branch, engine.control, engine.tiBit, boolean(branch, true));
            markIrqDirty(branch);
          },
          (more) => {
            const branch = asBody(more);

            setPeriph8(branch, engine.base + TX_COUNT, branch.subtract(count, number(branch, 1)));
          },
        );
      },
      (first) => {
        const body = asBody(first);

        setPeriph8(body, engine.base + HALF, number(body, 1));
        setLineLow(body, engine, boolean(body, false));
      },
    );
  };

  const stepTransmit = (b: Body, engine: Engine): void => {
    if (!engine.synchronous) {
      stepAsync(b, engine);

      return;
    }

    b.if(
      b.equal(types.number, modeOf(b, engine), number(b, 0)),
      (shift) => stepShift(asBody(shift), engine),
      (async) => stepAsync(asBody(async), engine),
    );
  };

  /** 起始位：位中点确认低电平，否则视为干扰重新等待下降沿。 */
  const receiveStartBit = (b: Body, engine: Engine, level: Value<number>): void => {
    b.if(
      b.equal(types.number, level, number(b, 1)),
      (high) => setPeriph8(asBody(high), engine.base + RX_STAGE, number(high, RX_IDLE)),
      (low) => {
        const body = asBody(low);

        setPeriph8(body, engine.base + RX_STAGE, number(body, RX_DATA));
        setPeriph8(body, engine.base + RX_INDEX, number(body, 0));
        setPeriph8(body, engine.base + RX_SHIFT, number(body, 0));
      },
    );
  };

  const receiveDataBit = (b: Body, engine: Engine, level: Value<number>): void => {
    const index = periph8(b, engine.base + RX_INDEX);
    const shift = periph8(b, engine.base + RX_SHIFT);
    const next = b.add(index, number(b, 1));
    const total = periph8(b, engine.base + HALF);

    b.if(
      b.lessThan(index, number(b, 8)),
      (data) => {
        const body = asBody(data);

        setPeriph8(body, engine.base + RX_SHIFT, body.bitOr(shift, body.shiftLeft(level, index)));
      },
      (ninth) => {
        const body = asBody(ninth);

        setFlag(body, engine.base, F_RX_NINTH, body.equal(types.number, level, number(body, 1)));
      },
    );
    setPeriph8(b, engine.base + RX_INDEX, next);
    b.if(b.equal(types.number, next, total), (done) => {
      setPeriph8(asBody(done), engine.base + RX_STAGE, number(done, RX_STOP));
    });
  };

  /** 停止位中点：满足 RI=0 与 SM2/RB8 过滤时装载 SBUF 并置 RI。 */
  const receiveStopBit = (b: Body, engine: Engine, level: Value<number>): void => {
    const total = periph8(b, engine.base + HALF);
    const one = number(b, 1);
    const zero = number(b, 0);
    const ninth = b.select(
      types.number,
      flagIsSet(b, engine.base, F_RX_NINTH),
      () => one,
      () => zero,
    );
    const rb8 = b.select(
      types.number,
      b.equal(types.number, total, number(b, 9)),
      () => ninth,
      () => level,
    );
    const rb8High = b.equal(types.number, rb8, one);
    const sm2 = sfrBitIsSet(b, engine.control, engine.sm2Bit);
    const alwaysAccept = boolean(b, true);
    const filterOk = b.select(
      types.bool,
      sm2,
      () => rb8High,
      () => alwaysAccept,
    );
    const riClear = b.equal(types.number, readSfrBit(b, engine.control, engine.riBit), zero);
    const accept = b.and(riClear, () => filterOk);

    b.if(accept, (inner) => {
      const body = asBody(inner);

      setPeriph8(body, engine.base + RX_BUFFER, periph8(body, engine.base + RX_SHIFT));
      setControlBit(body, engine.control, engine.rb8Bit, rb8High);
      setControlBit(body, engine.control, engine.riBit, boolean(body, true));
      markIrqDirty(body);
    });

    if (engine.synchronous) {
      const smod0 = sfrBitIsSet(b, SFR_PCON, PCON_SMOD0);
      const frameError = b.and(b.equal(types.number, level, zero), () => smod0);

      b.if(frameError, (inner) => {
        const body = asBody(inner);

        setControlBit(body, engine.control, SCON_SM0, boolean(body, true));
      });
    }

    setPeriph8(b, engine.base + RX_STAGE, zero);
  };

  const stepReceive = (b: Body, engine: Engine, level: Value<number>): void => {
    const stage = periph8(b, engine.base + RX_STAGE);
    const isStart = b.equal(types.number, stage, number(b, RX_START));
    const isData = b.equal(types.number, stage, number(b, RX_DATA));
    const isStop = b.equal(types.number, stage, number(b, RX_STOP));

    b.if(
      isStart,
      (start) => receiveStartBit(asBody(start), engine, level),
      (rest) =>
        asBody(rest).if(
          isData,
          (data) => receiveDataBit(asBody(data), engine, level),
          (last) => asBody(last).if(isStop, (stop) => receiveStopBit(asBody(stop), engine, level)),
        ),
    );
  };

  /** 空闲时找起始位的下降沿。 */
  const receiveIdle = (b: Body, engine: Engine, level: Value<number>): void => {
    const falling = b.equal(types.number, level, number(b, 0));
    const lastHigh = flagIsSet(b, engine.base, F_RX_LAST);
    const edge = b.and(lastHigh, () => falling);

    b.if(edge, (inner) => {
      const body = asBody(inner);

      setPeriph8(body, engine.base + RX_STAGE, number(body, RX_START));
      setPeriph8(body, engine.base + RX_INDEX, number(body, 0));
      setPeriph8(body, engine.base + RX_SHIFT, number(body, 0));
      // 本帧的数据位数（8 或 9）存进 HALF，后面两步直接读。
      setPeriph8(body, engine.base + HALF, frameDataBits(body, engine));
      setPeriph16(
        body,
        engine.base + RX_PHASE,
        body.divide(periph16(body, engine.base + BIT_PERIOD), number(body, 2)),
      );
    });
    setFlag(b, engine.base, F_RX_LAST, b.equal(types.number, level, number(b, 1)));
  };

  /** 一个引擎的推进：发送相位与接收相位各一次比较。 */
  const advanceEngine = (b: Body, engine: Engine, elapsed: Value<number>): void => {
    const base = engine.base;

    b.if(flagIsSet(b, base, F_TX_ACTIVE), (tx) => {
      const body = asBody(tx);
      const period = periph16(body, base + BIT_PERIOD);
      const phase = periph16(body, base + TX_PHASE);
      const next = body.add(phase, elapsed);

      body.if(
        body.greaterThanOrEqual(next, period),
        (hit) => {
          const branch = asBody(hit);

          setPeriph16(branch, base + TX_PHASE, branch.subtract(next, period));
          stepTransmit(branch, engine);
          writeTxdPin(branch, engine);
        },
        (miss) => setPeriph16(asBody(miss), base + TX_PHASE, next),
      );
    });

    b.if(flagIsSet(b, base, F_REN), (rx) => {
      const body = asBody(rx);
      const level = sampleRxd(body, engine);
      const stage = periph8(body, base + RX_STAGE);

      body.if(
        body.equal(types.number, stage, number(body, 0)),
        (idle) => receiveIdle(asBody(idle), engine, level),
        (busy) => {
          const branch = asBody(busy);
          const period = periph16(branch, base + BIT_PERIOD);
          const phase = periph16(branch, base + RX_PHASE);
          const next = branch.add(phase, elapsed);

          branch.if(
            branch.greaterThanOrEqual(next, period),
            (hit) => {
              const taken = asBody(hit);

              setPeriph16(taken, base + RX_PHASE, taken.subtract(next, period));
              stepReceive(taken, engine, level);
            },
            (miss) => setPeriph16(asBody(miss), base + RX_PHASE, next),
          );
        },
      );
    });
  };

  const engineFor = (address: number): Engine | undefined =>
    address === SFR_SBUF ? UART1 : address === SFR_S2BUF ? UART2 : undefined;

  /** REN 只在非模式 0 的串口 1 与串口 2 上打开接收通道。 */
  const refreshRen = (b: Body, engine: Engine): void => {
    const ren = sfrBitIsSet(b, engine.control, engine.renBit);

    if (!engine.synchronous) {
      setFlag(b, engine.base, F_REN, ren);

      return;
    }

    const asynchronous = b.not(b.equal(types.number, modeOf(b, engine), number(b, 0)));

    setFlag(
      b,
      engine.base,
      F_REN,
      b.and(ren, () => asynchronous),
    );
  };

  return {
    id: 'uart',
    writes: [
      SFR_SCON,
      SFR_SBUF,
      SFR_S2CON,
      SFR_S2BUF,
      SFR_P_SW1,
      SFR_P_SW2,
      SFR_IE2,
      SFR_PCON,
      SFR_AUXR,
      SFR_TMOD,
      SFR_TH1,
      SFR_TL1,
      SFR_T2H,
      SFR_T2L,
    ],
    reads: [SFR_SBUF, SFR_S2BUF],
    onWrite(b, address, value) {
      const engine = engineFor(address);

      if (engine !== undefined) {
        startTransmit(b, engine, value);

        return;
      }

      if (address === SFR_SCON) {
        refreshRen(b, UART1);
        storePeriod(b, UART1);
        syncUart1Pins(b);

        return;
      }

      if (address === SFR_S2CON) {
        refreshRen(b, UART2);
        storePeriod(b, UART2);
        syncPin(b, 1, 1);

        return;
      }

      if (address === SFR_P_SW1) {
        syncUart1Pins(b);

        return;
      }

      if (address === SFR_P_SW2) {
        syncPin(b, 1, 1);

        return;
      }

      if (address === SFR_IE2) {
        // IE2 不在内核的允许位监视列表里，ES2 变化后要自己触发重扫。
        markIrqDirty(b);

        return;
      }

      // PCON/AUXR/TMOD/TH1/TL1/T2H/T2L：波特率源变化，两个引擎都重算。
      storePeriod(b, UART1);
      storePeriod(b, UART2);
    },
    onRead(b, address) {
      const engine = engineFor(address) ?? UART1;

      return periph8(b, engine.base + RX_BUFFER);
    },
    advance(b, advance) {
      const elapsed = advance.cycles;
      const flags = b.bitOr(periph8(b, UART1.base + FLAGS), periph8(b, UART2.base + FLAGS));
      const stages = b.bitOr(periph8(b, UART1.base + RX_STAGE), periph8(b, UART2.base + RX_STAGE));
      const driving = b.notEqual(
        types.number,
        b.bitAnd(flags, number(b, F_TX_ACTIVE | F_REN)),
        number(b, 0),
      );
      const receiving = b.notEqual(types.number, stages, number(b, 0));
      const busy = b.or(driving, () => receiving);

      b.if(busy, (inner) => {
        const body = asBody(inner);

        advanceEngine(body, UART1, elapsed);
        advanceEngine(body, UART2, elapsed);
      });
    },
    /** 发送引擎在跑、接收使能（要采起始位）或有半个字节在移位里。 */
    active(b) {
      const flags = b.bitOr(periph8(b, UART1.base + FLAGS), periph8(b, UART2.base + FLAGS));
      const stages = b.bitOr(periph8(b, UART1.base + RX_STAGE), periph8(b, UART2.base + RX_STAGE));

      return b.or(
        b.notEqual(types.number, b.bitAnd(flags, number(b, F_TX_ACTIVE | F_REN)), number(b, 0)),
        (inner) => {
          const s = asBody(inner);

          return s.notEqual(types.number, stages, number(s, 0));
        },
      );
    },
    interrupts: [
      {
        id: 'uart1',
        vector: IRQ_VECTORS.uart1,
        query: 4,
        priority: { register: 'IP', bit: IP_PS },
        enabled: (b) => sfrBitIsSet(b, SFR_IE, IE_ES),
        pending: (b) => {
          const ri = sfrBitIsSet(b, SFR_SCON, SCON_RI);
          const ti = sfrBitIsSet(b, SFR_SCON, SCON_TI);

          return b.or(ri, () => ti);
        },
      },
      {
        id: 'uart2',
        vector: IRQ_VECTORS.uart2,
        query: 8,
        priority: { register: 'IP2', bit: IP2_PS2 },
        enabled: (b) => sfrBitIsSet(b, SFR_IE2, IE2_ES2),
        pending: (b) => {
          const ri = sfrBitIsSet(b, SFR_S2CON, UART2.riBit);
          const ti = sfrBitIsSet(b, SFR_S2CON, UART2.tiBit);

          return b.or(ri, () => ti);
        },
      },
    ],
  };
}
