import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  IRQ_DIRTY,
  IWDG_BASE,
  SERVICE_IRQ,
  WATCHDOG,
  WWDG_BASE,
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
import { readPclk1Hz } from './clock-tree';
import { RESET_CAUSE_IWDG, RESET_CAUSE_WWDG, requestReset } from './reset';
import { refreshTick } from './tick';
import {
  NO_DEADLINE_PS,
  setPeripheralActive,
  setPeripheralDeadline,
} from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431 的 IWDG/WWDG。
 *
 * IWDG：LSI 32 kHz，PR 选择 /4…/256，键值 0x5555 解锁、0xAAAA 喂狗、0xCCCC 启动；
 * 窗口值小于计数时提前喂狗触发复位。WWDG：PCLK/4096/2^WDGTB 递减，计数 0x40 置
 * EWIF（EWI 使能时报 IRQ 0），越过 0x3F 触发复位；刷新过早（T>窗口）也复位。
 *
 * 计数器/内部标志放在 `watchdog` memory 的隐藏区；超时写 `sys.RESET_REQUEST` 与
 * `sys.RESET_CAUSE`（IWDG=5、WWDG=6），由既有 reset sink
 * （resetPending → applyPendingReset）在异常边界执行复位。未启动时模块不占用 tick。
 */

const IWDG_KR = 0x00;
const IWDG_PR = 0x04;
const IWDG_RLR = 0x08;
const IWDG_SR = 0x0c;
const IWDG_WINR = 0x10;
const IWDG_RUNNING = 0x14;
const IWDG_REMAIN_US = 0x18;
const IWDG_ACCESS = 0x1c;
const WWDG_CR = 0x20;
const WWDG_CFR = 0x24;
const WWDG_SR = 0x28;
const WWDG_RUNNING = 0x2c;
const WWDG_ELAPSED_US = 0x30;
const WWDG_REMAINDER_PS = 0x3c;

const INITIALIZED = 0x34;

const IWDG_ACCESS_BIT = 0x1;
const IWDG_UPDATE_PR = 0x2;
const IWDG_UPDATE_RLR = 0x4;
const IWDG_UPDATE_WINR = 0x8;
const IWDG_LOW_MASK = 0x0f;
const IWDG_REMAINDER_SHIFT = 4;
const IWDG_REMAINDER_MASK = 0x3ff;
const IWDG_UPDATE_SHIFT = 14;
const IWDG_UPDATE_MASK = 0x3ffff;
const IWDG_UPDATE_SYNC_US = 156;

const KEY_UNLOCK = 0x5555;
const KEY_RELOAD = 0xaaaa;
const KEY_START = 0xcccc;

const LSI_HZ = 32_000;

const read = (b: Body, offset: number): Value<number> => readWord(b, WATCHDOG, num(b, offset));
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWord(b, WATCHDOG, num(b, offset), value);
};

const aligned = (b: Body, offset: Value<number>): Value<number> =>
  b.bitAnd(offset, num(b, 0xfffffffc));

const iwdgLow = (b: Body, access: Value<number>): Value<number> =>
  b.bitAnd(access, num(b, IWDG_LOW_MASK));
const iwdgRemainderNs = (b: Body, access: Value<number>): Value<number> =>
  b.bitAnd(
    b.shiftRightUnsigned(access, num(b, IWDG_REMAINDER_SHIFT)),
    num(b, IWDG_REMAINDER_MASK),
  );
const iwdgUpdateUs = (b: Body, access: Value<number>): Value<number> =>
  b.bitAnd(
    b.shiftRightUnsigned(access, num(b, IWDG_UPDATE_SHIFT)),
    num(b, IWDG_UPDATE_MASK),
  );
const packIwdgAccess = (
  b: Body,
  low: Value<number>,
  remainderNs: Value<number>,
  updateUs: Value<number>,
): Value<number> =>
  b.bitOr(
    b.bitOr(low, b.shiftLeft(remainderNs, num(b, IWDG_REMAINDER_SHIFT))),
    b.shiftLeft(updateUs, num(b, IWDG_UPDATE_SHIFT)),
  );

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

function ensureInit(b: Body): void {
  b.if(b.equal(types.number, read(b, INITIALIZED), num(b, 0)), (first) => {
    const body = asBody(first);

    store(body, IWDG_PR, num(body, 0));
    store(body, IWDG_RLR, num(body, 0xfff));
    store(body, IWDG_WINR, num(body, 0xfff));
    store(body, INITIALIZED, num(body, 1));
  });
}

