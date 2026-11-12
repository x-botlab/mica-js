import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import {
  PERIPH,
  SFR,
  SFR_AUXR,
  SFR_IE,
  SFR_INT_CLKO,
  SFR_TCON,
  SFR_TH0,
  SFR_TH1,
  SFR_TL0,
  SFR_TL1,
  SFR_TMOD,
  SFR_T2H,
  SFR_T2L,
  asBody,
  byte,
  cyclePicoseconds,
  latchBitIsSet,
  number,
  periph8,
  periph16,
  readSfr,
  readSfrLatch,
  setPeriph8,
  setPeriph16,
  setSfrBit,
  sfrBitIsSet,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import type { InterruptSource } from '../kernel/interrupt';
import { TIMER_BASE } from './layout';
import {
  DRIVE_RESISTANCE,
  GROUND_PIN,
  SUPPLY_PIN,
  registerAlternateDriver,
  syncPin,
} from './ports';
import type { Clock, Peripheral } from './types';

/**
 * 定时器/计数器 T0、T1、T2。
 *
 * 三个定时器都是加法计数器：定时方式对系统时钟（AUXR 的 T0x12/T1x12/T2x12 选 ÷12 或 ÷1）
 * 计数，计数方式对 P3.4/T0、P3.5/T1、P3.1/T2 的下降沿计数。
 *
 * - T0 有 4 种模式：模式 0（16 位自动重装）、模式 1（16 位不重装）、模式 2（8 位自动重装）、
 *   模式 3（不可屏蔽中断的 16 位自动重装，计数行为与模式 0 相同）。
 * - T1 的模式 0/1/2 与 T0 相同，模式 3 停止计数。
 * - T2 固定为 16 位自动重装，另有 T2R/T2_C/T/T2x12 与 T2CLKO。
 *
 * 重装影子沿用硬件的「隐藏寄存器」语义：RL_THx/RL_TLx 与 THx/TLx 共用地址，因此这里让
 * SFR 锁存器保存软件最后写入的值（即重装值），当前计数值放在 `periph` 里并由读钩子返回；
 * 自动重装时把锁存器内容装回计数值。T2 的隐藏溢出标志同样放在 `periph`，对外只通过
 * `interrupts.timer2` 暴露（手册：T2 的请求标志对用户不可见）。
 *
 * `advance` 会展开到每条指令的 IR 里，因此这里刻意压低生成体积：控制位只读一次、常量
 * 复用同一个 `Value`、运行条件与计数推进全部用数值运算（不生成 select 分支），时钟输出
 * 只在电平变化时写一次引脚意图（不调用 `syncPin`）。
 */

/** IE2：定时器 2 的中断允许位 ET2（IE2.2）。内核没有为它定义常量。 */
const SFR_IE2 = 0xaf;

/** `periph` 布局：16 位计数值、32 位皮秒余量、引脚采样、时钟输出电平、T2 请求标志。 */
const T0_COUNT = TIMER_BASE + 0x00;
const T1_COUNT = TIMER_BASE + 0x02;
const T2_COUNT = TIMER_BASE + 0x04;
const T0_PHASE = TIMER_BASE + 0x06;
const T1_PHASE = TIMER_BASE + 0x0a;
const T2_PHASE = TIMER_BASE + 0x0e;
const T0_PIN = TIMER_BASE + 0x12;
const T1_PIN = TIMER_BASE + 0x13;
const T2_PIN = TIMER_BASE + 0x14;
const T0_CLOCK = TIMER_BASE + 0x15;
const T1_CLOCK = TIMER_BASE + 0x16;
const T2_CLOCK = TIMER_BASE + 0x17;
const T2_REQUEST = TIMER_BASE + 0x18;
/** 本次推进里发生过溢出的定时器（bit0 T0、bit1 T1、bit2 T2），用于刷新时钟输出脚。 */
const OVERFLOWED = TIMER_BASE + 0x19;

/** 三个定时器的时钟输出脚。 */
const CLOCK_PINS = ['P3_5', 'P3_4', 'P3_0'] as const;

const FULL_16 = 0x10000;
const FULL_8 = 0x100;

interface TimerSpec {
  readonly countOffset: number;
  readonly phaseOffset: number;
  readonly pinOffset: number;
  readonly clockOffset: number;
  readonly countPin: string;
  readonly gatePin: string;
  readonly clockPin: number;
  readonly clockBit: number;
  readonly flagBit: number;
  readonly runBit: number;
  readonly shift: number;
  readonly speedBit: number;
  readonly haltOnMode3: boolean;
  readonly low: number;
  readonly high: number;
}

const TIMER0: TimerSpec = {
  countOffset: T0_COUNT,
  phaseOffset: T0_PHASE,
  pinOffset: T0_PIN,
  clockOffset: T0_CLOCK,
  countPin: 'P3_4',
  gatePin: 'P3_2',
  clockPin: 5,
  clockBit: 0,
  flagBit: 5,
  runBit: 4,
  shift: 0,
  speedBit: 7,
  haltOnMode3: false,
  low: SFR_TL0,
  high: SFR_TH0,
};

const TIMER1: TimerSpec = {
  countOffset: T1_COUNT,
  phaseOffset: T1_PHASE,
  pinOffset: T1_PIN,
  clockOffset: T1_CLOCK,
  countPin: 'P3_5',
  gatePin: 'P3_3',
  clockPin: 4,
  clockBit: 1,
  flagBit: 7,
  runBit: 6,
  shift: 4,
  speedBit: 6,
  haltOnMode3: true,
  low: SFR_TL1,
  high: SFR_TH1,
};

const TIMER2: TimerSpec = {
  countOffset: T2_COUNT,
  phaseOffset: T2_PHASE,
  pinOffset: T2_PIN,
  clockOffset: T2_CLOCK,
  countPin: 'P3_1',
  gatePin: 'P3_1',
  clockPin: 0,
  clockBit: 2,
  flagBit: -1,
  runBit: 4,
  shift: 0,
  speedBit: 2,
  haltOnMode3: false,
  low: SFR_T2L,
  high: SFR_T2H,
};

/** 一次 `advance` 内复用的常量与读数：同一个数只生成一个 `Value`。 */
interface Context {
  readonly tmod: Value<number>;
  readonly tcon: Value<number>;
  readonly auxr: Value<number>;
  readonly clko: Value<number>;
  readonly elapsedPs: Value<number>;
  readonly cyclePs: number;
  readonly high: Value<IntentValue>;
  readonly low: Value<IntentValue>;
  readonly num: (value: number) => Value<number>;
}

const contextOf = (b: Body, elapsedPs: Value<number>, cyclePs: number): Context => {
  const numbers = new Map<number, Value<number>>();

  // 常量必须在最外层一次建好：嵌套区域里只能读外层 Value，不能再往外层 body 生成。
  for (const value of [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    12,
    cyclePs,
    11 * cyclePs,
    FULL_16,
    FULL_16 - FULL_8,
    DRIVE_RESISTANCE,
  ])
    numbers.set(value, number(b, value));

  return {
    tmod: readSfr(b, SFR_TMOD),
    tcon: readSfr(b, SFR_TCON),
    auxr: readSfr(b, SFR_AUXR),
    clko: readSfr(b, SFR_INT_CLKO),
    elapsedPs,
    cyclePs,
    high: b.resistor(SUPPLY_PIN, numbers.get(DRIVE_RESISTANCE) as Value<number>),
    low: b.resistor(GROUND_PIN, numbers.get(DRIVE_RESISTANCE) as Value<number>),
    num(value) {
      const existing = numbers.get(value);

      if (existing === undefined) throw new Error(`timer: 常量 ${value} 未预置`);

      return existing;
    },
  };
};

/** 一个字节里的某一位（0/1）。 */
const bitValue = (b: Body, value: Value<number>, bit: number, ctx: Context): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(value, ctx.num(bit)), ctx.num(1));

