import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { IRQ_DIRTY, RNG, RNG_BASE, SERVICE_IRQ, PeripheralSlot } from './layout';
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
import { readHclkHz } from './clock-tree';
import { refreshTick } from './tick';
import {
  NO_DEADLINE_PS,
  setPeripheralActive,
  setPeripheralDeadline,
} from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431 RNG。
 *
 * 真实器件是 4×32 位 DR 的 FIFO，新数据约每 213 个 AHB 周期生成一个；读取 DR 弹出
 * 队首，禁用 RNGEN 不会让已经生成的数据消失。这里按这个可观察语义实现：
 * - `rng` memory 的 DR 是 FIFO 队首，0x0c/0x10/0x14 是后三个隐藏槽；
 * - 0x18 低 16 位是到下一次填充的 AHB 周期数，高 16 位是错误/有效计数；
 * - 0x1c 是完整 32 位 xorshift32 状态；两者都是 `rng` memory 内的隐藏字。
 * - 生成器是固定种子的 xorshift32，**不是密码学熵源**，也不使用 Math.random；
 * - SR.DRDY 由 FIFO 有效计数派生，读 DR 后自动前移；RNGEN 清零后仍可继续读积压数据。
 */

export const RNG_REFILL_CYCLES = 213;
const CR = 0x00;
const SR = 0x04;
const DR = 0x08;
const FIFO0 = 0x0c;
const FIFO1 = 0x10;
const FIFO2 = 0x14;
const META = 0x18;
const STATE = 0x1c;

const CR_MASK = 0x2c;

const FAULT_CECS = 0x01;
const FAULT_SECS = 0x02;
const LATCH_CEIS = 0x04;
const LATCH_SEIS = 0x08;
const COUNT_SHIFT = 8;
const COUNT_MASK = 0x7;
const FLAGS_RETAIN_MASK = 0xfffff8ff;
const ERROR_CLEAR_MASK = 0xffffff00;

export const RNG_STATE_SEED = 0x2545f491;

const read = (b: Body, offset: number): Value<number> => readWord(b, RNG, num(b, offset));
const readFlags = (b: Body): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(read(b, META), num(b, 16)), num(b, 0xffff));
const readTimer = (b: Body): Value<number> => b.bitAnd(read(b, META), num(b, 0xffff));
const storeMeta = (b: Body, timer: Value<number>, flags: Value<number>): void => {
  store(b, META, b.bitOr(b.bitAnd(timer, num(b, 0xffff)), b.shiftLeft(flags, num(b, 16))));
};

function ensureInit(b: Body): void {
  b.if(b.equal(types.number, read(b, STATE), num(b, 0)), (first) => {
    store(asBody(first), STATE, num(asBody(first), RNG_STATE_SEED));
  });
}
const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWord(b, RNG, num(b, offset), value);
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

const cyclePs = (b: Body): Value<number> =>
  b.max(num(b, 1), b.floor(b.divide(num(b, 1_000_000_000_000), readHclkHz(b))));

function updateActivity(b: Body): void {
  const cr = read(b, CR);
  const flags = readFlags(b);
  const count = b.bitAnd(b.shiftRightUnsigned(flags, num(b, COUNT_SHIFT)), num(b, COUNT_MASK));
  const enabled = boolBitAt(b, cr, 2);
  const active = boolAnd(b, enabled, b.lessThan(count, num(b, 4)));
  const elapsed = readTimer(b);
  const remaining = b.select(
    types.number,
    b.lessThan(elapsed, num(b, RNG_REFILL_CYCLES)),
    (inner) => inner.subtract(inner.constant(types.number, RNG_REFILL_CYCLES), elapsed),
    (inner) => inner.constant(types.number, 1),
  );

  b.if(active, (on) => {
    const body = asBody(on);

    setPeripheralActive(body, PeripheralSlot.CrcRng, true);
    setPeripheralDeadline(
      body,
      PeripheralSlot.CrcRng,
      body.max(
        body.multiply(remaining, cyclePs(body)),
        body.constant(types.number, 1),
      ),
    );
    refreshTick(body);
  });
  b.if(b.not(active), (off) => {
    const body = asBody(off);

    setPeripheralActive(body, PeripheralSlot.CrcRng, false);
    setPeripheralDeadline(body, PeripheralSlot.CrcRng, num(body, NO_DEADLINE_PS));
    refreshTick(body);
  });
}