function iwdgPeriodUs(b: Body): Value<number> {
  const pr = b.bitAnd(read(b, IWDG_PR), num(b, 7));
  const rlr = b.bitAnd(read(b, IWDG_RLR), num(b, 0xfff));
  const divider = b.select(
    types.number,
    b.greaterThanOrEqual(pr, num(b, 6)),
    (inner) => inner.constant(types.number, 256),
    (inner) => inner.shiftLeft(inner.constant(types.number, 4), pr),
  );

  return b.floor(
    b.divide(
      b.multiply(b.multiply(divider, b.add(rlr, num(b, 1))), num(b, 1_000_000)),
      num(b, LSI_HZ),
    ),
  );
}

function iwdgWindowUs(b: Body): Value<number> {
  const pr = b.bitAnd(read(b, IWDG_PR), num(b, 7));
  const winr = b.bitAnd(read(b, IWDG_WINR), num(b, 0xfff));
  const divider = b.select(
    types.number,
    b.greaterThanOrEqual(pr, num(b, 6)),
    (inner) => inner.constant(types.number, 256),
    (inner) => inner.shiftLeft(inner.constant(types.number, 4), pr),
  );

  return b.floor(
    b.divide(
      b.multiply(b.multiply(divider, winr), num(b, 1_000_000)),
      num(b, LSI_HZ),
    ),
  );
}

function setReset(b: Body, bit: number): void {
  // 0x1=IWDG、0x2=WWDG；两个 cause 独立，RCC_CSR 才能恢复对应 reset flag。
  requestReset(b, bit === 0x1 ? RESET_CAUSE_IWDG : RESET_CAUSE_WWDG);
}

function updateActivity(b: Body): void {
  const iwdg = b.notEqual(types.number, read(b, IWDG_RUNNING), num(b, 0));
  const wwdg = b.notEqual(types.number, read(b, WWDG_RUNNING), num(b, 0));
  const active = boolOr(b, iwdg, wwdg);

  b.if(active, (on) => {
    const body = asBody(on);
    const iwdgDeadline = body.max(
      body.multiply(read(body, IWDG_REMAIN_US), body.constant(types.number, 1_000_000)),
      body.constant(types.number, 1),
    );
    const tickUs = wwdgTickUs(body);
    const wwdgRemainingUs = body.subtract(
      tickUs,
      body.bitAnd(read(body, WWDG_ELAPSED_US), num(body, 0xffffffff)),
    );
    const wwdgDeadline = body.multiply(
      body.max(wwdgRemainingUs, body.constant(types.number, 1)),
      body.constant(types.number, 1_000_000),
    );
    const deadline = body.select(
      types.number,
      iwdg,
      (inner) =>
        inner.select(
          types.number,
          wwdg,
          (inner2) => inner2.min(iwdgDeadline, wwdgDeadline),
          () => iwdgDeadline,
        ),
      () => wwdgDeadline,
    );

    setPeripheralActive(body, PeripheralSlot.Watchdog, true);
    setPeripheralDeadline(body, PeripheralSlot.Watchdog, deadline);
    refreshTick(body);
  });
  b.if(b.not(active), (off) => {
    const body = asBody(off);

    setPeripheralActive(body, PeripheralSlot.Watchdog, false);
    setPeripheralDeadline(body, PeripheralSlot.Watchdog, num(body, NO_DEADLINE_PS));
    refreshTick(body);
  });
}

function wwdgTickUs(b: Body): Value<number> {
  const cfgr = read(b, WWDG_CFR);
  const base = b.bitAnd(b.shiftRightUnsigned(cfgr, num(b, 11)), num(b, 7));
  const divisor = b.shiftLeft(num(b, 4096), base);

  return b.max(
    num(b, 1),
    b.floor(b.divide(b.multiply(divisor, num(b, 1_000_000)), readPclk1Hz(b))),
  );
}

function reloadIwdg(b: Body): void {
  const period = iwdgPeriodUs(b);
  const window = iwdgWindowUs(b);
  const rlr = b.bitAnd(read(b, IWDG_RLR), num(b, 0xfff));
  const winr = b.bitAnd(read(b, IWDG_WINR), num(b, 0xfff));
  const windowEnabled = b.lessThan(winr, rlr);
  const violation = boolAnd(
    b,
    windowEnabled,
    b.greaterThan(read(b, IWDG_REMAIN_US), window),
  );

  b.if(violation, (bad) => {
    const body = asBody(bad);

    setReset(body, 0x1);
    store(body, IWDG_RUNNING, num(body, 0));
    store(body, IWDG_REMAIN_US, num(body, 0));
    updateActivity(body);
  }, (good) => {
    const body = asBody(good);

    store(body, IWDG_REMAIN_US, period);
    updateActivity(body);
  });
}

