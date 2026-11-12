import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  SFR_IE,
  SFR_IP,
  SFR_PCON,
  asBody,
  latchBitIsSet,
  number,
  periph8,
  readSfrLatch,
  setPeriph8,
  sfrBitIsSet,
  writeSfr,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import { CLOCK_BASE } from './layout';
import type { Peripheral } from './types';

/**
 * 时钟、省电与低压检测。
 *
 * PCON 的 SMOD/SMOD0 由串口读取；POF/LVDF 是软件可写的标志。省电模式只保留寄存器位：
 * 本模型的时间只随指令推进，没有独立的外设时钟域，因此 PD/IDL 不停机。CLK_DIV 保存
 * 分频值但不改变指令耗时（时间基准由 `clockFrequency` 属性给出），两处都在 README 里
 * 列为已知简化。
 *
 * 低压检测按「VCC 引脚采样电压低于门槛」建模：进入低压时硬件置 LVDF，中断请求还要求
 * 当前电压仍低于门槛。这样复位后 `PCON=30H`（手册的 LVDF/POF 复位值）不会凭空产生
 * 一个永远挂起的中断。
 */

export const SFR_PCON_ADDRESS = 0x87;
export const SFR_CLK_DIV_ADDRESS = 0x97;
export const SFR_P_SW2_ADDRESS = 0xba;
export const SFR_P1ASF_ADDRESS = 0x9d;

/** PCON 位定义，供串口模块复用。 */
export const PCON_SMOD = 0x80;
export const PCON_SMOD0 = 0x40;
export const PCON_LVDF = 0x20;
export const PCON_POF = 0x10;
export const PCON_PD = 0x02;
export const PCON_IDL = 0x01;

/** STC15F2K60S2 是 5 V 器件：手册给出的低压检测最高档约 3.8 V。 */
const LVD_THRESHOLD = 3.8;

/** 上一次是否已经判定为低压（0/1）：只在进入低压时置标志。 */
const LOW_VOLTAGE = CLOCK_BASE;

const supplyVoltage = (b: Body): Value<number> => {
  const voltage = b.field(b.readSample('VCC'), 'voltage');

  return b.select(
    types.number,
    b.isNone(voltage),
    (inner) => inner.constant(types.number, 5),
    (inner) => inner.nonNull(voltage),
  );
};

const belowThreshold = (b: Body): Value<boolean> =>
  b.lessThan(supplyVoltage(b), number(b, LVD_THRESHOLD));

/** 低压检测是否值得采样：中断允许，或已判定为低压、需要等恢复。 */
const clockWatch = (b: Body): Value<boolean> =>
  b.or(latchBitIsSet(b, SFR_IE, 6), (inner) => {
    const s = asBody(inner);

    return s.notEqual(types.number, periph8(s, LOW_VOLTAGE), number(s, 0));
  });

export function createClockControl(): Peripheral {
  return {
    id: 'clock',
    writes: [SFR_PCON_ADDRESS, SFR_CLK_DIV_ADDRESS, SFR_P_SW2_ADDRESS, SFR_P1ASF_ADDRESS],
    /**
     * 低压检测只在中断允许（或已判定为低压、需要等恢复）时采样 VCC。
     *
     * 用内部的 LOW_VOLTAGE 而不是 PCON.LVDF：后者复位值就带 LVDF（手册 PCON=30H），
     * 拿它当条件会让空闲门控永远为真。
     */
    active(b) {
      return clockWatch(b);
    },
    advance(b) {
      // 只在可能关心的场景采样 VCC：低压中断允许，或已经判定为低压、需要等恢复。
      b.if(clockWatch(b), (watching) => {
        const body = asBody(watching);
        const low = belowThreshold(body);
        const wasLow = body.notEqual(types.number, periph8(body, LOW_VOLTAGE), number(body, 0));

        body.if(
          body.and(low, (inner) => inner.not(wasLow)),
          (entered) => {
            const hit = asBody(entered);

            setPeriph8(hit, LOW_VOLTAGE, 1);
            writeSfr(hit, SFR_PCON, hit.bitOr(readSfrLatch(hit, SFR_PCON), number(hit, PCON_LVDF)));
            markIrqDirty(hit);
          },
        );
        body.if(
          body.and(body.not(low), (inner) => inner.not(wasLow)),
          (recovered) => {
            setPeriph8(asBody(recovered), LOW_VOLTAGE, 0);
          },
        );
      });
    },
    interrupts: [
      {
        id: 'lvd',
        vector: IRQ_VECTORS.lvd,
        query: 6,
        priority: { register: 'IP', bit: 6 },
        enabled: (b) => sfrBitIsSet(b, SFR_IE, 6),
        pending: (b) =>
          b.and(sfrBitIsSet(b, SFR_PCON, 5), (inner) => belowThreshold(asBody(inner))),
        acknowledge: (b) => {
          writeSfr(b, SFR_PCON, b.bitAnd(readSfrLatch(b, SFR_PCON), number(b, 0xff & ~PCON_LVDF)));
          markIrqDirty(b);
        },
      },
    ],
  };
}

export const INTERRUPT_PRIORITY_ADDRESS = SFR_IP;
export const lvdThresholdVoltage = LVD_THRESHOLD;
export const powerControlAddress = SFR_PCON;
