import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  IRQ_DIRTY,
  RTC,
  RTC_BASE,
  SERVICE_IRQ,
  PeripheralSlot,
} from './layout';
import {
  asBody,
  bool,
  boolAnd,
  boolBitAt,
  boolOr,
  markService,
  num,
  readWord,
  u32,
  writeWord,
} from './ir';
import type { Body } from './ir';
import {
  NO_DEADLINE_PS,
  setPeripheralActive,
  setPeripheralDeadline,
} from './peripheral';
import type { PeripheralModule } from './peripheral';
import { refreshTick } from './tick';

/**
 * STM32G431 RTC（虚拟仿真时间驱动，不读宿主机 wall clock）。
 *
 * 支持 BCD 日历、24/12 小时制、PRER 预分频、SSR 亚秒、初始化/写保护序列、
 * Alarm A/B（秒/分/时/日期或星期掩码）、Wakeup timer（WUCKSEL 的 RTC/16…/ck_spre）、
 * SR/MISR/SCR 与 RTC_WKUP(IRQ3)、RTC_Alarm(IRQ41) 挂起条件。
 *
 * 二进制日历和内部标志位于 `rtc` memory 的 0x80 起隐藏区；固件可见寄存器位于
 * 0x00–0x5C。日历只在 INIT=0 且已经完成一次初始化后推进；未使用的 RTC 不占用
 * tick。该模型不模拟 LSE 起振、备份域掉电、TAMP 引脚和亚秒闹钟掩码。
 *
 * reset-owner 合同：`rtc` memory 属于备份域，NRST/SYSRESETREQ 保留；
 * 只有显式 BDRST 才清。当前 `reset.ts` 已按此保留 RTC。
 */

const TR = 0x00;
const DR = 0x04;
const SSR = 0x08;
const ICSR = 0x0c;
const PRER = 0x10;
const WUTR = 0x14;
const CR = 0x18;
const WPR = 0x24;
const CALR = 0x28;
const SHIFTR = 0x2c;
const ALRMAR = 0x40;
const ALRMASSR = 0x44;
const ALRMBR = 0x48;
const ALRMBSSR = 0x4c;
const SR = 0x50;
const MISR = 0x54;
const SCR = 0x5c;

const HIDDEN = 0x80;
const KEY = 0x80;
const INIT = 0x84;
const ENABLED = 0x88;
const YEAR = 0x8c;
const MONTH = 0x90;
const DAY = 0x94;
const WEEKDAY = 0x98;
const HOUR = 0x9c;
const MINUTE = 0xa0;
const SECOND = 0xa4;
const SUB = 0xa8;
const ELAPSED_NS = 0xac;
const WAKE_REMAIN = 0xb0;
const INITIALIZED = 0xb4;

const KEY_FIRST = 0xca;
const KEY_SECOND = 0x53;
const RTC_TICK_PS = 1_000_000_000;
const LSI_HZ = 32_768;

const SR_ALRAF = 0x01;
const SR_ALRBF = 0x02;
const SR_WUTF = 0x04;
const SR_TSF = 0x08;
const SR_TSOVF = 0x10;
const SR_ITSF = 0x20;

const read = (b: Body, offset: number): Value<number> => readWord(b, RTC, num(b, offset));
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWord(b, RTC, num(b, offset), value);
};
const storeAt = (b: Body, offset: Value<number>, value: Value<number>): void => {
  writeWord(b, RTC, offset, value);
};

function extract(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
}

function merge(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return u32(b, value);
  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}

const bcd = (b: Body, value: Value<number>): Value<number> =>
  b.add(
    b.multiply(b.shiftRightUnsigned(value, num(b, 4)), num(b, 10)),
    b.bitAnd(value, num(b, 0xf)),
  );

const fromBcd = (b: Body, value: Value<number>): Value<number> =>
  b.bitOr(
    b.shiftLeft(b.floor(b.divide(value, num(b, 10))), num(b, 4)),
    b.remainder(value, num(b, 10)),
  );

function ensureInit(b: Body): void {
  b.if(b.equal(types.number, read(b, INITIALIZED), num(b, 0)), (first) => {
    const body = asBody(first);

    store(body, PRER, num(body, 0x007f7fff));
    store(body, MONTH, num(body, 1));
    store(body, DAY, num(body, 1));
    store(body, WEEKDAY, num(body, 1));
    store(body, INITIALIZED, num(body, 1));
  });
}