function writeIwdg(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = aligned(b, offset);

  b.if(
    b.equal(types.number, wordOffset, num(b, IWDG_KR)),
    (kr) => {
      const body = asBody(kr);
      const key = body.bitAnd(u32(body, value), num(body, 0xffff));
      const access = read(body, IWDG_ACCESS);

      body.if(body.equal(types.number, key, num(body, KEY_UNLOCK)), (unlock) => {
        store(asBody(unlock), IWDG_ACCESS, num(asBody(unlock), IWDG_ACCESS_BIT));
      });
      body.if(body.equal(types.number, key, num(body, KEY_RELOAD)), (reload) => {
        const scope = asBody(reload);

        scope.if(scope.notEqual(types.number, read(scope, IWDG_RUNNING), num(scope, 0)), (running) => {
          reloadIwdg(asBody(running));
        });
        store(
          scope,
          IWDG_ACCESS,
          packIwdgAccess(scope, num(scope, IWDG_ACCESS_BIT), num(scope, 0), num(scope, 0)),
        );
      });
      body.if(body.equal(types.number, key, num(body, KEY_START)), (start) => {
        const scope = asBody(start);
        const period = iwdgPeriodUs(scope);

        store(scope, IWDG_RUNNING, num(scope, 1));
        store(scope, IWDG_REMAIN_US, period);
        store(scope, IWDG_ACCESS, num(scope, IWDG_ACCESS_BIT));
        scope.if(scope.equal(types.number, period, num(scope, 0)), (expired) => {
          const inner = asBody(expired);

          setReset(inner, 0x1);
          store(inner, IWDG_RUNNING, num(inner, 0));
        });
        updateActivity(scope);
      });
      body.if(
        body.not(
          boolOr(
            body,
            boolOr(
              body,
              body.equal(types.number, key, num(body, KEY_UNLOCK)),
              body.equal(types.number, key, num(body, KEY_RELOAD)),
            ),
            body.equal(types.number, key, num(body, KEY_START)),
          ),
        ),
        (other) => {
          const scope = asBody(other);

          store(
            scope,
            IWDG_ACCESS,
            scope.bitAnd(access, num(scope, ~IWDG_ACCESS_BIT)),
          );
        },
      );
    },
    (other) => {
      const body = asBody(other);
      const access = read(body, IWDG_ACCESS);
      const unlocked = boolBitAt(body, access, 0);

      body.if(unlocked, (write) => {
        const scope = asBody(write);

        scope.if(scope.equal(types.number, wordOffset, num(scope, IWDG_PR)), (pr) => {
          const inner = asBody(pr);

          store(inner, IWDG_PR, inner.bitAnd(merge(inner, read(inner, IWDG_PR), value, offset, size), num(inner, 7)));
          store(
            inner,
            IWDG_ACCESS,
            packIwdgAccess(
              inner,
              inner.bitOr(iwdgLow(inner, read(inner, IWDG_ACCESS)), num(inner, IWDG_UPDATE_PR)),
              iwdgRemainderNs(inner, read(inner, IWDG_ACCESS)),
              num(inner, 0),
            ),
          );
        });
        scope.if(scope.equal(types.number, wordOffset, num(scope, IWDG_RLR)), (rlr) => {
          const inner = asBody(rlr);

          store(inner, IWDG_RLR, inner.bitAnd(merge(inner, read(inner, IWDG_RLR), value, offset, size), num(inner, 0xfff)));
          store(
            inner,
            IWDG_ACCESS,
            packIwdgAccess(
              inner,
              inner.bitOr(iwdgLow(inner, read(inner, IWDG_ACCESS)), num(inner, IWDG_UPDATE_RLR)),
              iwdgRemainderNs(inner, read(inner, IWDG_ACCESS)),
              num(inner, 0),
            ),
          );
        });
        scope.if(scope.equal(types.number, wordOffset, num(scope, IWDG_WINR)), (winr) => {
          const inner = asBody(winr);

          store(inner, IWDG_WINR, inner.bitAnd(merge(inner, read(inner, IWDG_WINR), value, offset, size), num(inner, 0xfff)));
          store(
            inner,
            IWDG_ACCESS,
            packIwdgAccess(
              inner,
              inner.bitOr(iwdgLow(inner, read(inner, IWDG_ACCESS)), num(inner, IWDG_UPDATE_WINR)),
              iwdgRemainderNs(inner, read(inner, IWDG_ACCESS)),
              num(inner, 0),
            ),
          );
        });
      });
    },
  );
}

