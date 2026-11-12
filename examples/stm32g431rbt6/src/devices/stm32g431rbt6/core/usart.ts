import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  GPIO_SYNC,
  IRQ_DIRTY,
  PERIPH,
  TX_MASK,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
  USART_STATE,
  USART_STATE_STRIDE,
  txState,
} from './layout';
import { machine } from './machine';
import type { AlternateDriver } from './machine';
import {
  asBody,
  bool,
  boolAnd,
  boolBitAt,
  boolOr,
  num,
  readWord,
  readWordAt,
  u32,
  writeWord,
} from './ir';
import type { Body } from './ir';
import { refreshTick } from './tick';

/**
 * USART1/2/3 的发送模型。
 *
 * 只实现轮询/中断发送所需的部分：CR1 的 UE/TE/TXEIE/TCIE、BRR 的波特率、ISR 的
 * TXE/TC，以及 TDR 写入后的起始位—8 位数据—停止位串行输出。数据按 LSB 先发，
 * 发送器空闲时停止位后保持高电平。接收、同步模式、硬件流控、LIN/IrDA/智能卡与
 * DMA 未建模。
 *
 * 发送器的内部相位（活动位、剩余时长、队列、计数、位时长）用 state 保存，节拍推进只看
 * `txMask`（哪几路正在发送）；没有发送活动时不读任何 USART 寄存器。位时长在 BRR 写入时
 * 算一次。位相位变化只更新 state，不逐位改写引脚意图——`writeIntent` 会让整块退出
 * direct 后端，引脚电平改在寄存器写入处刷新。
 */

export interface UsartPin {
  readonly port: number;
  readonly pin: number;
  readonly af: number;
}

export interface UsartConfig {
  readonly index: number;
  readonly base: number;
  readonly irq: number;
  readonly txPins: readonly UsartPin[];
  readonly txChannel: 'uart1Tx' | 'uart2Tx' | 'uart3Tx';
}

export const USARTS: readonly UsartConfig[] = [
  {
    index: 1,
    base: USART1_BASE,
    irq: 37,
    txPins: [
      { port: 0, pin: 9, af: 7 },
      { port: 1, pin: 6, af: 7 },
      { port: 2, pin: 4, af: 7 },
    ],
    txChannel: 'uart1Tx',
  },
  {
    index: 2,
    base: USART2_BASE,
    irq: 38,
    txPins: [{ port: 0, pin: 2, af: 7 }],
    txChannel: 'uart2Tx',
  },
  {
    index: 3,
    base: USART3_BASE,
    irq: 39,
    txPins: [
      { port: 1, pin: 10, af: 7 },
      { port: 2, pin: 10, af: 7 },
    ],
    txChannel: 'uart3Tx',
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

/** TX_ACTIVE 的 bit0 活动，bit8–15 位序号（0=起始位，9=停止位），bit16–23 数据字节。 */
const BIT_COUNT = 10;

const stateBase = (config: UsartConfig): number =>
  USART_STATE + (config.index - 1) * USART_STATE_STRIDE;

const maskBit = (config: UsartConfig): number => 1 << (config.index - 1);

const load = (b: Body, config: UsartConfig, offset: number): Value<number> =>
  readWordAt(b, PERIPH, stateBase(config) + offset);

const loadAt = (b: Body, config: UsartConfig, offset: Value<number>): Value<number> =>
  readWord(b, PERIPH, b.add(num(b, stateBase(config)), offset));

const storeAt = (
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  value: Value<number>,
): void => {
  writeWord(b, PERIPH, b.add(num(b, stateBase(config)), offset), value);
};

const readTx = (
  b: Body,
  config: UsartConfig,
  field: 'Active' | 'Remaining' | 'Queue' | 'Count' | 'Publish',
): Value<number> => b.readState(txState(config.index, field), types.number);

const writeTx = (
  b: Body,
  config: UsartConfig,
  field: 'Active' | 'Remaining' | 'Queue' | 'Count',
  value: Value<number>,
): void => {
  b.writeState(txState(config.index, field), u32(b, value));
};

const writePublish = (b: Body, config: UsartConfig, value: Value<number>): void => {
  b.writeState(txState(config.index, 'Publish'), value);
};

const bitPeriod = (b: Body, config: UsartConfig): Value<number> =>
  b.readState(txState(config.index, 'Period'), types.number);

export function usartEnabled(b: Body, config: UsartConfig): Value<boolean> {
  const cr1 = load(b, config, CR1);

  return boolAnd(b, boolBitAt(b, cr1, 0), boolBitAt(b, cr1, 3));
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
}

/** 标记该路有发送活动，节拍推进才会看它。 */
function markBusy(b: Body, config: UsartConfig): void {
  b.writeState(TX_MASK, b.bitOr(b.readState(TX_MASK, types.number), num(b, maskBit(config))));
  // 发送期间服务节拍要细到位时长量级。
  refreshTick(b);
}

function startByte(b: Body, config: UsartConfig, value: Value<number>): void {
  const byte = b.bitAnd(u32(b, value), num(b, 0xff));

  writeTx(b, config, 'Active', b.bitOr(byte, num(b, 1)));
  writeTx(b, config, 'Remaining', bitPeriod(b, config));
  // 字节发布推迟到服务块：否则指令块里带 `send`，整块（含所有外设写）会被直接
  // 后端拒绝，永远走解释路径。
  writePublish(b, config, byte);
  markBusy(b, config);
}

/** 发布已开始的字节；只在服务块里调用。 */
function publishByte(b: Body, config: UsartConfig): void {
  const pending = readTx(b, config, 'Publish');

  b.if(b.greaterThanOrEqual(pending, num(b, 0)), (inner) => {
    const body = asBody(inner);

    body.send(config.txChannel, pending);
    writePublish(body, config, num(body, -1));
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

/** 每个外设节拍推进发送器的位相位；只处理仍在发送的通道。 */
export function advanceUsart(b: Body, elapsedPs: Value<number>): void {
  for (const config of USARTS) {
    publishByte(b, config);
    advanceTransmitter(b, config, elapsedPs);
  }
}

function advanceTransmitter(b: Body, config: UsartConfig, elapsedPs: Value<number>): void {
  const mask = maskBit(config);

  b.if(
    b.notEqual(types.number, b.bitAnd(b.readState(TX_MASK, types.number), num(b, mask)), num(b, 0)),
    (inner) => {
      const body = asBody(inner);
      const active = readTx(body, config, 'Active');

      body.if(boolBitAt(body, active, 0), (busy) => {
        const scope = asBody(busy);
        const remaining = scope.subtract(readTx(scope, config, 'Remaining'), elapsedPs);

        scope.if(
          scope.lessThanOrEqual(remaining, num(scope, 0)),
          (transition) => {
            const phase = asBody(transition);
            const index = phase.bitAnd(
              phase.shiftRightUnsigned(active, num(phase, 8)),
              num(phase, 0xff),
            );
            const next = phase.add(index, num(phase, 1));

            phase.if(
              phase.greaterThan(next, num(phase, BIT_COUNT)),
              (finished) => {
                const done = asBody(finished);
                const count = readTx(done, config, 'Count');

                writeTx(done, config, 'Active', num(done, 0));
                writeTx(done, config, 'Remaining', num(done, 0));
                // 字节结束：TXE/TC 可能变为有效，需要重新扫描异常。
                done.writeState(IRQ_DIRTY, bool(done, true));
                done.if(
                  done.greaterThan(count, num(done, 0)),
                  (more) => dequeue(asBody(more), config),
                  (idle) => {
                    const body2 = asBody(idle);

                    body2.writeState(
                      TX_MASK,
                      body2.bitAnd(
                        body2.readState(TX_MASK, types.number),
                        num(body2, ~mask & 0xffffffff),
                      ),
                    );
                    // 发送结束后恢复空闲粒度。
                    refreshTick(body2);
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
              },
            );
          },
          (still) => {
            writeTx(asBody(still), config, 'Remaining', remaining);
          },
        );
      });
    },
  );
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

  return b.bitOr(empty, complete);
}

export function readUsart(
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, ISR)),
    (isr) => isr.setLocal(result, isrValue(asBody(isr), config)),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, RDR)),
        (zero) => zero.setLocal(result, num(zero, 0)),
        (stored) => stored.setLocal(result, loadAt(asBody(stored), config, wordOffset)),
      );
    },
  );

  const value = b.getLocal(result);

  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
}