function daysInMonth(b: Body, month: Value<number>, year: Value<number>): Value<number> {
  const result = b.local(types.number, 31);
  const leapYear = b.equal(
    types.number,
    b.remainder(year, num(b, 4)),
    num(b, 0),
  );

  b.if(b.equal(types.number, month, num(b, 2)), (feb) => {
    const body = asBody(feb);

    body.setLocal(
      result,
      body.select(
        types.number,
        leapYear,
        (inner) => inner.constant(types.number, 29),
        (inner) => inner.constant(types.number, 28),
      ),
    );
  });
  for (const short of [4, 6, 9, 11])
    b.if(b.equal(types.number, month, num(b, short)), (shortMonth) => {
      asBody(shortMonth).setLocal(result, num(asBody(shortMonth), 30));
    });

  return b.getLocal(result);
}

function decodeTr(b: Body, value: Value<number>): {
  readonly hour: Value<number>;
  readonly minute: Value<number>;
  readonly second: Value<number>;
} {
  const ht = b.bitAnd(b.shiftRightUnsigned(value, num(b, 20)), num(b, 3));
  const hu = b.bitAnd(b.shiftRightUnsigned(value, num(b, 16)), num(b, 0xf));
  const mnt = b.bitAnd(b.shiftRightUnsigned(value, num(b, 12)), num(b, 7));
  const mnu = b.bitAnd(b.shiftRightUnsigned(value, num(b, 8)), num(b, 0xf));
  const st = b.bitAnd(b.shiftRightUnsigned(value, num(b, 4)), num(b, 7));
  const su = b.bitAnd(value, num(b, 0xf));
  const rawHour = b.add(b.multiply(ht, num(b, 10)), hu);
  const format12 = boolBitAt(b, read(b, CR), 6);
  const pm = boolBitAt(b, value, 22);
  const hour24 = b.select(
    types.number,
    format12,
    (inner) =>
      inner.select(
        types.number,
        boolAnd(asBody(inner), pm, inner.lessThan(rawHour, inner.constant(types.number, 12))),
        (inner2) => inner2.add(rawHour, inner2.constant(types.number, 12)),
        (inner2) =>
          inner2.select(
            types.number,
            boolAnd(asBody(inner2), inner2.not(pm), inner2.equal(types.number, rawHour, inner2.constant(types.number, 12))),
            (inner3) => inner3.constant(types.number, 0),
            () => rawHour,
          ),
      ),
    () => rawHour,
  );

  return {
    hour: hour24,
    minute: b.add(b.multiply(mnt, num(b, 10)), mnu),
    second: b.add(b.multiply(st, num(b, 10)), su),
  };
}

function decodeDr(b: Body, value: Value<number>): {
  readonly year: Value<number>;
  readonly month: Value<number>;
  readonly day: Value<number>;
  readonly weekday: Value<number>;
} {
  const yt = b.bitAnd(b.shiftRightUnsigned(value, num(b, 20)), num(b, 0xf));
  const yu = b.bitAnd(b.shiftRightUnsigned(value, num(b, 16)), num(b, 0xf));
  const wdu = b.bitAnd(b.shiftRightUnsigned(value, num(b, 13)), num(b, 7));
  const mt = b.bitAnd(b.shiftRightUnsigned(value, num(b, 12)), num(b, 1));
  const mu = b.bitAnd(b.shiftRightUnsigned(value, num(b, 8)), num(b, 0xf));
  const dt = b.bitAnd(b.shiftRightUnsigned(value, num(b, 4)), num(b, 3));
  const du = b.bitAnd(value, num(b, 0xf));

  return {
    year: b.add(b.multiply(yt, num(b, 10)), yu),
    month: b.add(b.multiply(mt, num(b, 10)), mu),
    day: b.add(b.multiply(dt, num(b, 10)), du),
    weekday: wdu,
  };
}