const pinIsHigh = (b: Body, pin: string): Value<boolean> =>
  b.equal(
    types.logic,
    b.field(b.readSample(pin), 'level'),
    b.constant(types.logic, types.logic.members.high),
  );

/** 布尔转 0/1；用于把运行条件合成一个数值。 */
const asNumber = (b: Body, value: Value<boolean>, ctx: Context): Value<number> =>
  b.select(
    types.number,
    value,
    () => ctx.num(1),
    () => ctx.num(0),
  );

/** 直接写 SFR 锁存器：定时器的硬件更新不能回灌自己的写钩子。 */
const writeLatch = (b: Body, address: number, value: Value<number>): void => {
  b.store8(SFR, number(b, address & 0x7f), byte(b, value));
};

const readLatch16 = (b: Body, high: number, low: number): Value<number> =>
  b.bitOr(b.shiftLeft(readSfrLatch(b, high), number(b, 8)), readSfrLatch(b, low));

const countByte = (b: Body, offset: number, high: boolean): Value<number> =>
  high
    ? b.bitAnd(b.shiftRightUnsigned(periph16(b, offset), number(b, 8)), number(b, 0xff))
    : b.bitAnd(periph16(b, offset), number(b, 0xff));

const timerMode = (b: Body, tmod: Value<number>, timer: TimerSpec): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(tmod, number(b, timer.shift)), number(b, 3));

