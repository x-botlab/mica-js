import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  SFR_ADC_CONTR,
  SFR_ADC_RES,
  SFR_ADC_RESL,
  SFR_CLK_DIV,
  SFR_IE,
  SFR_P1ASF,
  asBody,
  byte,
  number,
  periph8,
  periph32,
  readSfr,
  readSfrBit,
  setPeriph8,
  setPeriph32,
  SFR,
  writeSfr,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import { ADC_BASE } from './layout';
import { SUPPLY_PIN, pinName } from './ports';
import type { Clock, Peripheral } from './types';

/**
 * A/D 转换器（第 10 章）。
 *
 * 8 路 10 位逐次比较型 ADC：`ADC_CONTR` 的 CHS2:CHS0 选通 P1.0–P1.7，通道是否进入模拟
 * 通路由 `P1ASF` 的同号位决定；ADC_POWER 关断时不启动，ADCS 由硬件在转换结束时清零。
 * 转换耗时由 SPEED1:SPEED0 决定（540/360/180/90 个系统时钟），`advance` 按经过的仿真
 * 时间递减剩余时间，因此转换期间 CPU 继续执行。
 *
 * 结果寄存器按 `CLK_DIV.ADRJ` 左右对齐：ADRJ=0 时 ADC_RES 存高 8 位、ADC_RESL 的低 2 位
 * 存低 2 位；ADRJ=1 时反过来。
 *
 * 手册 10.7/10.8 的「第 9 通道」是内部 BandGap 参考电压，选通方式是 P1ASF 全 0 且 CHS=0
 * （CHS 只有 3 位，没有第 8/9 通道的编码）。通道 9 的手册用途（反推 VCC）由软件完成。
 */

/** 剩余转换时间（ps），32 位。 */
const REMAINING = ADC_BASE;
/** 转换进行中标志（0/1）。 */
const BUSY = ADC_BASE + 4;
/** 启动时锁存的通道号（CHS2:CHS0）。 */
const CHANNEL = ADC_BASE + 5;

/** SPEED1:SPEED0 = 00/01/10/11 对应的转换时钟数（手册 10.2 的转换速度表）。 */
const FULL_SCALE = 1023;
const NOMINAL_VCC = 5;
const MIN_VCC = 0.1;
/** 内部 BandGap 参考电压（手册 10.8 给出约 1.27 V，F2K60S2 数据手册典型值 1.19 V）。 */
const BANDGAP_VOLTAGE = 1.19;

const ADC_POWER = 0x80;
const ADC_FLAG = 0x10;
const ADC_START = 0x08;
const ADRJ_BIT = 5;

const bitOf = (b: Body, condition: Value<boolean>): Value<number> =>
  b.select(
    types.number,
    condition,
    (inner) => number(asBody(inner), 1),
    (inner) => number(asBody(inner), 0),
  );

/** 引脚采样电压；浮空（没有可解出的电位）按 0 V 处理，是手册未定义时最保守的选择。 */
const pinVoltage = (b: Body, pin: string): Value<number> => {
  const voltage = b.field(b.readSample(pin), 'voltage');

  return b.select(
    types.number,
    b.isNone(voltage),
    (inner) => number(asBody(inner), 0),
    (inner) => inner.nonNull(voltage),
  );
};

/** 通道 n 的模拟电压：P1ASF 未置位时该口不进入模拟通路，读作 0 V。 */
const analogVoltage = (b: Body, bit: number): Value<number> =>
  b.multiply(readSfrBit(b, SFR_P1ASF, bit), pinVoltage(b, pinName(1, bit)));

/** 通道 0 在 P1ASF.0=0 时改接内部 BandGap，即手册 10.7 的「第 9 通道」。 */
function channelAt(b: Body, index: number): Value<number> {
  if (index !== 0) return analogVoltage(b, index);

  const analog = readSfrBit(b, SFR_P1ASF, 0);

  return b.add(
    b.multiply(analog, pinVoltage(b, pinName(1, 0))),
    b.multiply(b.subtract(number(b, 1), analog), number(b, BANDGAP_VOLTAGE)),
  );
}

/** 按运行期通道号展开成常量通道选择链。 */
function channelVoltage(b: Body, channel: Value<number>): Value<number> {
  const build = (inner: Body, index: number): Value<number> => {
    if (index === 7) return channelAt(inner, index);

    return inner.select(
      types.number,
      inner.equal(types.number, channel, number(asBody(inner), index)),
      (selected) => channelAt(asBody(selected), index),
      (next) => build(asBody(next), index + 1),
    );
  };

  return build(b, 0);
}

/** 参考电压：默认取 VCC 引脚的采样电压，读不到或不合理时退回 5 V。 */
const referenceVoltage = (b: Body): Value<number> => {
  const voltage = b.field(b.readSample(SUPPLY_PIN), 'voltage');
  const sampled = b.select(
    types.number,
    b.isNone(voltage),
    (inner) => number(asBody(inner), NOMINAL_VCC),
    (inner) => inner.nonNull(voltage),
  );
  const usable = bitOf(b, b.greaterThan(sampled, number(b, MIN_VCC)));

  return b.add(
    b.multiply(usable, sampled),
    b.multiply(b.subtract(number(b, 1), usable), number(b, NOMINAL_VCC)),
  );
};