function encodeTr(b: Body): Value<number> {
  const hour = read(b, HOUR);
  const format12 = boolBitAt(b, read(b, CR), 6);
  const pm = b.greaterThanOrEqual(hour, num(b, 12));
  const hour12 = b.select(
    types.number,
    b.equal(types.number, b.remainder(hour, num(b, 12)), num(b, 0)),
    (inner) => inner.constant(types.number, 12),
    (inner) => inner.remainder(hour, inner.constant(types.number, 12)),
  );
  const display = b.select(types.number, format12, () => hour12, () => hour);
  const tens = b.floor(b.divide(display, num(b, 10)));
  const units = b.remainder(display, num(b, 10));
  const minute = read(b, MINUTE);
  const second = read(b, SECOND);
  const value = b.bitOr(
    b.bitOr(
      b.shiftLeft(tens, num(b, 20)),
      b.shiftLeft(units, num(b, 16)),
    ),
    b.bitOr(
      b.bitOr(
        b.shiftLeft(b.floor(b.divide(minute, num(b, 10))), num(b, 12)),
        b.shiftLeft(b.remainder(minute, num(b, 10)), num(b, 8)),
      ),
      b.bitOr(
        b.shiftLeft(b.floor(b.divide(second, num(b, 10))), num(b, 4)),
        b.remainder(second, num(b, 10)),
      ),
    ),
  );

  return b.select(
    types.number,
    format12,
    (inner) =>
      inner.select(
        types.number,
        pm,
        (inner2) => inner2.bitOr(value, inner2.constant(types.number, 1 << 22)),
        () => value,
      ),
    () => value,
  );
}

function encodeDr(b: Body): Value<number> {
  const year = read(b, YEAR);
  const month = read(b, MONTH);
  const day = read(b, DAY);
  const weekday = read(b, WEEKDAY);

  return b.bitOr(
    b.bitOr(
      b.bitOr(
        b.shiftLeft(b.floor(b.divide(year, num(b, 10))), num(b, 20)),
        b.shiftLeft(b.remainder(year, num(b, 10)), num(b, 16)),
      ),
      b.shiftLeft(weekday, num(b, 13)),
    ),
    b.bitOr(
      b.bitOr(
        b.shiftLeft(b.floor(b.divide(month, num(b, 10))), num(b, 12)),
        b.shiftLeft(b.remainder(month, num(b, 10)), num(b, 8)),
      ),
      b.bitOr(
        b.shiftLeft(b.floor(b.divide(day, num(b, 10))), num(b, 4)),
        b.remainder(day, num(b, 10)),
      ),
    ),
  );
}

function updateShadow(b: Body): void {
  store(b, TR, encodeTr(b));
  store(b, DR, encodeDr(b));
}

