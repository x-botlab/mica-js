import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  SFR,
  SFR_AUXR,
  SFR_P0,
  SFR_P1,
  SFR_P2,
  SFR_P3,
  SFR_SP,
  SFR_TCON,
  latchBitIsSet,
  number,
  periph32,
  readSfr,
  setPeriph32,
  setSfrBit,
  sfrBitIsSet,
  writeSfr,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { WDT_BASE } from './layout';
import type { Peripheral } from './types';

/**
 * 看门狗（WDT_CONTR = 0xC1）。
 *
 * 溢出时间 = 12 × Pre-scale × 32768 / SYSclk。`CLR_WDT` 置 1 时重装计数并由硬件清零该位；
 * 溢出时置 WDT_FLAG，并把器件复位到 0000H：本模型没有全板复位接口，因此复位实现为
 * 「恢复 SFR 复位值（SP/PCON/AUXR/端口锁存/TCON）+ PC=0」。`periph` 里其它外设的中间
 * 状态不会清零，README 将其列为已知简化。
 */

const WDT_CONTR = 0xc1;

const WDT_FLAG = 0x80;
const EN_WDT = 0x20;
const CLR_WDT = 0x10;

/** 计数余量（系统时钟数）；0 表示尚未装载。 */
const REMAINING = WDT_BASE;

const PRESCALE = [2, 4, 8, 16, 32, 64, 128, 256] as const;
const COUNTS_PER_PRESCALE = 32_768;
/** WDT 的计数时钟是 SYSclk/12。 */
const WDT_DIVIDER = 12;

const reloadCycles = (b: Body): Value<number> => {
  const ps = b.bitAnd(readSfr(b, WDT_CONTR), number(b, 0x07));
  let value = number(b, (PRESCALE[0] as number) * WDT_DIVIDER * COUNTS_PER_PRESCALE);

  for (let index = 1; index < PRESCALE.length; index += 1)
    value = b.select(
      types.number,
      b.equal(types.number, ps, number(b, index)),
      (inner) =>
        inner.constant(
          types.number,
          (PRESCALE[index] as number) * WDT_DIVIDER * COUNTS_PER_PRESCALE,
        ),
      () => value,
    );

  return value;
};

/** 复位序列：SFR 复位值与 PC=0。 */
function resetDevice(b: Body): void {
  b.writeState('pc', number(b, 0));
  writeSfr(b, SFR_SP, number(b, 0x07));
  writeSfr(b, 0x87, number(b, 0x30));
  writeSfr(b, SFR_AUXR, number(b, 0x01));
  writeSfr(b, SFR_P0, number(b, 0xff));
  writeSfr(b, SFR_P1, number(b, 0xff));
  writeSfr(b, SFR_P2, number(b, 0xff));
  writeSfr(b, SFR_P3, number(b, 0xff));
  writeSfr(b, SFR_TCON, number(b, 0x00));
}

export function createWatchdog(): Peripheral {
  return {
    id: 'watchdog',
    writes: [WDT_CONTR],
    onWrite(b) {
      b.if(sfrBitIsSet(b, WDT_CONTR, 4), (cleared) => {
        // 硬件把 CLR_WDT 自动清零，并重装计数。
        cleared.store8(
          SFR,
          number(cleared, 0x41),
          cleared.bitAnd(
            readSfr(cleared, WDT_CONTR),
            cleared.constant(types.number, 0xff & ~CLR_WDT),
          ),
        );
        setPeriph32(cleared, REMAINING, reloadCycles(cleared));
      });
    },
    /** 看门狗只有使能后才有时间行为。 */
    active(b) {
      return latchBitIsSet(b, WDT_CONTR, 5);
    },
    advance(b, advance) {
      b.if(sfrBitIsSet(b, WDT_CONTR, 5), (running) => {
        const remaining = periph32(running, REMAINING);

        running.if(
          running.equal(types.number, remaining, number(running, 0)),
          (start) => setPeriph32(start, REMAINING, reloadCycles(start)),
          (counting) => {
            const next = counting.subtract(remaining, advance.cycles);

            counting.if(
              counting.lessThanOrEqual(next, number(counting, 0)),
              (overflow) => {
                setSfrBit(overflow, WDT_CONTR, 7, true);
                resetDevice(overflow);
                overflow.redirect(0, 0);
              },
              (keep) => setPeriph32(keep, REMAINING, next),
            );
          },
        );
      });
    },
  };
}

export const watchdogRemainingOffset = REMAINING;
export const watchdogFlagBit = WDT_FLAG;
export const watchdogEnableBit = EN_WDT;