/** 完整 32 位 xorshift32：状态自身递推，周期 2^32−1，非密码学。 */
function randomWord(b: Body, state: Value<number>): Value<number> {
  const first = b.bitXor(state, b.shiftLeft(state, num(b, 13)));
  const second = b.bitXor(first, b.shiftRightUnsigned(first, num(b, 17)));

  return u32(b, b.bitXor(second, b.shiftLeft(second, num(b, 5))));
}

function pushWord(b: Body): void {
  const flags = readFlags(b);
  const count = b.bitAnd(b.shiftRightUnsigned(flags, num(b, COUNT_SHIFT)), num(b, COUNT_MASK));
  const state = read(b, STATE);
  const word = randomWord(b, state);
  const nextFlags = b.bitOr(
    b.bitAnd(flags, num(b, FLAGS_RETAIN_MASK)),
    b.shiftLeft(b.add(count, num(b, 1)), num(b, COUNT_SHIFT)),
  );
  const timer = readTimer(b);

  store(b, STATE, word);
  b.if(b.equal(types.number, count, num(b, 0)), (head) => store(asBody(head), DR, word));
  b.if(b.equal(types.number, count, num(b, 1)), (slot) => store(asBody(slot), FIFO0, word));
  b.if(b.equal(types.number, count, num(b, 2)), (slot) => store(asBody(slot), FIFO1, word));
  b.if(b.equal(types.number, count, num(b, 3)), (slot) => store(asBody(slot), FIFO2, word));
  storeMeta(b, timer, nextFlags);
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

function popWord(b: Body): Value<number> {
  const value = read(b, DR);
  const flags = readFlags(b);
  const count = b.bitAnd(b.shiftRightUnsigned(flags, num(b, COUNT_SHIFT)), num(b, COUNT_MASK));
  const result = b.local(types.number, 0);

  b.if(b.greaterThan(count, num(b, 0)), (shift) => {
    const body = asBody(shift);
    const nextCount = body.subtract(count, num(body, 1));
    const nextFlags = body.bitOr(
      body.bitAnd(flags, num(body, FLAGS_RETAIN_MASK)),
      body.shiftLeft(nextCount, num(body, COUNT_SHIFT)),
    );

    body.setLocal(result, value);
    store(body, DR, read(body, FIFO0));
    store(body, FIFO0, read(body, FIFO1));
    store(body, FIFO1, read(body, FIFO2));
    storeMeta(body, num(body, 0), nextFlags);
    updateActivity(body);
  });

  // FIFO 为空：返回 0，不把陈旧 DR 当成有效数据，也不改动 FIFO/时钟。
  return b.getLocal(result);
}

export function readRng(b: Body, offset: Value<number>, size: number): Value<number> {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, CR)),
    (cr) => {
      const body = asBody(cr);

      body.setLocal(result, body.bitAnd(read(body, CR), num(body, CR_MASK)));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, DR)),
        (dr) => dr.setLocal(result, popWord(asBody(dr))),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, SR)),
            (sr) => {
              const body2 = asBody(sr);
              const flags = readFlags(body2);
              const count = body2.bitAnd(
                body2.shiftRightUnsigned(flags, num(body2, COUNT_SHIFT)),
                num(body2, COUNT_MASK),
              );
              const fault = body2.bitAnd(flags, num(body2, 0xff));
              const ready = body2.select(
                types.number,
                body2.greaterThan(count, num(body2, 0)),
                (inner) => inner.constant(types.number, 0x01),
                (inner) => inner.constant(types.number, 0),
              );
              const cecs = body2.select(
                types.number,
                body2.notEqual(types.number, body2.bitAnd(fault, num(body2, FAULT_CECS)), num(body2, 0)),
                (inner) => inner.constant(types.number, 0x02),
                (inner) => inner.constant(types.number, 0),
              );
              const secs = body2.select(
                types.number,
                body2.notEqual(types.number, body2.bitAnd(fault, num(body2, FAULT_SECS)), num(body2, 0)),
                (inner) => inner.constant(types.number, 0x04),
                (inner) => inner.constant(types.number, 0),
              );
              const latchedCeis = body2.select(
                types.number,
                body2.notEqual(
                  types.number,
                  body2.bitAnd(flags, num(body2, LATCH_CEIS)),
                  num(body2, 0),
                ),
                (inner) => inner.constant(types.number, 0x20),
                (inner) => inner.constant(types.number, 0),
              );
              const latchedSeis = body2.select(
                types.number,
                body2.notEqual(
                  types.number,
                  body2.bitAnd(flags, num(body2, LATCH_SEIS)),
                  num(body2, 0),
                ),
                (inner) => inner.constant(types.number, 0x40),
                (inner) => inner.constant(types.number, 0),
              );

              body2.setLocal(
                result,
                body2.bitOr(
                  body2.bitOr(ready, cecs),
                  body2.bitOr(body2.bitOr(secs, latchedCeis), latchedSeis),
                ),
              );
            },
            (unknown) => unknown.setLocal(result, num(asBody(unknown), 0)),
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeRng(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  ensureInit(b);
  const wordOffset = b.bitAnd(offset, num(b, 0xfffffffc));

  b.if(
    b.equal(types.number, wordOffset, num(b, CR)),
    (cr) => {
      const body = asBody(cr);
      const old = read(body, CR);
      const merged = body.bitAnd(
        merge(body, old, value, offset, size),
        num(body, CR_MASK),
      );
      const wasEnabled = boolBitAt(body, old, 2);
      const enabled = boolBitAt(body, merged, 2);

      store(body, CR, merged);
      body.if(boolAnd(body, body.not(wasEnabled), enabled), (start) => {
        const scope = asBody(start);

        storeMeta(scope, num(scope, 0), readFlags(scope));
        updateActivity(scope);
        scope.writeState(IRQ_DIRTY, bool(scope, true));
        markService(scope, SERVICE_IRQ);
      });
      body.if(boolAnd(body, wasEnabled, body.not(enabled)), (stop) => {
        // FIFO 内容保留；禁用只停止后台填充，读 DR 仍返回已生成数据。
        updateActivity(asBody(stop));
      });
      body.if(enabled, (refresh) => updateActivity(asBody(refresh)));
    },
    (other) => {
      const body = asBody(other);

      body.if(body.equal(types.number, wordOffset, num(body, SR)), (sr) => {
        const scope = asBody(sr);
        const flags = readFlags(scope);
        const raw = u32(scope, value);
        const keepCeis = boolBitAt(scope, raw, 5);
        const keepSeis = boolBitAt(scope, raw, 6);
        const next = scope.bitOr(
          scope.bitAnd(flags, num(scope, ~(LATCH_CEIS | LATCH_SEIS))),
          scope.bitOr(
            scope.select(
              types.number,
              keepCeis,
              (inner) => inner.constant(types.number, LATCH_CEIS),
              (inner) => inner.constant(types.number, 0),
            ),
            scope.select(
              types.number,
              keepSeis,
              (inner) => inner.constant(types.number, LATCH_SEIS),
              (inner) => inner.constant(types.number, 0),
            ),
          ),
        );

        // RNG_SR 的 CEIS/SEIS 是 rc_w0：写 0 清 latched 位，CECS/SECS 条件位保持。
        storeMeta(scope, readTimer(scope), next);
        scope.writeState(IRQ_DIRTY, bool(scope, true));
        markService(scope, SERVICE_IRQ);
      });
      body.if(body.equal(types.number, wordOffset, num(body, DR)), () => {});
    },
  );
}