function setSr(b: Body, mask: number): void {
  store(b, SR, b.bitOr(read(b, SR), num(b, mask)));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

function updateActivity(b: Body): void {
  const enabled = read(b, ENABLED);
  const init = read(b, INIT);
  const active = boolAnd(
    b,
    b.notEqual(types.number, enabled, num(b, 0)),
    b.equal(types.number, init, num(b, 0)),
  );

  b.if(active, (on) => {
    const body = asBody(on);

    setPeripheralActive(body, PeripheralSlot.Rtc, true);
    setPeripheralDeadline(body, PeripheralSlot.Rtc, num(body, RTC_TICK_PS));
    refreshTick(body);
  });
  b.if(b.not(active), (off) => {
    const body = asBody(off);

    setPeripheralActive(body, PeripheralSlot.Rtc, false);
    setPeripheralDeadline(body, PeripheralSlot.Rtc, num(body, NO_DEADLINE_PS));
    refreshTick(body);
  });
}

function reloadWake(b: Body): void {
  const wutr = b.bitAnd(read(b, WUTR), num(b, 0xffff));
  const selector = b.bitAnd(read(b, CR), num(b, 7));
  const prescaled = b.select(
    types.number,
    b.equal(types.number, selector, num(b, 0)),
    (inner) => inner.multiply(wutr, inner.constant(types.number, 16)),
    (inner) =>
      inner.select(
        types.number,
        inner.equal(types.number, selector, inner.constant(types.number, 1)),
        (inner2) => inner2.multiply(wutr, inner2.constant(types.number, 8)),
        (inner2) =>
          inner2.select(
            types.number,
            inner2.equal(types.number, selector, inner2.constant(types.number, 2)),
            (inner3) => inner3.multiply(wutr, inner3.constant(types.number, 4)),
            (inner3) => inner3.multiply(wutr, inner3.constant(types.number, 2)),
          ),
      ),
  );
  const secondary = b.select(
    types.number,
    boolOr(
      b,
      b.equal(types.number, selector, num(b, 4)),
      b.equal(types.number, selector, num(b, 6)),
    ),
    (inner) =>
      inner.multiply(
        inner.select(
          types.number,
          inner.equal(types.number, selector, inner.constant(types.number, 6)),
          (inner2) => inner2.add(wutr, inner2.constant(types.number, 65536)),
          () => wutr,
        ),
        inner.constant(types.number, 1000),
      ),
    (inner) => inner.floor(inner.divide(inner.multiply(prescaled, inner.constant(types.number, 1000)), inner.constant(types.number, LSI_HZ))),
  );

  store(b, WAKE_REMAIN, b.max(secondary, num(b, 1)));
}

function alarmMatch(b: Body, register: number): Value<boolean> {
  const alarm = read(b, register);
  const match = b.local(types.bool, true);
  const mask1 = boolBitAt(b, alarm, 7);
  const mask2 = boolBitAt(b, alarm, 15);
  const mask3 = boolBitAt(b, alarm, 23);
  const mask4 = boolBitAt(b, alarm, 31);
  const seconds = b.add(
    b.multiply(b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 4)), num(b, 7)), num(b, 10)),
    b.bitAnd(alarm, num(b, 0xf)),
  );
  const minutes = b.add(
    b.multiply(b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 12)), num(b, 7)), num(b, 10)),
    b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 8)), num(b, 0xf)),
  );
  const rawHour = b.add(
    b.multiply(b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 20)), num(b, 3)), num(b, 10)),
    b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 16)), num(b, 0xf)),
  );
  const pm = boolBitAt(b, alarm, 22);
  const format12 = boolBitAt(b, read(b, CR), 6);
  const hour = b.select(
    types.number,
    format12,
    (inner) =>
      inner.select(
        types.number,
        boolAnd(asBody(inner), pm, inner.lessThan(rawHour, inner.constant(types.number, 12))),
        (inner2) => inner2.add(rawHour, inner2.constant(types.number, 12)),
        (inner2) =>
          inner2.select(
            types.number,
            boolAnd(asBody(inner2), inner2.not(pm), inner2.equal(types.number, rawHour, inner2.constant(types.number, 12))),
            (inner3) => inner3.constant(types.number, 0),
            () => rawHour,
          ),
      ),
    () => rawHour,
  );
  const day = b.add(
    b.multiply(b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 28)), num(b, 3)), num(b, 10)),
    b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 24)), num(b, 0xf)),
  );
  const weekdayAlarm = b.bitAnd(b.shiftRightUnsigned(alarm, num(b, 24)), num(b, 7));

  b.if(mask1, () => {}, (check) => {
    const body = asBody(check);

    body.setLocal(
      match,
      body.equal(types.number, seconds, read(body, SECOND)),
    );
  });
  b.if(mask2, () => {}, (check) => {
    const body = asBody(check);

    body.if(body.getLocal(match), (inner) => {
      const body2 = asBody(inner);

      body2.setLocal(match, body2.equal(types.number, minutes, read(body2, MINUTE)));
    });
  });
  b.if(mask3, () => {}, (check) => {
    const body = asBody(check);

    body.if(body.getLocal(match), (inner) => {
      const body2 = asBody(inner);

      body2.setLocal(match, body2.equal(types.number, hour, read(body2, HOUR)));
    });
  });
  b.if(mask4, () => {}, (check) => {
    const body = asBody(check);
    const useWeekday = boolBitAt(body, alarm, 30);

    body.if(body.getLocal(match), (inner) => {
      const body2 = asBody(inner);

      body2.setLocal(
        match,
        body2.select(
          types.bool,
          useWeekday,
          (inner2) => inner2.equal(types.number, weekdayAlarm, readWord(asBody(inner2), RTC, num(asBody(inner2), WEEKDAY))),
          (inner2) => inner2.equal(types.number, day, readWord(asBody(inner2), RTC, num(asBody(inner2), DAY))),
        ),
      );
    });
  });

  return b.getLocal(match);
}