/** THx 的读值：模式 2 下 TH 是重装值（锁存器），其余模式是计数器的高字节。 */
const standardHighByte = (b: Body, timer: TimerSpec): Value<number> =>
  b.select(
    types.number,
    b.equal(types.number, timerMode(b, readSfr(b, SFR_TMOD), timer), number(b, 2)),
    (inner) => readSfrLatch(asBody(inner), timer.high),
    (inner) => countByte(asBody(inner), timer.countOffset, true),
  );

const timer2Running = (b: Body): Value<boolean> => sfrBitIsSet(b, SFR_AUXR, 4);

/** 运行条件：TRx 置位、未被模式 3 停掉、GATE 放行；结果用 0/1 表示。 */
const runCondition = (b: Body, timer: TimerSpec, ctx: Context): Value<number> => {
  const gate = bitValue(b, ctx.tmod, timer.shift + 3, ctx);
  const gateOk = b.add(
    b.subtract(ctx.num(1), gate),
    b.multiply(gate, asNumber(b, pinIsHigh(b, timer.gatePin), ctx)),
  );
  // 模式 3 只对 T1 表示停止：min(|mode-3|, 1) 在其它模式下为 1。
  const halted = timer.haltOnMode3
    ? b.min(b.abs(b.subtract(timerMode(b, ctx.tmod, timer), ctx.num(3))), ctx.num(1))
    : ctx.num(1);

  return b.multiply(b.multiply(bitValue(b, ctx.tcon, timer.runBit, ctx), gateOk), halted);
};

/**
 * 推进一个定时器。`index` 是运行期下标（0=T0、1=T1、2=T2）：三者共用的推进代码只生成
 * 一份，差异全部由下标算出——`periph` 偏移连续，TMOD 位偏移是 `4×(index%2)`，T2 没有
 * TMOD（把 AUXR.3 的 T2_C/T 挪到 TMOD.2 的位置拼出一个等价控制字节，模式恒为 0）。
 */
