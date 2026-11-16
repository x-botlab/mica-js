import { types } from '@mica-js/sdk/model';
import type { MemoryRef, Value } from '@mica-js/sdk/model';
import {
  PERIPH,
  SFR,
  SFR_P_SW1,
  asBody,
  boolean,
  number,
  periph8,
  readSfr,
  setPeriph8,
  setPeriph32,
  sfrBitIsSet,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_DIRTY, IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import { SPI_BASE } from './layout';
import {
  DRIVE_RESISTANCE,
  GROUND_PIN,
  SUPPLY_PIN,
  pinName,
  registerAlternateDriver,
  switchBits,
  syncPin,
} from './ports';
import type { Clock, Peripheral } from './types';

/**
 * SPI 主模式（STC15F2K60S2 系列）。
 *
 * 手册第 14 章：SPCTL 控制、SPSTAT 状态、SPDAT 数据寄存器；引脚组由 P_SW1 的
 * SPI_S1:SPI_S0 选择。15F/15L 系列只支持主机模式（14.9 节），因此 MSTR=0 时不产生时钟，
 * 写 SPDAT 也不会启动传输。
 *
 * 时序模型：SCLK 周期 = 分频系数 × 系统时钟，`advance` 按经过的皮秒数累加相位，每半个
 * 周期推进一个边沿；一次传输固定 16 个半周期（8 位 × 2）。CPOL 决定空闲极性，CPHA 决定
 * 采样边沿（=0 前沿采样、后沿换位；=1 前沿换位、后沿采样），DORD 决定先送 MSB 还是 LSB。
 * 8 位收发完成后置 SPIF、把收到的字节写回 SPDAT 并通知中断控制器。
 *
 * `advance` 会进入每一条指令的 IR，生成体积直接决定器件可用性，因此这里刻意做了几件事：
 * 顶层只读一个「传输中」标志、空闲时整段跳过；常量、`periph`/SFR 引用与位选择在进入循环
 * 前只生成一次；循环体只改 `periph` 里的寄存器；引脚意图在每次调用末尾按当前电平写一次
 * （一个指令边界内即使走过多个半周期，也只能看到最后一个电平）。引脚复用只在 SFR 写钩子
 * 里用完整端口语义重算。
 *
 * 状态（`SPI_BASE` = 0x78）：
 * - 0x78 发送移位寄存器（每次换位后左移/右移一位）
 * - 0x79 接收移位寄存器
 * - 0x7a 已完成的半周期数（0…16）
 * - 0x7b 标志：bit0 传输中、bit2 MOSI 电平、bit6 WCOL、bit7 SPIF
 * - 0x7c–0x7f 半个 SCLK 周期的相位累加器（皮秒）
 *
 * SCLK 电平不单独存放：等于「半周期序号为奇数」异或 CPOL，空闲（偶数）时自然回到 CPOL。
 * SPSTAT 的 SPIF/WCOL 在 `periph` 里保留一份并同步到锁存器：硬件置位时直接改写锁存器，
 * 不触发「写 1 清零」的写钩子。
 */

const SFR_SPSTAT = 0xcd;
const SFR_SPCTL = 0xce;
const SFR_SPDAT = 0xcf;
/** IE2：ESPI 位于 bit1；`kernel/ir` 没有该常量，按地址访问。 */
const SFR_IE2 = 0xaf;

const SPI_TX = SPI_BASE;
const SPI_RX = SPI_BASE + 1;
const SPI_HALF = SPI_BASE + 2;
const SPI_FLAGS = SPI_BASE + 3;
const SPI_PHASE = SPI_BASE + 4;

const FLAG_ACTIVE = 0x01;
const FLAG_MOSI = 0x04;
const FLAG_WCOL = 0x40;
const FLAG_SPIF = 0x80;

/** SPSTAT 中写 1 清零的两位。 */
const STATUS_FLAGS = FLAG_SPIF | FLAG_WCOL;

/** 一次传输的 16 个半周期。 */
const HALF_EDGES = 16;

interface SpiPin {
  readonly port: number;
  readonly bit: number;
}

interface SpiPinGroup {
  readonly sclk: SpiPin;
  readonly mosi: SpiPin;
  readonly miso: SpiPin;
}

/**
 * SPI 引脚组，索引等于 SPI_S1:SPI_S0。
 *
 * 手册第三组是 [P5.4/SS_3, P4.0/MOSI_3, P4.1/MISO_3, P4.3/SCLK_3]，本器件模型只声明 P0–P3，
 * 因此 10 没有对应引脚；11 按手册是无效组合。
 */
const PIN_GROUPS: readonly SpiPinGroup[] = [
  { sclk: { port: 1, bit: 5 }, mosi: { port: 1, bit: 3 }, miso: { port: 1, bit: 4 } },
  { sclk: { port: 2, bit: 1 }, mosi: { port: 2, bit: 3 }, miso: { port: 2, bit: 2 } },
];

/** 直接写 SFR 锁存器：硬件改写 SPDAT/SPSTAT 时不触发写钩子。 */
const storeLatch = (b: Body, address: number, value: Value<number>): void => {
  b.store8(SFR, number(b, address & 0x7f), value);
};

const flagIsSet = (b: Body, flag: number): Value<boolean> =>
  b.notEqual(types.number, b.bitAnd(periph8(b, SPI_FLAGS), number(b, flag)), number(b, 0));

const setFlag = (b: Body, flag: number, on: Value<boolean>): void => {
  const flags = periph8(b, SPI_FLAGS);
  const set = b.bitOr(flags, number(b, flag));
  const clear = b.bitAnd(flags, number(b, 0xff & ~flag));

  setPeriph8(
    b,
    SPI_FLAGS,
    b.select(
      types.number,
      on,
      () => set,
      () => clear,
    ),
  );
};

/** 把 SPIF/WCOL 同步到 SPSTAT 锁存器；低 6 位读作 0。 */
const syncStatus = (b: Body): void => {
  storeLatch(b, SFR_SPSTAT, b.bitAnd(periph8(b, SPI_FLAGS), number(b, STATUS_FLAGS)));
};

const cphaIsHigh = (b: Body): Value<boolean> => sfrBitIsSet(b, SFR_SPCTL, 2);
const cpolIsHigh = (b: Body): Value<boolean> => sfrBitIsSet(b, SFR_SPCTL, 3);
const dordIsLowFirst = (b: Body): Value<boolean> => sfrBitIsSet(b, SFR_SPCTL, 5);

/** 主模式：SPEN=1 且 MSTR=1；MSTR=0 时外设不驱动任何引脚。 */
const masterEnabled = (b: Body): Value<boolean> =>
  b.and(sfrBitIsSet(b, SFR_SPCTL, 6), (inner) => sfrBitIsSet(asBody(inner), SFR_SPCTL, 4));

const groupSelected = (b: Body, index: number): Value<boolean> =>
  b.equal(types.number, switchBits(b, 3, 2), number(b, index));

/** 引脚是否处于高电平（浮空按低处理，与端口读数一致）。 */
const pinIsHigh = (b: Body, pin: SpiPin): Value<boolean> =>
  b.equal(
    types.logic,
    b.field(b.readSample(pinName(pin.port, pin.bit)), 'level'),
    types.logic.members.high,
  );

/** 当前 SCLK 电平：第奇数个半周期为有效电平，偶数（含空闲）为 CPOL。 */
const sclkIsHigh = (b: Body): Value<boolean> =>
  b.notEqual(
    types.bool,
    b.equal(types.number, b.bitAnd(periph8(b, SPI_HALF), number(b, 1)), number(b, 1)),
    cpolIsHigh(b),
  );

const mosiIsHigh = (b: Body): Value<boolean> => flagIsSet(b, FLAG_MOSI);

/** 引脚切换与使能变化时用完整端口语义重算（只在 SFR 写钩子里调用）。 */
const syncAllOutputs = (b: Body): void => {
  for (const group of PIN_GROUPS) {
    syncPin(b, group.sclk.port, group.sclk.bit);
    syncPin(b, group.mosi.port, group.mosi.bit);
  }
};

/** 8 位反转：DORD=1 时在触发/读取的钩子里换算，热路径就可以按 MSB 优先统一处理。 */
const reverseBits = (b: Body, value: Value<number>): Value<number> => {
  let remaining = value;
  let result = b.bitAnd(remaining, number(b, 1));

  for (let index = 1; index < 8; index += 1) {
    remaining = b.shiftRightUnsigned(remaining, number(b, 1));
    result = b.bitOr(b.shiftLeft(result, number(b, 1)), b.bitAnd(remaining, number(b, 1)));
  }

  return result;
};

/** 写 SPDAT 启动一次传输；CPHA=0 时第一位立即出现在 MOSI 上。 */
const beginTransfer = (b: Body, data: Value<number>): void => {
  const lowFirst = dordIsLowFirst(b);
  // DORD=1 时先把字节反过来，之后移位方向统一为「先出最高位」。
  const tx = b.select(
    types.number,
    lowFirst,
    (inner) => reverseBits(asBody(inner), data),
    (inner) => inner.bitAnd(data, inner.constant(types.number, 0xff)),
  );

  setPeriph8(b, SPI_TX, tx);
  setPeriph8(b, SPI_RX, 0);
  setPeriph8(b, SPI_HALF, 0);
  setPeriph32(b, SPI_PHASE, number(b, 0));
  setFlag(b, FLAG_MOSI, boolean(b, true));
  setFlag(b, FLAG_ACTIVE, boolean(b, true));

  // CPHA=0：空闲时就送出第一位并移位；CPHA=1：第一位等第一个前沿再送出。
  b.if(
    cphaIsHigh(b),
    () => {},
    (immediate) => {
      const body = asBody(immediate);

      setFlag(
        body,
        FLAG_MOSI,
        body.equal(types.number, body.shiftRightUnsigned(tx, number(body, 7)), number(body, 1)),
      );
      setPeriph8(body, SPI_TX, body.shiftLeft(tx, number(body, 1)));
    },
  );
  syncAllOutputs(b);
};

/**
 * 一次 `advance` 里复用的操作数与引用：常量、`periph` 引用和位选择只生成一次。
 *
 * 这些值只在本次生成内有效，不能跨指令保存。
 */
interface SpiStep {
  readonly memory: MemoryRef;
  readonly control: Value<number>;
  readonly half: Value<number>;
  readonly flags: Value<number>;
  readonly tx: Value<number>;
  readonly rx: Value<number>;
  readonly spdat: Value<number>;
  readonly spstat: Value<number>;
  readonly dirty: Value<number>;
  readonly phase: Value<number>;
  readonly one: Value<number>;
  readonly zero: Value<number>;
  readonly seven: Value<number>;
  readonly sixteen: Value<number>;
  readonly mosiBit: Value<number>;
  readonly clearMosi: Value<number>;
  readonly keepFlags: Value<number>;
  readonly doneBits: Value<number>;
  readonly statusMask: Value<number>;
  readonly resistance: Value<number>;
  readonly cpha: Value<boolean>;
  readonly cpol: Value<boolean>;
  readonly firstGroup: Value<boolean>;
  readonly secondGroup: Value<boolean>;
}

const createStep = (b: Body): SpiStep => {
  // SPCTL 与 P_SW1 各只读一次，位判断用掩码比较。
  const control = readSfr(b, SFR_SPCTL);
  const cpha = b.equal(types.number, b.bitAnd(control, number(b, 0x04)), number(b, 0x04));
  const cpol = b.equal(types.number, b.bitAnd(control, number(b, 0x08)), number(b, 0x08));
  const selection = readSfr(b, SFR_P_SW1);

  return {
    memory: b.memory(PERIPH),
    control,
    half: number(b, SPI_HALF),
    flags: number(b, SPI_FLAGS),
    tx: number(b, SPI_TX),
    rx: number(b, SPI_RX),
    spdat: number(b, SFR_SPDAT & 0x7f),
    spstat: number(b, SFR_SPSTAT & 0x7f),
    dirty: number(b, IRQ_DIRTY),
    phase: number(b, SPI_PHASE),
    one: number(b, 1),
    zero: number(b, 0),
    seven: number(b, 7),
    sixteen: number(b, HALF_EDGES),
    mosiBit: number(b, FLAG_MOSI),
    clearMosi: number(b, 0xff & ~FLAG_MOSI),
    keepFlags: number(b, 0xff & ~FLAG_ACTIVE),
    doneBits: number(b, FLAG_MOSI | FLAG_SPIF),
    statusMask: number(b, STATUS_FLAGS),
    resistance: number(b, DRIVE_RESISTANCE),
    cpha,
    cpol,
    firstGroup: b.equal(types.number, b.bitAnd(selection, number(b, 0x0c)), number(b, 0)),
    secondGroup: b.equal(types.number, b.bitAnd(selection, number(b, 0x0c)), number(b, 0x04)),
  };
};

/** 一次传输结束：写回接收字节、置 SPIF、MOSI 回到空闲高电平。 */
const finishTransfer = (b: Body, step: SpiStep): void => {
  const mem = step.memory;
  const flags = b.bitOr(b.bitAnd(b.load8(mem, step.flags), step.keepFlags), step.doneBits);

  b.store8(SFR, step.spdat, b.load8(mem, step.rx));
  b.store8(mem, step.flags, flags);
  b.store8(SFR, step.spstat, b.bitAnd(flags, step.statusMask));
  b.store8(mem, step.dirty, step.one);
  b.store32le(mem, step.phase, step.zero);
};

/** 采样边沿：把 MISO 移入接收寄存器（DORD 的顺序在读取钩子里还原）。 */
const sampleBit = (b: Body, step: SpiStep): void => {
  const mem = step.memory;
  const high = b.select(
    types.bool,
    step.firstGroup,
    (inner) => pinIsHigh(asBody(inner), PIN_GROUPS[0]!.miso),
    (inner) => pinIsHigh(asBody(inner), PIN_GROUPS[1]!.miso),
  );

  b.store8(
    mem,
    step.rx,
    b.bitOr(
      b.shiftLeft(b.load8(mem, step.rx), step.one),
      b.select(
        types.number,
        high,
        () => step.one,
        () => step.zero,
      ),
    ),
  );
};

/** 换位边沿：把发送寄存器的最高位送到 MOSI，再左移。 */
const shiftOutBit = (b: Body, step: SpiStep): void => {
  const mem = step.memory;
  const sent = b.load8(mem, step.tx);
  const bit = b.shiftRightUnsigned(sent, step.seven);

  b.store8(
    mem,
    step.flags,
    b.bitOr(b.bitAnd(b.load8(mem, step.flags), step.clearMosi), b.multiply(bit, step.mosiBit)),
  );
  b.store8(mem, step.tx, b.shiftLeft(sent, step.one));
};

/** 推进一个半周期。 */
const stepEdge = (b: Body, step: SpiStep): void => {
  const half = b.add(b.load8(step.memory, step.half), step.one);

  b.store8(step.memory, step.half, half);
  b.if(
    b.notEqual(types.bool, step.cpha, b.equal(types.number, b.bitAnd(half, step.one), step.one)),
    (take) => sampleBit(asBody(take), step),
    (shift) => shiftOutBit(asBody(shift), step),
  );
  b.if(b.equal(types.number, half, step.sixteen), (done) => finishTransfer(asBody(done), step));
};

/** 每次推进结束后按当前电平更新复用输出：只碰当前选中的引脚组。 */
const driveOutputs = (b: Body, step: SpiStep): void => {
  const mem = step.memory;
  const sclk = b.notEqual(
    types.bool,
    b.equal(types.number, b.bitAnd(b.load8(mem, step.half), step.one), step.one),
    step.cpol,
  );
  const mosi = b.notEqual(
    types.number,
    b.bitAnd(b.load8(mem, step.flags), step.mosiBit),
    step.zero,
  );
  const high = b.resistor(SUPPLY_PIN, step.resistance);
  const low = b.resistor(GROUND_PIN, step.resistance);

  const driveGroup = (body: Body, index: number): void => {
    const group = PIN_GROUPS[index]!;

    body.writeIntent(
      pinName(group.sclk.port, group.sclk.bit),
      body.select(
        types.intent,
        sclk,
        () => high,
        () => low,
      ),
    );
    body.writeIntent(
      pinName(group.mosi.port, group.mosi.bit),
      body.select(
        types.intent,
        mosi,
        () => high,
        () => low,
      ),
    );
  };

  b.if(
    step.firstGroup,
    (selected) => driveGroup(selected, 0),
    (other) => other.if(step.secondGroup, (selected) => driveGroup(asBody(selected), 1)),
  );
};

/** SCLK 周期 = (4 << 2·SPR1:SPR0) × SYSclk；返回半个周期（皮秒）。 */
const halfPeriodPs = (b: Body, control: Value<number>, cyclePs: number): Value<number> => {
  const spr = b.bitAnd(control, number(b, 3));
  const divider = b.shiftLeft(number(b, 4), b.multiply(spr, number(b, 2)));

  return b.multiply(divider, number(b, cyclePs / 2));
};

export function createSpi(clock: Clock): Peripheral {
  // 复用输出：主模式下 SCLK 与 MOSI 推挽输出，MISO 始终是输入。
  for (const [index, group] of PIN_GROUPS.entries()) {
    registerAlternateDriver({
      id: `spi.sclk.${index}`,
      port: group.sclk.port,
      bit: group.sclk.bit,
      enabled: (b) => b.and(masterEnabled(b), (inner) => groupSelected(asBody(inner), index)),
      level: (b) => sclkIsHigh(b),
    });
    registerAlternateDriver({
      id: `spi.mosi.${index}`,
      port: group.mosi.port,
      bit: group.mosi.bit,
      enabled: (b) => b.and(masterEnabled(b), (inner) => groupSelected(asBody(inner), index)),
      level: (b) => mosiIsHigh(b),
    });
  }

  return {
    id: 'spi',
    writes: [SFR_SPSTAT, SFR_SPCTL, SFR_SPDAT, SFR_P_SW1],
    reads: [SFR_SPDAT],
    interrupts: [
      {
        id: 'spi',
        vector: IRQ_VECTORS.spi,
        query: 9,
        priority: { register: 'IP2', bit: 1 },
        enabled: (b) => sfrBitIsSet(b, SFR_IE2, 1),
        pending: (b) => sfrBitIsSet(b, SFR_SPSTAT, 7),
      },
    ],
    onRead(b) {
      // DORD=1 时接收寄存器按「先收到的高位在前」保存，读回前要反过来。
      const latch = b.load8(SFR, number(b, SFR_SPDAT & 0x7f));

      return b.select(
        types.number,
        dordIsLowFirst(b),
        (inner) => reverseBits(asBody(inner), latch),
        () => latch,
      );
    },
    onWrite(b, address, value) {
      if (address === SFR_SPSTAT) {
        // 写 1 清零；SPIF 消失要重新扫描中断请求。
        b.if(
          b.notEqual(types.number, b.bitAnd(value, number(b, FLAG_SPIF)), number(b, 0)),
          (clear) => {
            const body = asBody(clear);

            setFlag(body, FLAG_SPIF, boolean(body, false));
            markIrqDirty(body);
          },
        );
        b.if(
          b.notEqual(types.number, b.bitAnd(value, number(b, FLAG_WCOL)), number(b, 0)),
          (clear) => setFlag(asBody(clear), FLAG_WCOL, boolean(asBody(clear), false)),
        );
        syncStatus(b);

        return;
      }

      if (address === SFR_SPCTL) {
        b.if(
          sfrBitIsSet(b, SFR_SPCTL, 6),
          () => {},
          (disabled) => setFlag(asBody(disabled), FLAG_ACTIVE, boolean(asBody(disabled), false)),
        );
        syncAllOutputs(b);

        return;
      }

      if (address === SFR_P_SW1) {
        syncAllOutputs(b);

        return;
      }

      // SPDAT：主模式空闲时启动传输，传输中写则置 WCOL。
      b.if(masterEnabled(b), (master) => {
        const body = asBody(master);

        body.if(
          flagIsSet(body, FLAG_ACTIVE),
          (busy) => {
            const inner = asBody(busy);

            setFlag(inner, FLAG_WCOL, boolean(inner, true));
            syncStatus(inner);
          },
          (idle) => beginTransfer(asBody(idle), value),
        );
      });
    },
    /** 主机在移位（FLAG_ACTIVE）时才有时间行为。 */
    active(b) {
      return flagIsSet(b, FLAG_ACTIVE);
    },
    advance(b, advance) {
      b.if(flagIsSet(b, FLAG_ACTIVE), (running) => {
        const body = asBody(running);
        const step = createStep(body);
        const mem = step.memory;
        const half = halfPeriodPs(body, step.control, clock.cyclePs);

        body.store32le(
          mem,
          step.phase,
          body.add(body.load32le(mem, step.phase), advance.elapsedPs),
        );
        body.while(
          (test) => test.greaterThanOrEqual(test.load32le(mem, step.phase), half),
          (emit) => {
            emit.store32le(mem, step.phase, emit.subtract(emit.load32le(mem, step.phase), half));
            stepEdge(emit, step);
          },
        );
        driveOutputs(body, step);
      });
    },
  };
}