/** SPEED1:SPEED0 → 转换所需系统时钟数：540/360/180/90。 */
const conversionClocks = (b: Body, speed1: Value<number>, speed0: Value<number>): Value<number> =>
  b.select(
    types.number,
    b.notEqual(types.number, speed1, number(b, 0)),
    (slow) => {
      const body = asBody(slow);

      return body.select(
        types.number,
        body.notEqual(types.number, speed0, number(body, 0)),
        (inner) => number(asBody(inner), 90),
        (inner) => number(asBody(inner), 180),
      );
    },
    (fast) => {
      const body = asBody(fast);

      return body.select(
        types.number,
        body.notEqual(types.number, speed0, number(body, 0)),
        (inner) => number(asBody(inner), 360),
        (inner) => number(asBody(inner), 540),
      );
    },
  );

/** 原始锁存器写入：不触发外设钩子。 */
const storeSfr = (b: Body, address: number, value: Value<number>): void => {
  b.store8(SFR, number(b, address & 0x7f), byte(b, value));
};

/** 转换结束：写结果、置 ADC_FLAG、清 ADCS、清忙标志。 */
const finishConversion = (b: Body): void => {
  const voltage = channelVoltage(b, periph8(b, CHANNEL));
  const reference = referenceVoltage(b);
  const scaled = b.round(b.multiply(b.divide(voltage, reference), number(b, FULL_SCALE)));
  const raw = b.min(b.max(scaled, number(b, 0)), number(b, FULL_SCALE));
  const adrj = readSfrBit(b, SFR_CLK_DIV, ADRJ_BIT);
  const high = b.bitAnd(b.shiftRightUnsigned(raw, number(b, 2)), number(b, 0xff));
  const low = b.bitAnd(raw, number(b, 0x03));
  const notAdrj = b.subtract(number(b, 1), adrj);

  storeSfr(b, SFR_ADC_RES, b.add(b.multiply(adrj, low), b.multiply(notAdrj, high)));
  storeSfr(b, SFR_ADC_RESL, b.add(b.multiply(adrj, high), b.multiply(notAdrj, low)));
  writeSfr(
    b,
    SFR_ADC_CONTR,
    b.bitOr(b.bitAnd(readSfr(b, SFR_ADC_CONTR), number(b, 0xff & ~ADC_START)), number(b, ADC_FLAG)),
  );
  setPeriph8(b, BUSY, 0);
  setPeriph32(b, REMAINING, number(b, 0));
  markIrqDirty(b);
};

export function createAdc(clock: Clock): Peripheral {
  const beginConversion = (b: Body): void => {
    const speed1 = readSfrBit(b, SFR_ADC_CONTR, 6);
    const speed0 = readSfrBit(b, SFR_ADC_CONTR, 5);
    const clocks = conversionClocks(b, speed1, speed0);

    setPeriph32(b, REMAINING, b.multiply(clocks, number(b, clock.cyclePs)));
    setPeriph8(b, BUSY, 1);
    setPeriph8(
      b,
      CHANNEL,
      b.bitOr(
        b.bitOr(
          b.shiftLeft(readSfrBit(b, SFR_ADC_CONTR, 2), number(b, 2)),
          b.shiftLeft(readSfrBit(b, SFR_ADC_CONTR, 1), number(b, 1)),
        ),
        readSfrBit(b, SFR_ADC_CONTR, 0),
      ),
    );
  };

  return {
    id: 'adc',
    writes: [SFR_ADC_CONTR],
    onWrite(b, address, value) {
      if (address !== SFR_ADC_CONTR) return;

      const start = b.equal(
        types.number,
        b.bitAnd(value, number(b, ADC_START)),
        number(b, ADC_START),
      );
      const powered = b.equal(
        types.number,
        b.bitAnd(value, number(b, ADC_POWER)),
        number(b, ADC_POWER),
      );

      b.if(
        powered,
        (on) => {
          asBody(on).if(start, (started) => beginConversion(asBody(started)));
        },
        (off) => {
          setPeriph8(asBody(off), BUSY, 0);
          setPeriph32(asBody(off), REMAINING, number(asBody(off), 0));
        },
      );
    },
    /** 只有在转换过程中才需要推进。 */
    active(b) {
      return b.notEqual(types.number, periph8(b, BUSY), number(b, 0));
    },
    advance(b, advance) {
      b.if(b.notEqual(types.number, periph8(b, BUSY), number(b, 0)), (busy) => {
        const body = asBody(busy);
        const left = body.subtract(periph32(body, REMAINING), advance.elapsedPs);

        body.if(
          body.lessThanOrEqual(left, number(body, 0)),
          (done) => finishConversion(asBody(done)),
          (waiting) => {
            setPeriph32(asBody(waiting), REMAINING, left);
          },
        );
      });
    },
    interrupts: [
      {
        id: 'adc',
        vector: IRQ_VECTORS.adc,
        query: 5,
        priority: { register: 'IP', bit: 5 },
        enabled: (b) => b.equal(types.number, readSfrBit(b, SFR_IE, 5), number(b, 1)),
        pending: (b) => b.equal(types.number, readSfrBit(b, SFR_ADC_CONTR, 4), number(b, 1)),
        acknowledge: (b) => {
          writeSfr(
            b,
            SFR_ADC_CONTR,
            b.bitAnd(readSfr(b, SFR_ADC_CONTR), number(b, 0xff & ~ADC_FLAG)),
          );
        },
      },
    ],
  };
}