const advanceOneTimer = (
  b: Body,
  index: Value<number>,
  ctx: Context,
  sampleCount: (b: Body) => Value<number>,
  sampleGate: (b: Body) => Value<number>,
): void => {
  const second = b.remainder(index, ctx.num(2));
  const isT2 = b.shiftRightUnsigned(index, ctx.num(1));
  const shift = b.multiply(second, ctx.num(4));
  const runBit = b.add(ctx.num(4), b.multiply(second, ctx.num(2)));
  const speedBit = b.select(
    types.number,
    b.notEqual(types.number, isT2, ctx.num(0)),
    () => ctx.num(2),
    (inner) => inner.subtract(ctx.num(7), second),
  );
  const countOffset = b.add(T0_COUNT, b.multiply(index, ctx.num(2)));
  const phaseOffset = b.add(T0_PHASE, b.multiply(index, ctx.num(4)));
  const pinOffset = b.add(T0_PIN, index);
  const clockOffset = b.add(T0_CLOCK, index);
  const tmodLike = b.select(
    types.number,
    b.notEqual(types.number, isT2, ctx.num(0)),
    (inner) => inner.bitAnd(inner.shiftRightUnsigned(ctx.auxr, ctx.num(1)), ctx.num(4)),
    () => ctx.tmod,
  );
  const control = b.select(
    types.number,
    b.notEqual(types.number, isT2, ctx.num(0)),
    () => ctx.auxr,
    () => ctx.tcon,
  );
  const mode = b.bitAnd(b.shiftRightUnsigned(tmodLike, shift), ctx.num(3));
  const counter = b.bitAnd(b.shiftRightUnsigned(tmodLike, b.add(shift, ctx.num(2))), ctx.num(1));
  const gate = b.bitAnd(b.shiftRightUnsigned(tmodLike, b.add(shift, ctx.num(3))), ctx.num(1));
  // 只有真的用到引脚时才采样：定时方式不需要计数脚，GATE=0 时不需要门控脚。
  const gateLevel = b.select(
    types.number,
    b.notEqual(types.number, gate, ctx.num(0)),
    (inner) => sampleGate(asBody(inner)),
    () => ctx.num(1),
  );
  const countLevel = b.select(
    types.number,
    b.notEqual(types.number, counter, ctx.num(0)),
    (inner) => sampleCount(asBody(inner)),
    () => ctx.num(1),
  );
  const gateOk = b.add(b.subtract(ctx.num(1), gate), b.multiply(gate, gateLevel));
  // 模式 3 只对 T1（index=1）表示停止。
  const halted = b.select(
    types.number,
    b.notEqual(types.number, index, ctx.num(1)),
    () => ctx.num(1),
    (inner) => inner.min(inner.abs(inner.subtract(mode, ctx.num(3))), ctx.num(1)),
  );
  const active = b.multiply(
    b.multiply(b.bitAnd(b.shiftRightUnsigned(control, runBit), ctx.num(1)), gateOk),
    halted,
  );

  b.if(b.notEqual(types.number, active, ctx.num(0)), (running) => {
    const s = asBody(running);
    const fast = s.bitAnd(s.shiftRightUnsigned(ctx.auxr, speedBit), ctx.num(1));
    const period = s.subtract(
      s.multiply(ctx.num(12), ctx.num(ctx.cyclePs)),
      s.multiply(fast, ctx.num(11 * ctx.cyclePs)),
    );
    const total = s.add(s.load32le(PERIPH, phaseOffset), ctx.elapsedPs);
    const timed = s.floor(s.divide(total, period));
    const previous = s.load8(PERIPH, pinOffset);

    s.store32le(PERIPH, phaseOffset, s.subtract(total, s.multiply(timed, period)));
    s.store8(PERIPH, pinOffset, countLevel);
    const ticks = s.add(
      s.multiply(counter, s.multiply(previous, s.subtract(ctx.num(1), countLevel))),
      s.multiply(s.subtract(ctx.num(1), counter), timed),
    );

    s.if(s.notEqual(types.number, ticks, ctx.num(0)), (counted) => {
      const t = asBody(counted);
      // T2 的 T2L/T2H 与 T0/T1 的 TLx/THx 地址不连续（D7H/D6H），用下标选一次。
      const lowIndex = t.select(
        types.number,
        t.notEqual(types.number, isT2, ctx.num(0)),
        (inner) => inner.constant(types.number, SFR_T2L & 0x7f),
        (inner) => inner.add(inner.constant(types.number, SFR_TL0 & 0x7f), second),
      );
      const highIndex = t.select(
        types.number,
        t.notEqual(types.number, isT2, ctx.num(0)),
        (inner) => inner.constant(types.number, SFR_T2H & 0x7f),
        (inner) => inner.add(inner.constant(types.number, SFR_TH0 & 0x7f), second),
      );
      const highLatch = t.load8(SFR, highIndex);
      const lowLatch = t.load8(SFR, lowIndex);
      const latch16 = t.bitOr(t.shiftLeft(highLatch, ctx.num(8)), lowLatch);
      const modeIs2 = t.equal(types.number, mode, ctx.num(2));
      const modulus = t.select(
        types.number,
        modeIs2,
        (inner) => inner.constant(types.number, FULL_8),
        (inner) => inner.constant(types.number, FULL_16),
      );
      const autoReload = t.select(
        types.number,
        t.equal(types.number, mode, ctx.num(1)),
        (inner) => inner.constant(types.number, 0),
        (inner) => inner.constant(types.number, 1),
      );
      const reload = t.select(
        types.number,
        modeIs2,
        () => highLatch,
        () => latch16,
      );
      const current = t.bitAnd(t.load16le(PERIPH, countOffset), t.subtract(modulus, ctx.num(1)));
      // 自动重装模式的计数跨度是 `modulus - reload`（模式 2 是 8 位减去 THn）；
      // 不重装模式（模式 1）按整个模数回绕。
      const span = t.subtract(modulus, t.multiply(autoReload, reload));
      const offset = t.multiply(autoReload, reload);
      const distance = t.subtract(t.add(current, ticks), offset);
      const wraps = t.floor(t.divide(distance, span));
      const wrapped = t.min(wraps, ctx.num(1));
      const next = t.add(offset, t.subtract(distance, t.multiply(wraps, span)));

      t.store16le(PERIPH, countOffset, next);
      t.if(t.notEqual(types.number, wrapped, ctx.num(0)), (overflow) => {
        const o = asBody(overflow);
        const flagBit = o.add(ctx.num(5), o.multiply(second, ctx.num(2)));

        // T0/T1 的溢出标志在 TCON，T2 的隐藏标志在 periph。
        o.if(o.equal(types.number, isT2, ctx.num(0)), (standard) => {
          const x = asBody(standard);

          writeLatch(
            x,
            SFR_TCON,
            x.bitOr(x.load8(SFR, number(x, SFR_TCON & 0x7f)), x.shiftLeft(number(x, 1), flagBit)),
          );
        });
        o.if(o.equal(types.number, isT2, ctx.num(1)), (timer2) => {
          const x = asBody(timer2);

          setPeriph8(
            x,
            T2_REQUEST,
            x.select(
              types.number,
              sfrBitIsSet(x, SFR_IE2, 2),
              (inner) => inner.constant(types.number, 1),
              (inner) => inner.constant(types.number, 0),
            ),
          );
        });
        o.store8(PERIPH, clockOffset, o.subtract(ctx.num(1), o.load8(PERIPH, clockOffset)));
        setPeriph8(o, OVERFLOWED, o.bitOr(periph8(o, OVERFLOWED), o.shiftLeft(ctx.num(1), index)));
        markIrqDirty(o);
      });
    });
  });
};