function writeWwdg(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = aligned(b, offset);

  b.if(
    b.equal(types.number, wordOffset, num(b, WWDG_CR)),
    (cr) => {
      const body = asBody(cr);
      const old = read(body, WWDG_CR);
      const running = body.notEqual(types.number, read(body, WWDG_RUNNING), num(body, 0));
      const current = body.bitAnd(old, num(body, 0x7f));
      const merged = body.bitAnd(merge(body, old, value, offset, size), num(body, 0xff));
      const requested = body.bitAnd(merged, num(body, 0x7f));
      const activate = boolBitAt(body, merged, 7);
      const window = body.bitAnd(read(body, WWDG_CFR), num(body, 0x7f));

      body.if(running, (active) => {
        const scope = asBody(active);

        // 已启动后 WDGA 不能清 0 停狗。刷新窗口比较的是写之前的当前 counter。
        scope.if(scope.greaterThan(current, window), (tooEarly) => {
          const bad = asBody(tooEarly);

          setReset(bad, 0x2);
          store(bad, WWDG_RUNNING, num(bad, 0));
          updateActivity(bad);
        }, (inWindow) => {
          const ok = asBody(inWindow);

          ok.if(ok.lessThan(requested, num(ok, 0x40)), (underflow) => {
            const bad = asBody(underflow);

            setReset(bad, 0x2);
            store(bad, WWDG_RUNNING, num(bad, 0));
            updateActivity(bad);
          }, (refresh) => {
            const body2 = asBody(refresh);

            store(body2, WWDG_CR, body2.bitOr(requested, num(body2, 0x80)));
            store(body2, WWDG_RUNNING, num(body2, 1));
            store(body2, WWDG_ELAPSED_US, num(body2, 0));
            store(body2, WWDG_REMAINDER_PS, num(body2, 0));
            updateActivity(body2);
          });
        });
      });
      body.if(body.not(running), (stopped) => {
        const scope = asBody(stopped);

        scope.if(activate, (start) => {
          const body2 = asBody(start);

          body2.if(body2.lessThan(requested, num(body2, 0x40)), (underflow) => {
            const bad = asBody(underflow);

            setReset(bad, 0x2);
            store(bad, WWDG_RUNNING, num(bad, 0));
            updateActivity(bad);
          }, (valid) => {
            const body3 = asBody(valid);

            store(body3, WWDG_CR, body3.bitOr(requested, num(body3, 0x80)));
            store(body3, WWDG_RUNNING, num(body3, 1));
            store(body3, WWDG_ELAPSED_US, num(body3, 0));
            store(body3, WWDG_REMAINDER_PS, num(body3, 0));
            updateActivity(body3);
          });
        }, (idle) => {
          // 未启动时仅写 T；WDGA 仍为 0。
          store(asBody(idle), WWDG_CR, requested);
        });
      });
    },
    (other) => {
      const body = asBody(other);

      body.if(body.equal(types.number, wordOffset, num(body, WWDG_CFR)), (cfr) => {
        const scope = asBody(cfr);
        const merged = scope.bitAnd(
          merge(scope, read(scope, WWDG_CFR), value, offset, size),
          num(scope, 0x3a7f),
        );

        store(scope, WWDG_CFR, merged);
        updateActivity(scope);
      });
      body.if(body.equal(types.number, wordOffset, num(body, WWDG_SR)), (sr) => {
        const scope = asBody(sr);
        const current = read(scope, WWDG_SR);

        // EWIF 是 rc_w0：写 0 清零，写 1 保持。
        store(scope, WWDG_SR, scope.bitAnd(current, scope.bitAnd(u32(scope, value), num(scope, 1))));
      });
    },
  );
}