/** 错误注入：设置 CECS/SECS 条件并 latched CEIS/SEIS；用于确定性测试和诊断。 */
export function setRngFaults(
  b: Body,
  cecs: boolean | Value<boolean>,
  secs: boolean | Value<boolean>,
): void {
  const flags = readFlags(b);
  const cecsValue =
    typeof cecs === 'boolean'
      ? num(b, cecs ? FAULT_CECS : 0)
      : b.select(
          types.number,
          cecs,
          (inner) => inner.constant(types.number, FAULT_CECS),
          (inner) => inner.constant(types.number, 0),
        );
  const secsValue =
    typeof secs === 'boolean'
      ? num(b, secs ? FAULT_SECS : 0)
      : b.select(
          types.number,
          secs,
          (inner) => inner.constant(types.number, FAULT_SECS),
          (inner) => inner.constant(types.number, 0),
        );
  const set = b.bitOr(
    b.bitAnd(flags, num(b, ERROR_CLEAR_MASK)),
    b.bitOr(
      b.bitOr(cecsValue, secsValue),
      b.bitOr(
        b.shiftLeft(cecsValue, num(b, 2)),
        b.shiftLeft(secsValue, num(b, 2)),
      ),
    ),
  );

  storeMeta(b, readTimer(b), u32(b, set));
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
}