/** 溢出后把翻转过的时钟输出电平写到对应引脚（同一引脚只在真的溢出时写一次意图）。 */
const flushClockOutputs = (b: Body, ctx: Context): void => {
  const overflowed = periph8(b, OVERFLOWED);

  for (let bit = 0; bit < CLOCK_PINS.length; bit += 1)
    b.if(
      b.notEqual(types.number, b.bitAnd(overflowed, number(b, 1 << bit)), number(b, 0)),
      (driven) => {
        const s = asBody(driven);

        s.if(s.notEqual(types.number, bitValue(s, ctx.clko, bit, ctx), ctx.num(0)), (active) => {
          const x = asBody(active);

          x.writeIntent(
            CLOCK_PINS[bit] as string,
            x.select(
              types.intent,
              x.notEqual(types.number, periph8(x, T0_CLOCK + bit), ctx.num(0)),
              () => ctx.high,
              () => ctx.low,
            ),
          );
        });
      },
    );
};

const advanceTimers = (b: Body, ctx: Context): void => {
  const count = (pin: string) => (target: Body) => asNumber(target, pinIsHigh(target, pin), ctx);
  const gate = (pin: string) => (target: Body) => asNumber(target, pinIsHigh(target, pin), ctx);

  setPeriph8(b, OVERFLOWED, ctx.num(0));
  advanceOneTimer(b, ctx.num(0), ctx, count(TIMER0.countPin), gate(TIMER0.gatePin));
  advanceOneTimer(b, ctx.num(1), ctx, count(TIMER1.countPin), gate(TIMER1.gatePin));
  advanceOneTimer(b, ctx.num(2), ctx, count(TIMER2.countPin), gate(TIMER2.gatePin));
  flushClockOutputs(b, ctx);
};