/** BRR 写入后重算一次位时长（皮秒）：`floor(BRR × 1e12 / f)`，0 视为 1。 */
function storeBitPeriod(b: Body, config: UsartConfig): void {
  const brr = load(b, config, BRR);
  const computing = b.floor(
    b.divide(b.multiply(num(b, 1_000_000_000_000), brr), num(b, machine().clockFrequency)),
  );
  const period = b.select(
    types.number,
    b.greaterThan(brr, num(b, 0)),
    (inner) =>
      inner.select(
        types.number,
        inner.greaterThan(computing, inner.constant(types.number, 0)),
        () => computing,
        (inner2) => inner2.constant(types.number, 1),
      ),
    (inner) => inner.constant(types.number, 1),
  );

  b.writeState(txState(config.index, 'Period'), u32(b, period));
}

export function writeUsart(
  b: Body,
  config: UsartConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));

  b.if(
    b.equal(types.number, wordOffset, num(b, TDR)),
    (tdr) => {
      enqueue(asBody(tdr), config, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          body.equal(types.number, wordOffset, num(body, RDR)),
          boolOr(
            body,
            body.equal(types.number, wordOffset, num(body, ICR)),
            body.equal(types.number, wordOffset, num(body, RQR)),
          ),
        ),
        () => {},
        (register) => {
          const scope = asBody(register);
          const current = loadAt(scope, config, wordOffset);
          const width = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
          const shift = scope.multiply(scope.bitAnd(offset, num(scope, 3)), num(scope, 8));
          const placed = scope.shiftLeft(scope.bitAnd(u32(scope, value), num(scope, width)), shift);
          const mask = scope.shiftLeft(num(scope, width), shift);
          const merged = u32(scope, scope.bitOr(scope.bitAnd(current, scope.bitNot(mask)), placed));

          storeAt(scope, config, wordOffset, merged);
          scope.if(
            boolOr(
              scope,
              scope.equal(types.number, wordOffset, num(scope, CR1)),
              scope.equal(types.number, wordOffset, num(scope, CR3)),
            ),
            (sync) => {
              const body2 = asBody(sync);

              syncTxPins(body2, config);
              body2.writeState(IRQ_DIRTY, bool(body2, true));
            },
          );
          scope.if(scope.equal(types.number, wordOffset, num(scope, BRR)), (brr) =>
            storeBitPeriod(asBody(brr), config),
          );
        },
      );
    },
  );
}

/** USART 的发送中断挂起条件。 */
export function usartPending(b: Body, config: UsartConfig): Value<boolean> {
  const cr1 = load(b, config, CR1);

  return boolOr(
    b,
    boolAnd(b, boolBitAt(b, cr1, 7), txEmpty(b, config)),
    boolAnd(b, boolBitAt(b, cr1, 6), transferComplete(b, config)),
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

export { CR1, CR2, CR3, BRR, ISR, RDR, TDR, GTPR, RTOR, PRESC };