export function advanceRng(b: Body, elapsedPs: Value<number>): void {
  ensureInit(b);
  const cr = read(b, CR);
  const enabled = boolBitAt(b, cr, 2);
  const flags = readFlags(b);
  const count = b.bitAnd(b.shiftRightUnsigned(flags, num(b, COUNT_SHIFT)), num(b, COUNT_MASK));

  b.if(enabled, (on) => {
    const body = asBody(on);

    body.if(body.lessThan(count, num(body, 4)), (room) => {
      const scope = asBody(room);
      const added = scope.floor(scope.divide(elapsedPs, cyclePs(scope)));
      const elapsed = scope.min(
        scope.add(readTimer(scope), added),
        scope.constant(types.number, 0xffff),
      );

      scope.if(
        scope.greaterThanOrEqual(elapsed, scope.constant(types.number, RNG_REFILL_CYCLES)),
        (refill) => {
          const inner = asBody(refill);
          const remain = inner.subtract(
            elapsed,
            inner.constant(types.number, RNG_REFILL_CYCLES),
          );

          pushWord(inner);
          storeMeta(inner, remain, readFlags(inner));
          updateActivity(inner);
        },
        (waiting) => {
          const inner = asBody(waiting);

          storeMeta(inner, elapsed, readFlags(inner));
          updateActivity(inner);
        },
      );
    }, (full) => updateActivity(asBody(full)));
  });
  b.if(b.not(enabled), (off) => updateActivity(asBody(off)));
}

export function rngPending(b: Body): Value<boolean> {
  const cr = read(b, CR);
  const flags = readFlags(b);
  const count = b.bitAnd(b.shiftRightUnsigned(flags, num(b, COUNT_SHIFT)), num(b, COUNT_MASK));
  return boolAnd(
    b,
    boolBitAt(b, cr, 3),
    boolOr(
      b,
      b.greaterThan(count, num(b, 0)),
      b.notEqual(
        types.number,
        b.bitAnd(flags, num(b, LATCH_CEIS | LATCH_SEIS)),
        num(b, 0),
      ),
    ),
  );
}

export function readRngAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  return readRng(b, b.subtract(address, num(b, RNG_BASE)), size);
}

export function writeRngAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRng(b, b.subtract(address, num(b, RNG_BASE)), size, value);
}

export const rngModule: PeripheralModule = {
  id: 'rng',
  ranges: [{ base: RNG_BASE, size: 0x20 }],
  read: readRngAddress,
  write: writeRngAddress,
  slot: PeripheralSlot.CrcRng,
  advance: advanceRng,
  interrupts: [
    {
      exception: 90 + 16,
      pendingIsPure: true,
      pending: rngPending,
      acknowledge: () => {},
    },
  ],
};

export const RNG_STATES: readonly {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}[] = [];