/**
 * 软件写 TH/TL。
 *
 * 模式 0/3 的 TH/TL 有隐藏重装影子：TRx=0 时写入同时更新计数器，TRx=1 时只写影子。
 * 模式 1 没有影子（TH/TL 就是计数器），模式 2 的 TH 是重装值、TL 是计数器。
 */
const writeStandardCount = (b: Body, timer: TimerSpec, high: boolean): void => {
  const tmod = readSfr(b, SFR_TMOD);
  const mode = timerMode(b, tmod, timer);
  const running = sfrBitIsSet(b, SFR_TCON, timer.runBit);
  const modeIs1 = b.equal(types.number, mode, number(b, 1));
  const modeIs2 = b.equal(types.number, mode, number(b, 2));
  // 影子模式（0/3）：只有停止计数时写入才落到计数器上。
  const shadowWrite = b.select(
    types.bool,
    modeIs2,
    (inner) => inner.constant(types.bool, false),
    (inner) => asBody(inner).not(running),
  );
  const lowWrite = b.select(
    types.bool,
    modeIs2,
    (inner) => inner.constant(types.bool, true),
    () => shadowWrite,
  );
  const condition = b.select(
    types.bool,
    modeIs1,
    (inner) => inner.constant(types.bool, true),
    () => (high ? shadowWrite : lowWrite),
  );

  b.if(condition, (update) => {
    const s = asBody(update);
    const current = periph16(s, timer.countOffset);
    const written = readSfrLatch(s, high ? timer.high : timer.low);
    const next = high
      ? s.bitOr(s.bitAnd(current, number(s, 0xff)), s.shiftLeft(written, number(s, 8)))
      : s.bitOr(s.bitAnd(current, number(s, 0xff00)), written);

    setPeriph16(s, timer.countOffset, next);
  });
};

/** 软件写 T2L/T2H：T2R=0 时同时写计数值，T2R=1 时只写隐藏的重装值。 */
const writeTimer2Count = (b: Body, high: boolean): void => {
  b.if(b.not(timer2Running(b)), (update) => {
    const s = asBody(update);
    const current = periph16(s, T2_COUNT);
    const written = readSfrLatch(s, high ? SFR_T2H : SFR_T2L);
    const next = high
      ? s.bitOr(s.bitAnd(current, number(s, 0xff)), s.shiftLeft(written, number(s, 8)))
      : s.bitOr(s.bitAnd(current, number(s, 0xff00)), written);

    setPeriph16(s, T2_COUNT, next);
  });
};

/** 启动/停止或切换计数方式后刷新引脚采样，避免把已经过去的那一段电平当成边沿。 */
const sampleCounterPin = (b: Body, timer: TimerSpec): void => {
  setPeriph8(
    b,
    timer.pinOffset,
    b.select(
      types.number,
      pinIsHigh(b, timer.countPin),
      (inner) => number(asBody(inner), 1),
      (inner) => number(asBody(inner), 0),
    ),
  );
};