export function readWatchdog(
  b: Body,
  offset: Value<number>,
  size: number,
): Value<number> {
  ensureInit(b);
  const wordOffset = aligned(b, offset);
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, IWDG_SR)),
    (sr) => {
      const body = asBody(sr);
      const update = body.bitAnd(read(body, IWDG_ACCESS), num(body, 0x0e));

      body.setLocal(result, body.shiftRightUnsigned(update, num(body, 1)));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          body.equal(types.number, wordOffset, num(body, IWDG_KR)),
          body.equal(types.number, wordOffset, num(body, 0x14)),
        ),
        (kr) => kr.setLocal(result, num(asBody(kr), 0)),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.lessThan(wordOffset, num(scope, 0x14)),
            (iwdg) => {
              const body2 = asBody(iwdg);

              iwdg.setLocal(result, readWord(body2, WATCHDOG, wordOffset));
            },
            (wwdg) => {
              const body2 = asBody(wwdg);

              body2.if(
                boolAnd(
                  body2,
                  body2.greaterThanOrEqual(wordOffset, num(body2, WWDG_CR)),
                  body2.lessThanOrEqual(wordOffset, num(body2, WWDG_SR)),
                ),
                (hit) => {
                  const body3 = asBody(hit);

                  body3.setLocal(result, readWord(body3, WATCHDOG, wordOffset));
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

export function writeWatchdog(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  b.if(
    b.lessThan(wordOffset, num(b, WWDG_CR)),
    (iwdg) => {
      const body = asBody(iwdg);

      writeIwdg(body, offset, size, value);
    },
    (wwdg) => {
      const body = asBody(wwdg);

      writeWwdg(body, offset, size, value);
    },
  );
}

export function advanceIwdg(b: Body, elapsedPs: Value<number>): void {
  ensureInit(b);
  const access = read(b, IWDG_ACCESS);
  const low = iwdgLow(b, access);
  const accessOnly = b.bitAnd(low, num(b, IWDG_ACCESS_BIT));
  const totalNs = b.add(
    iwdgRemainderNs(b, access),
    b.floor(b.divide(elapsedPs, num(b, 1000))),
  );
  const elapsedUs = b.floor(b.divide(totalNs, num(b, 1000)));
  const remainderNs = b.remainder(totalNs, num(b, 1000));
  const updateBits = b.bitAnd(access, num(b, 0x0e));
  const updateUs = b.add(iwdgUpdateUs(b, access), elapsedUs);
  const synced = boolAnd(
    b,
    b.notEqual(types.number, updateBits, num(b, 0)),
    b.greaterThanOrEqual(updateUs, num(b, IWDG_UPDATE_SYNC_US)),
  );

  // 更新位在累计满 5 个 LSI 周期（约 156 µs）后清除；小数皮秒留在 ACCESS 高位，
  // 因此连续大量小 tick 与一次性大 tick 的结果一致，不会永远停在 PVU/RVU/WVU。
  b.if(synced, (sync) => {
    const body = asBody(sync);

    store(body, IWDG_ACCESS, packIwdgAccess(body, accessOnly, remainderNs, num(body, 0)));
  }, (still) => {
    const body = asBody(still);

    body.if(body.notEqual(types.number, updateBits, num(body, 0)), (updating) => {
      const scope = asBody(updating);

      store(scope, IWDG_ACCESS, packIwdgAccess(scope, low, remainderNs, updateUs));
    }, (stable) => {
      const scope = asBody(stable);

      store(scope, IWDG_ACCESS, packIwdgAccess(scope, accessOnly, remainderNs, num(scope, 0)));
    });
  });

  b.if(b.notEqual(types.number, read(b, IWDG_RUNNING), num(b, 0)), (running) => {
    const body = asBody(running);
    const remain = body.subtract(read(body, IWDG_REMAIN_US), elapsedUs);

    body.if(body.lessThanOrEqual(remain, num(body, 0)), (expired) => {
      const scope = asBody(expired);

      setReset(scope, 0x1);
      store(scope, IWDG_RUNNING, num(scope, 0));
      store(scope, IWDG_REMAIN_US, num(scope, 0));
      updateActivity(scope);
    }, (waiting) => {
      const scope = asBody(waiting);

      store(scope, IWDG_REMAIN_US, remain);
      updateActivity(scope);
    });
  });
}

export function advanceWwdg(b: Body, elapsedPs: Value<number>): void {
  ensureInit(b);
  b.if(b.notEqual(types.number, read(b, WWDG_RUNNING), num(b, 0)), (running) => {
    const body = asBody(running);
    const tick = wwdgTickUs(body);
    const totalPs = body.add(read(body, WWDG_REMAINDER_PS), elapsedPs);
    const elapsedUs = body.floor(body.divide(totalPs, num(body, 1_000_000)));
    const remainderPs = body.remainder(totalPs, num(body, 1_000_000));
    const elapsed = body.add(read(body, WWDG_ELAPSED_US), elapsedUs);
    const steps = body.floor(body.divide(elapsed, tick));
    const remainder = body.remainder(elapsed, tick);

    store(body, WWDG_ELAPSED_US, remainder);
    store(body, WWDG_REMAINDER_PS, remainderPs);
    body.if(body.greaterThan(steps, num(body, 0)), (step) => {
      const scope = asBody(step);
      const counter = scope.bitAnd(read(scope, WWDG_CR), num(scope, 0x7f));

      scope.if(scope.greaterThan(counter, num(scope, 0x40)), (above) => {
        const inner = asBody(above);
        const toEarly = inner.subtract(counter, num(inner, 0x40));

        inner.if(inner.greaterThanOrEqual(steps, toEarly), (reach) => {
          const body2 = asBody(reach);
          const extra = body2.subtract(steps, toEarly);

          store(body2, WWDG_CR, num(body2, 0x40));
          store(body2, WWDG_SR, num(body2, 1));
          body2.writeState(IRQ_DIRTY, bool(body2, true));
          markService(body2, SERVICE_IRQ);
          body2.if(body2.greaterThan(extra, num(body2, 0)), (late) => {
            const bad = asBody(late);

            setReset(bad, 0x2);
            store(bad, WWDG_RUNNING, num(bad, 0));
            updateActivity(bad);
          });
        }, (normal) => {
          const inner2 = asBody(normal);

          store(inner2, WWDG_CR, inner2.subtract(counter, steps));
          updateActivity(inner2);
        });
      });
      scope.if(scope.equal(types.number, counter, num(scope, 0x40)), (expired) => {
        const inner = asBody(expired);

        setReset(inner, 0x2);
        store(inner, WWDG_RUNNING, num(inner, 0));
        store(inner, WWDG_CR, num(inner, 0x3f));
        updateActivity(inner);
      });
      scope.if(scope.lessThan(counter, num(scope, 0x40)), (below) => {
        const inner = asBody(below);

        setReset(inner, 0x2);
        store(inner, WWDG_RUNNING, num(inner, 0));
        updateActivity(inner);
      });
    });
  });
}

export function advanceWatchdogs(b: Body, elapsedPs: Value<number>): void {
  advanceIwdg(b, elapsedPs);
  advanceWwdg(b, elapsedPs);
}

export function wwdgPending(b: Body): Value<boolean> {
  return boolAnd(b, boolBitAt(b, read(b, WWDG_SR), 0), boolBitAt(b, read(b, WWDG_CFR), 9));
}

export function readWatchdogAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  const result = b.local(types.number, 0);

  b.if(b.lessThan(address, num(b, IWDG_BASE)), (wwdg) => {
    const body = asBody(wwdg);

    wwdg.setLocal(
      result,
      readWatchdog(
        body,
        body.add(body.subtract(address, num(body, WWDG_BASE)), body.constant(types.number, WWDG_CR)),
        size,
      ),
    );
  });
  b.if(b.greaterThanOrEqual(address, num(b, IWDG_BASE)), (iwdg) => {
    const body = asBody(iwdg);

    iwdg.setLocal(
      result,
      readWatchdog(body, body.subtract(address, num(body, IWDG_BASE)), size),
    );
  });

  return b.getLocal(result);
}

export function writeWatchdogAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.if(b.lessThan(address, num(b, IWDG_BASE)), (wwdg) => {
    const body = asBody(wwdg);

    writeWatchdog(
      body,
      body.add(body.subtract(address, num(body, WWDG_BASE)), body.constant(types.number, WWDG_CR)),
      size,
      value,
    );
  });
  b.if(b.greaterThanOrEqual(address, num(b, IWDG_BASE)), (iwdg) => {
    const body = asBody(iwdg);

    writeWatchdog(body, body.subtract(address, num(body, IWDG_BASE)), size, value);
  });
}

export const watchdogModule: PeripheralModule = {
  id: 'watchdog',
  ranges: [
    { base: WWDG_BASE, size: 0x400 },
    { base: IWDG_BASE, size: 0x400 },
  ],
  read: readWatchdogAddress,
  write: writeWatchdogAddress,
  slot: PeripheralSlot.Watchdog,
  advance: advanceWatchdogs,
  interrupts: [
    {
      exception: 0 + 16,
      pendingIsPure: true,
      pending: wwdgPending,
      acknowledge: () => {},
    },
  ],
};

export const WATCHDOG_STATES: readonly {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}[] = [];