function checkAlarms(b: Body): void {
  b.if(alarmMatch(b, ALRMAR), (match) => setSr(asBody(match), SR_ALRAF));
  b.if(alarmMatch(b, ALRMBR), (match) => setSr(asBody(match), SR_ALRBF));
}

function incrementSecond(b: Body): void {
  const second = b.add(read(b, SECOND), num(b, 1));

  b.if(b.lessThan(second, num(b, 60)), (simple) => {
    store(asBody(simple), SECOND, second);
  }, (minute) => {
    const body = asBody(minute);

    store(body, SECOND, num(body, 0));
    const nextMinute = body.add(read(body, MINUTE), num(body, 1));

    body.if(body.lessThan(nextMinute, num(body, 60)), (minuteOnly) => {
      store(asBody(minuteOnly), MINUTE, nextMinute);
    }, (hour) => {
      const body2 = asBody(hour);

      store(body2, MINUTE, num(body2, 0));
      const nextHour = body2.add(read(body2, HOUR), num(body2, 1));

      body2.if(body2.lessThan(nextHour, num(body2, 24)), (hourOnly) => {
        store(asBody(hourOnly), HOUR, nextHour);
      }, (day) => {
        const body3 = asBody(day);

        store(body3, HOUR, num(body3, 0));
        const nextDay = body3.add(read(body3, DAY), num(body3, 1));
        const days = daysInMonth(body3, read(body3, MONTH), read(body3, YEAR));

        body3.if(body3.lessThanOrEqual(nextDay, days), (sameMonth) => {
          const body4 = asBody(sameMonth);

          store(body4, DAY, nextDay);
          store(
            body4,
            WEEKDAY,
            body4.select(
              types.number,
              body4.greaterThanOrEqual(read(body4, WEEKDAY), num(body4, 7)),
              (inner) => inner.constant(types.number, 1),
              (inner) => inner.add(readWord(asBody(inner), RTC, num(asBody(inner), WEEKDAY)), inner.constant(types.number, 1)),
            ),
          );
        }, (nextMonth) => {
          const body4 = asBody(nextMonth);
          const month = body4.add(read(body4, MONTH), num(body4, 1));

          store(body4, DAY, num(body4, 1));
          store(
            body4,
            WEEKDAY,
            body4.select(
              types.number,
              body4.greaterThanOrEqual(read(body4, WEEKDAY), num(body4, 7)),
              (inner) => inner.constant(types.number, 1),
              (inner) => inner.add(readWord(asBody(inner), RTC, num(asBody(inner), WEEKDAY)), inner.constant(types.number, 1)),
            ),
          );
          body4.if(body4.lessThanOrEqual(month, num(body4, 12)), (within) => {
            store(asBody(within), MONTH, month);
          }, (wrap) => {
            const body5 = asBody(wrap);
            const year = body5.add(read(body5, YEAR), num(body5, 1));

            store(body5, MONTH, num(body5, 1));
            store(
              body5,
              YEAR,
              body5.select(
                types.number,
                body5.greaterThan(year, num(body5, 99)),
                (inner) => inner.constant(types.number, 0),
                () => year,
              ),
            );
          });
        });
      });
    });
  });
  checkAlarms(b);
}

function advanceCalendar(b: Body, seconds: Value<number>): void {
  const remaining = b.local(types.number, seconds);

  b.loop((loop) => {
    const body = asBody(loop);

    body.if(
      body.lessThanOrEqual(body.getLocal(remaining), num(body, 0)),
      (done) => done.break(),
      (run) => {
        const next = asBody(run);

        incrementSecond(next);
        next.setLocal(
          remaining,
          next.subtract(next.getLocal(remaining), next.constant(types.number, 1)),
        );
      },
    );
  });
}