const interrupts: readonly InterruptSource[] = [
  {
    id: 'timer0',
    vector: IRQ_VECTORS.timer0,
    query: 1,
    priority: { register: 'IP', bit: 1 },
    enabled: (b) => sfrBitIsSet(b, SFR_IE, 1),
    pending: (b) => sfrBitIsSet(b, SFR_TCON, 5),
    acknowledge: (b) => setSfrBit(b, SFR_TCON, 5, false),
  },
  {
    id: 'timer1',
    vector: IRQ_VECTORS.timer1,
    query: 3,
    priority: { register: 'IP', bit: 3 },
    enabled: (b) => sfrBitIsSet(b, SFR_IE, 3),
    pending: (b) => sfrBitIsSet(b, SFR_TCON, 7),
    acknowledge: (b) => setSfrBit(b, SFR_TCON, 7, false),
  },
  {
    id: 'timer2',
    vector: IRQ_VECTORS.timer2,
    query: 12,
    enabled: (b) => sfrBitIsSet(b, SFR_IE2, 2),
    pending: (b) => b.notEqual(types.number, periph8(b, T2_REQUEST), number(b, 0)),
    acknowledge: (b) => setPeriph8(b, T2_REQUEST, number(b, 0)),
  },
];

/** 串口用 T2 作波特率发生器时需要知道的重装值（隐藏寄存器 RL_TH2/RL_TL2）。 */
export const timer2Reload = (b: Body): Value<number> => readLatch16(b, SFR_T2H, SFR_T2L);

/** T2 是否在运行（AUXR.T2R）。 */
export const timer2IsRunning = timer2Running;

/** T2 的溢出周期，单位系统时钟：`(65536 - 重装值) × (T2x12 ? 1 : 12)`。 */
export const timer2OverflowCycles = (b: Body): Value<number> =>
  b.multiply(
    b.subtract(number(b, FULL_16), timer2Reload(b)),
    b.select(
      types.number,
      sfrBitIsSet(b, SFR_AUXR, 2),
      (inner) => inner.constant(types.number, cyclePicoseconds()),
      (inner) => inner.constant(types.number, cyclePicoseconds() * 12),
    ),
  );

/** 串口用 T1 作波特率发生器时的重装值：模式 2 是 TH1，其余模式是 RL_TH1/RL_TL1。 */
export const timer1Reload = (b: Body): Value<number> =>
  b.select(
    types.number,
    b.equal(types.number, timerMode(b, readSfr(b, SFR_TMOD), TIMER1), number(b, 2)),
    (inner) => readSfrLatch(asBody(inner), SFR_TH1),
    (inner) => readLatch16(asBody(inner), SFR_TH1, SFR_TL1),
  );

/** T1 的溢出周期，单位系统时钟（模式 2 数 8 位，其余数 16 位，再乘 ÷1/÷12）。 */
export const timer1OverflowCycles = (b: Body): Value<number> =>
  b.multiply(
    b.select(
      types.number,
      b.equal(types.number, timerMode(b, readSfr(b, SFR_TMOD), TIMER1), number(b, 2)),
      (inner) =>
        inner.subtract(inner.constant(types.number, FULL_8), readSfrLatch(asBody(inner), SFR_TH1)),
      (inner) => inner.subtract(inner.constant(types.number, FULL_16), timer1Reload(asBody(inner))),
    ),
    b.select(
      types.number,
      sfrBitIsSet(b, SFR_AUXR, 6),
      (inner) => inner.constant(types.number, cyclePicoseconds()),
      (inner) => inner.constant(types.number, cyclePicoseconds() * 12),
    ),
  );

/** 复用功能的启用条件：时钟输出允许位 + 定时器正在运行。 */
const clockOutputEnabled = (b: Body, timer: TimerSpec): Value<boolean> =>
  b.and(sfrBitIsSet(b, SFR_INT_CLKO, timer.clockBit), (inner) => {
    const s = asBody(inner);
    const ctx = contextOf(s, number(s, 0), 1);

    return s.notEqual(types.number, runCondition(s, timer, ctx), ctx.num(0));
  });

registerAlternateDriver({
  id: 'timer0-clock-output',
  port: 3,
  bit: TIMER0.clockPin,
  enabled: (b) => clockOutputEnabled(b, TIMER0),
  level: (b) => sfrBitIsSet(b, T0_CLOCK, 0),
});

registerAlternateDriver({
  id: 'timer1-clock-output',
  port: 3,
  bit: TIMER1.clockPin,
  enabled: (b) => clockOutputEnabled(b, TIMER1),
  level: (b) => sfrBitIsSet(b, T1_CLOCK, 0),
});

registerAlternateDriver({
  id: 'timer2-clock-output',
  port: 3,
  bit: TIMER2.clockPin,
  enabled: (b) =>
    b.and(sfrBitIsSet(b, SFR_INT_CLKO, TIMER2.clockBit), (inner) => timer2Running(asBody(inner))),
  level: (b) => sfrBitIsSet(b, T2_CLOCK, 0),
});

export function createTimer(clock: Clock): Peripheral {
  const cyclePs = Math.max(1, clock.cyclePs);

  return {
    id: 'timer',
    writes: [
      SFR_TCON,
      SFR_TMOD,
      SFR_TL0,
      SFR_TH0,
      SFR_TL1,
      SFR_TH1,
      SFR_AUXR,
      SFR_INT_CLKO,
      SFR_T2L,
      SFR_T2H,
      SFR_IE2,
    ],
    reads: [SFR_TL0, SFR_TH0, SFR_TL1, SFR_TH1, SFR_T2L, SFR_T2H],
    onWrite(b, address) {
      switch (address) {
        case SFR_TL0:
        case SFR_TH0:
          writeStandardCount(b, TIMER0, address === SFR_TH0);

          return;
        case SFR_TL1:
        case SFR_TH1:
          writeStandardCount(b, TIMER1, address === SFR_TH1);

          return;
        case SFR_T2L:
        case SFR_T2H:
          writeTimer2Count(b, address === SFR_T2H);

          return;
        case SFR_TCON:
          // TR0/TR1 改变运行条件与时钟输出的启用条件。
          sampleCounterPin(b, TIMER0);
          sampleCounterPin(b, TIMER1);
          syncPin(b, 3, TIMER0.clockPin);
          syncPin(b, 3, TIMER1.clockPin);

          return;
        case SFR_AUXR:
          sampleCounterPin(b, TIMER2);
          syncPin(b, 3, TIMER2.clockPin);

          return;
        case SFR_INT_CLKO:
          syncPin(b, 3, TIMER0.clockPin);
          syncPin(b, 3, TIMER1.clockPin);
          syncPin(b, 3, TIMER2.clockPin);

          return;
        case SFR_IE2:
          // 手册：ET2=0 时 T2 的隐藏请求标志立即被清掉。
          b.if(b.not(sfrBitIsSet(b, SFR_IE2, 2)), (cleared) =>
            setPeriph8(cleared, T2_REQUEST, number(cleared, 0)),
          );

          return;
        default:
          return;
      }
    },
    onRead(b, address) {
      switch (address) {
        case SFR_TL0:
          return countByte(b, T0_COUNT, false);
        case SFR_TH0:
          return standardHighByte(b, TIMER0);
        case SFR_TL1:
          return countByte(b, T1_COUNT, false);
        case SFR_TH1:
          return standardHighByte(b, TIMER1);
        case SFR_T2L:
          return countByte(b, T2_COUNT, false);
        default:
          return countByte(b, T2_COUNT, true);
      }
    },
    advance(b, advance) {
      advanceTimers(b, contextOf(b, advance.elapsedPs, cyclePs));
    },
    /** 任一定时器在跑（含时钟输出）时才需要按时间推进。 */
    active(b) {
      return b.or(latchBitIsSet(b, SFR_TCON, 4), (inner) => {
        const s = asBody(inner);

        return s.or(latchBitIsSet(s, SFR_TCON, 6), (deeper) =>
          latchBitIsSet(asBody(deeper), SFR_AUXR, 4),
        );
      });
    },
    interrupts,
  };
}