export function readRtc(b: Body, offset: Value<number>, size: number): Value<number> {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, SSR)),
    (ssr) => {
      const body = asBody(ssr);
      const predivS = body.bitAnd(read(body, PRER), num(body, 0x7fff));
      const predivA = body.bitAnd(
        body.shiftRightUnsigned(read(body, PRER), num(body, 16)),
        num(body, 0x7f),
      );
      const syncTicks = body.floor(
        body.divide(read(body, SUB), body.add(predivA, num(body, 1))),
      );
      const sub = body.remainder(syncTicks, body.add(predivS, num(body, 1)));

      body.setLocal(result, body.subtract(predivS, sub));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, ICSR)),
        (icsr) => {
          const body2 = asBody(icsr);
          const init = boolBitAt(body2, read(body2, INIT), 0);
          const bits = body2.bitOr(
            body2.constant(types.number, 0x20 | 0x04 | 0x02 | 0x01),
            body2.select(
              types.number,
              init,
              (inner) => inner.constant(types.number, 0x80 | 0x40 | 0x10),
              (inner) => inner.constant(types.number, 0),
            ),
          );

          body2.setLocal(result, bits);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, SR)),
            (sr) => {
              const body2 = asBody(sr);

              body2.setLocal(result, body2.bitAnd(read(body2, SR), num(body2, 0x3f)));
            },
            (rest) => {
              const body2 = asBody(rest);

              body2.if(
                body2.equal(types.number, wordOffset, num(body2, MISR)),
                (misr) => {
                  const body3 = asBody(misr);
                  const cr = read(body3, CR);
                  const enabled =
                    body3.bitOr(
                      body3.bitOr(
                        body3.select(
                          types.number,
                          body3.notEqual(types.number, body3.bitAnd(cr, num(body3, 0x1000)), num(body3, 0)),
                          (inner) => inner.constant(types.number, SR_ALRAF),
                          (inner) => inner.constant(types.number, 0),
                        ),
                        body3.select(
                          types.number,
                          body3.notEqual(types.number, body3.bitAnd(cr, num(body3, 0x2000)), num(body3, 0)),
                          (inner) => inner.constant(types.number, SR_ALRBF),
                          (inner) => inner.constant(types.number, 0),
                        ),
                      ),
                      body3.select(
                        types.number,
                        body3.notEqual(types.number, body3.bitAnd(cr, num(body3, 0x4000)), num(body3, 0)),
                        (inner) => inner.constant(types.number, SR_WUTF),
                        (inner) => inner.constant(types.number, 0),
                      ),
                    );

                  body3.setLocal(result, body3.bitAnd(read(body3, SR), enabled));
                },
                (tail) => {
                  const body3 = asBody(tail);

                  body3.if(
                    boolOr(
                      body3,
                      body3.lessThan(wordOffset, num(body3, SR)),
                      body3.equal(types.number, wordOffset, num(body3, SCR)),
                    ),
                    (stored) => {
                      const body4 = asBody(stored);

                      body4.setLocal(result, readWord(body4, RTC, wordOffset));
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeRtc(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));

  b.if(
    b.equal(types.number, wordOffset, num(b, WPR)),
    (wpr) => {
      const body = asBody(wpr);
      const key = body.bitAnd(u32(body, value), num(body, 0xff));
      const current = read(body, KEY);

      store(
        body,
        KEY,
        body.select(
          types.number,
          body.equal(types.number, key, num(body, KEY_FIRST)),
          (inner) => inner.constant(types.number, 1),
          (inner) =>
            inner.select(
              types.number,
              boolAnd(asBody(inner), inner.equal(types.number, key, inner.constant(types.number, KEY_SECOND)), inner.equal(types.number, current, inner.constant(types.number, 1))),
              (inner2) => inner2.constant(types.number, 2),
              (inner2) => inner2.constant(types.number, 0),
            ),
        ),
      );
    },
    (other) => {
      const body = asBody(other);
      const unlocked = body.equal(types.number, read(body, KEY), num(body, 2));

      body.if(unlocked, (allowed) => {
        const scope = asBody(allowed);

        scope.if(
          scope.equal(types.number, wordOffset, num(scope, ICSR)),
          (icsr) => {
            const body2 = asBody(icsr);
            const merged = merge(body2, read(body2, ICSR), value, offset, size);
            const init = boolBitAt(body2, merged, 7);
            const wasInit = boolBitAt(body2, read(body2, INIT), 0);

            store(
              body2,
              INIT,
              body2.select(
                types.number,
                init,
                (inner) => inner.constant(types.number, 1),
                (inner) => inner.constant(types.number, 0),
              ),
            );
            body2.if(boolAnd(body2, wasInit, body2.not(init)), (done) => {
              const inner = asBody(done);

              store(inner, ENABLED, num(inner, 1));
              updateShadow(inner);
              updateActivity(inner);
            });
            body2.if(init, (running) => updateActivity(asBody(running)));
          },
          (next) => {
            const scope2 = asBody(next);

            scope2.if(
              boolOr(
                scope2,
                boolOr(
                  scope2,
                  scope2.equal(types.number, wordOffset, num(scope2, TR)),
                  scope2.equal(types.number, wordOffset, num(scope2, DR)),
                ),
                scope2.equal(types.number, wordOffset, num(scope2, PRER)),
              ),
              (time) => {
                const body2 = asBody(time);
                const inInit = boolBitAt(body2, read(body2, INIT), 0);

                body2.if(inInit, (initMode) => {
                  const body3 = asBody(initMode);

                  body3.if(body3.equal(types.number, wordOffset, num(body3, TR)), (tr) => {
                    const body4 = asBody(tr);
                    const decoded = decodeTr(body4, merge(body4, read(body4, TR), value, offset, size));

                    store(body4, HOUR, body4.min(decoded.hour, num(body4, 23)));
                    store(body4, MINUTE, body4.min(decoded.minute, num(body4, 59)));
                    store(body4, SECOND, body4.min(decoded.second, num(body4, 59)));
                    updateShadow(body4);
                  });
                  body3.if(body3.equal(types.number, wordOffset, num(body3, DR)), (dr) => {
                    const body4 = asBody(dr);
                    const decoded = decodeDr(body4, merge(body4, read(body4, DR), value, offset, size));

                    store(body4, YEAR, body4.min(decoded.year, num(body4, 99)));
                    store(body4, MONTH, body4.max(body4.min(decoded.month, num(body4, 12)), num(body4, 1)));
                    store(body4, DAY, body4.max(body4.min(decoded.day, num(body4, 31)), num(body4, 1)));
                    store(body4, WEEKDAY, body4.max(body4.min(decoded.weekday, num(body4, 7)), num(body4, 1)));
                    updateShadow(body4);
                  });
                  body3.if(body3.equal(types.number, wordOffset, num(body3, PRER)), (prer) => {
                    const body4 = asBody(prer);
                    const merged = body4.bitAnd(
                      merge(body4, read(body4, PRER), value, offset, size),
                      num(body4, 0x007f7fff),
                    );

                    store(body4, PRER, merged);
                    store(body4, SUB, num(body4, 0));
                  });
                });
              },
              (config) => {
                const scope2 = asBody(config);

                scope2.if(
                  scope2.equal(types.number, wordOffset, num(scope2, WUTR)),
                  (wutr) => {
                    const body2 = asBody(wutr);

                    store(body2, WUTR, body2.bitAnd(merge(body2, read(body2, WUTR), value, offset, size), num(body2, 0xffff)));
                    body2.if(boolBitAt(body2, read(body2, CR), 10), (on) => reloadWake(asBody(on)));
                  },
                );
                scope2.if(scope2.equal(types.number, wordOffset, num(scope2, CR)), (cr) => {
                  const body2 = asBody(cr);
                  const merged = merge(body2, read(body2, CR), value, offset, size);
                  const wasOn = boolBitAt(body2, read(body2, CR), 10);
                  const nowOn = boolBitAt(body2, merged, 10);

                  store(body2, CR, merged);
                  body2.if(boolAnd(body2, body2.not(wasOn), nowOn), (on) => reloadWake(asBody(on)));
                  body2.writeState(IRQ_DIRTY, bool(body2, true));
                  markService(body2, SERVICE_IRQ);
                });
                scope2.if(
                  boolOr(
                    scope2,
                    scope2.equal(types.number, wordOffset, num(scope2, ALRMAR)),
                    scope2.equal(types.number, wordOffset, num(scope2, ALRMBR)),
                  ),
                  (alarm) => {
                    const body2 = asBody(alarm);

                    storeAt(body2, wordOffset, merge(body2, readWord(body2, RTC, wordOffset), value, offset, size));
                  },
                );
                scope2.if(scope2.equal(types.number, wordOffset, num(scope2, SCR)), (scr) => {
                  const body2 = asBody(scr);
                  const clears = body2.bitAnd(u32(body2, value), num(body2, 0x3f));

                  store(body2, SR, body2.bitAnd(read(body2, SR), body2.bitNot(clears)));
                });
                scope2.if(
                  boolOr(
                    scope2,
                    scope2.equal(types.number, wordOffset, num(scope2, CALR)),
                    scope2.equal(types.number, wordOffset, num(scope2, SHIFTR)),
                  ),
                  (misc) => {
                    const body2 = asBody(misc);

                    storeAt(body2, wordOffset, merge(body2, readWord(body2, RTC, wordOffset), value, offset, size));
                  },
                );
              },
            );
          },
        );
      });
    },
  );
}

export function advanceRtc(b: Body, elapsedPs: Value<number>): void {
  ensureInit(b);
  const enabled = read(b, ENABLED);
  const init = read(b, INIT);
  const active = boolAnd(
    b,
    b.notEqual(types.number, enabled, num(b, 0)),
    b.equal(types.number, init, num(b, 0)),
  );

  b.if(active, (on) => {
    const body = asBody(on);
    const predivA = body.bitAnd(body.shiftRightUnsigned(read(body, PRER), num(body, 16)), num(body, 0x7f));
    const predivS = body.bitAnd(read(body, PRER), num(body, 0x7fff));
    const cycles = body.multiply(
      body.add(predivA, num(body, 1)),
      body.add(predivS, num(body, 1)),
    );
    const elapsedNs = body.add(
      read(body, ELAPSED_NS),
      body.floor(body.divide(elapsedPs, num(body, 1000))),
    );
    const ticks = body.floor(body.divide(body.multiply(elapsedNs, num(body, LSI_HZ)), num(body, 1_000_000_000)));
    const usedNs = body.floor(body.divide(body.multiply(ticks, num(body, 1_000_000_000)), num(body, LSI_HZ)));
    const sub = body.add(read(body, SUB), ticks);
    const seconds = body.floor(body.divide(sub, cycles));

    store(body, ELAPSED_NS, body.subtract(elapsedNs, usedNs));
    store(body, SUB, body.remainder(sub, cycles));
    advanceCalendar(body, seconds);

    const elapsedMs = body.floor(body.divide(elapsedPs, num(body, 1_000_000)));
    const wutr = body.bitAnd(read(body, WUTR), num(body, 0xffff));
    const remain = body.subtract(
      body.max(read(body, WAKE_REMAIN), num(body, 1)),
      elapsedMs,
    );
    const wakeOn = boolBitAt(body, read(body, CR), 10);

    body.if(wakeOn, (wake) => {
      const body2 = asBody(wake);

      body2.if(body2.lessThanOrEqual(remain, num(body2, 0)), (expired) => {
        const inner = asBody(expired);

        setSr(inner, SR_WUTF);
        reloadWake(inner);
      }, (waiting) => {
        store(asBody(waiting), WAKE_REMAIN, remain);
      });
    });
    updateShadow(body);
    updateActivity(body);
  });
  b.if(b.not(active), (off) => updateActivity(asBody(off)));

}

export function rtcWakePending(b: Body): Value<boolean> {
  return boolAnd(b, boolBitAt(b, read(b, SR), 2), boolBitAt(b, read(b, CR), 14));
}

export function rtcAlarmPending(b: Body): Value<boolean> {
  return boolOr(
    b,
    boolAnd(b, boolBitAt(b, read(b, SR), 0), boolBitAt(b, read(b, CR), 12)),
    boolAnd(b, boolBitAt(b, read(b, SR), 1), boolBitAt(b, read(b, CR), 13)),
  );
}

export function readRtcAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  return readRtc(b, b.subtract(address, num(b, RTC_BASE)), size);
}

export function writeRtcAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRtc(b, b.subtract(address, num(b, RTC_BASE)), size, value);
}

export const rtcModule: PeripheralModule = {
  id: 'rtc',
  ranges: [{ base: RTC_BASE, size: 0x100 }],
  read: readRtcAddress,
  write: writeRtcAddress,
  slot: PeripheralSlot.Rtc,
  advance: advanceRtc,
  interrupts: [
    {
      exception: 3 + 16,
      pendingIsPure: true,
      pending: rtcWakePending,
      acknowledge: () => {},
    },
    {
      exception: 41 + 16,
      pendingIsPure: true,
      pending: rtcAlarmPending,
      acknowledge: () => {},
    },
  ],
};

export const RTC_STATES: readonly {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}[] = [];
