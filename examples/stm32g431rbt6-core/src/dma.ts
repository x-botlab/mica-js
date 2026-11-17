import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { DMA, DMA1_BASE, DMA2_BASE, DMA_SIZE, PeripheralSlot } from './layout';
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
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { refreshTick } from './tick';
import { dmamuxRequestId } from './dmamux';
import {
  NO_DEADLINE_PS,
  setPeripheralActive,
  setPeripheralDeadline,
} from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431 的 DMA1/DMA2（各 6 通道）。
 *
 * 寄存器语义按 RM0440：CCR/CNDTR/CPAR/CMAR、DIR/MEM2MEM/MINC/PINC/PSIZE/MSIZE/
 * CIRC/PL、HT/TC/TE 标志与 IFCR 的 W1C。每个 tick 每个控制器按 PL 选一个通道搬运
 * 一项；请求来自 DMAMUX，由外设注册的 `DmaRequestSource.ready` 提供。
 *
 * DMA 的数据通路**不直接抓取外设数组**：调用方注入 `DmaBus`，生产环境的
 * bus/memory 用现有的 readMemory/writeMemory 包一层，于是 SRAM/CCM/Flash 与
 * 外设数据寄存器的读改写副作用都和设备其它访问一致。这样 dma.ts 不 import
 * memory/bus/USART/ADC/SPI，避免环依赖。
 *
 * 时间模型是确定的 1 µs/项：一次 `advanceDma` 每控制器最多搬一项。调用方在
 * `dmaActive` 为真时把服务节拍收到 `DMA_TICK_PS`，即可观察到 CNDTR 与标志逐项变化。
 */

export { DMA1_BASE, DMA2_BASE } from './layout';
export const DMA1_STATE = 0x000;
export const DMA2_STATE = 0x100;
export const DMA_CHANNELS = 6;
export const DMA_CHANNEL_COUNT = 12;
export const DMA_ITEM_PS = 1_000_000;
/** `dma` memory 末尾的忙位字；不属于任何固件可见寄存器。 */
export const DMA_BUSY_WORD = 0x3f0;

const ISR = 0x00;
const IFCR = 0x04;
const CHANNEL_BASE = 0x08;
/** CMSIS/G431 的 guest 通道步长：CH1+0x08、CH2+0x1c、CH6+0x6c。 */
const GUEST_CHANNEL_STRIDE = 0x14;
/** 每通道 +0x10 是保留 word，读 0、写忽略，不能 alias 到下一通道。 */
const CHANNEL_RESERVED = 0x10;
const CHANNEL_LAST = CHANNEL_BASE + (DMA_CHANNELS - 1) * GUEST_CHANNEL_STRIDE + CHANNEL_RESERVED;
/** 内部 BASE_* 影子只按 0x10 排布，与 guest 真实寄存器窗口完全分离。 */
const SHADOW_CHANNEL_STRIDE = 0x10;
const CCR = 0x00;
const CNDTR = 0x04;
const CPAR = 0x08;
const CMAR = 0x0c;
const BASE_COUNT = 0x80;
const BASE_PAR = 0x84;
const BASE_MAR = 0x88;

const CCR_MASK = 0x7fff;
const CNDTR_MASK = 0xffff;

const FLAG_GIF = 0x1;
const FLAG_TC = 0x2;
const FLAG_HT = 0x4;
const FLAG_TE = 0x8;

export interface DmaController {
  readonly index: 1 | 2;
  readonly base: number;
  readonly stateBase: number;
}

export const DMA_CONTROLLERS: readonly DmaController[] = [
  { index: 1, base: DMA1_BASE, stateBase: DMA1_STATE },
  { index: 2, base: DMA2_BASE, stateBase: DMA2_STATE },
];

/**
 * DMA 的数据访问抽象。`size` 是 1/2/4 的编译期常量；`valid` 不存在时视为全部可访问。
 * 生产集成应把现有 `readMemory`/`writeMemory` 包成这个接口。
 */
export interface DmaBus {
  valid?(
    b: Body,
    address: Value<number>,
    size: 1 | 2 | 4,
    access: 'read' | 'write',
  ): Value<boolean>;
  read(b: Body, address: Value<number>, size: 1 | 2 | 4): Value<number>;
  write(b: Body, address: Value<number>, size: 1 | 2 | 4, value: Value<number>): void;
}

/** 外设请求源。只提供 `ready`；数据默认走 DmaBus 对 CPAR 的真实读写。 */
export interface DmaRequestSource {
  readonly id: number;
  readonly name: string;
  ready(b: Body, context: DmaRequestContext): Value<boolean>;
  /** 可选覆盖：外设数据寄存器无法经通用总线访问时使用。 */
  read?(b: Body, context: DmaRequestContext): Value<number>;
  /** 可选覆盖：同上，用于存储器→外设方向。 */
  write?(b: Body, context: DmaRequestContext, value: Value<number>): void;
}

export interface DmaRequestContext {
  readonly controller: DmaController;
  readonly channel: Value<number>;
  readonly globalChannel: Value<number>;
}

export interface DmaRuntime {
  readonly bus: DmaBus;
  readonly requests: readonly DmaRequestSource[];
}

/** 逐通道忙位：bit0–5=DMA1 CH1–6，bit6–11=DMA2 CH1–6。 */
export const DMA_TICK_PS = DMA_ITEM_PS;

export interface DmaStateSpec {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}

export const DMA_STATES: readonly DmaStateSpec[] = [];

const load = (b: Body, stateBase: number, offset: number): Value<number> =>
  readWordAt(b, DMA, stateBase + offset);

const loadAt = (b: Body, stateBase: number, offset: Value<number>): Value<number> =>
  readWord(b, DMA, b.add(num(b, stateBase), offset));

const store = (b: Body, stateBase: number, offset: number, value: Value<number>): void => {
  writeWordAt(b, DMA, stateBase + offset, value);
};

const storeAt = (b: Body, stateBase: number, offset: Value<number>, value: Value<number>): void => {
  writeWord(b, DMA, b.add(num(b, stateBase), offset), value);
};

const guestRegisterOffset = (local: number, register: number): number =>
  CHANNEL_BASE + local * GUEST_CHANNEL_STRIDE + register;

const guestRegisterOffsetAt = (
  b: Body,
  local: Value<number>,
  register: number,
): Value<number> =>
  b.add(
    num(b, CHANNEL_BASE + register),
    b.multiply(local, b.constant(types.number, GUEST_CHANNEL_STRIDE)),
  );

const shadowOffsetAt = (b: Body, local: Value<number>, field: number): Value<number> =>
  b.add(
    num(b, BASE_COUNT + field),
    b.multiply(local, b.constant(types.number, SHADOW_CHANNEL_STRIDE)),
  );

interface GuestChannel {
  readonly local: Value<number>;
  readonly register: Value<number>;
  readonly reserved: Value<boolean>;
}

function guestChannel(b: Body, wordOffset: Value<number>): GuestChannel {
  const relative = b.subtract(wordOffset, num(b, CHANNEL_BASE));
  const local = b.floor(b.divide(relative, num(b, GUEST_CHANNEL_STRIDE)));
  const register = b.remainder(relative, num(b, GUEST_CHANNEL_STRIDE));

  return {
    local,
    register,
    reserved: b.equal(types.number, register, num(b, CHANNEL_RESERVED)),
  };
}

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

export function readDma(
  b: Body,
  controller: DmaController,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);

  b.if(b.lessThan(offset, num(b, DMA_SIZE)), (inWindow) => {
    const window = asBody(inWindow);

    window.if(
      window.equal(types.number, wordOffset, num(window, ISR)),
      (isr) => isr.setLocal(result, load(asBody(isr), controller.stateBase, ISR)),
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, IFCR)),
          (ifcr) => ifcr.setLocal(result, num(asBody(ifcr), 0)),
          (register) => {
            const scope = asBody(register);

            scope.if(
              boolAnd(
                scope,
                scope.greaterThanOrEqual(wordOffset, num(scope, CHANNEL_BASE)),
                scope.lessThanOrEqual(wordOffset, num(scope, CHANNEL_LAST)),
              ),
              (channel) => {
                const body2 = asBody(channel);
                const { register: reg, reserved } = guestChannel(body2, wordOffset);
                const stored = loadAt(body2, controller.stateBase, wordOffset);
                const masked = body2.select(
                  types.number,
                  reserved,
                  (inner) => inner.constant(types.number, 0),
                  (inner) =>
                    inner.select(
                      types.number,
                      inner.equal(types.number, reg, inner.constant(types.number, CCR)),
                      (inner2) => inner2.bitAnd(stored, inner2.constant(types.number, CCR_MASK)),
                      (inner2) =>
                        inner2.select(
                          types.number,
                          inner2.equal(types.number, reg, inner2.constant(types.number, CNDTR)),
                          (inner3) =>
                            inner3.bitAnd(stored, inner3.constant(types.number, CNDTR_MASK)),
                          () => stored,
                        ),
                    ),
                );

                body2.setLocal(result, masked);
              },
            );
          },
        );
      },
    );
  });

  return extract(b, b.getLocal(result), offset, size);
}

const busyWord = (b: Body): Value<number> => readWordAt(b, DMA, DMA_BUSY_WORD);

const storeBusyWord = (b: Body, value: Value<number>): void => {
  writeWordAt(b, DMA, DMA_BUSY_WORD, value);
};

function setBusy(b: Body, global: Value<number>): void {
  const bit = b.shiftLeft(num(b, 1), global);

  storeBusyWord(b, b.bitOr(busyWord(b), bit));
}

function clearBusy(b: Body, global: Value<number>): void {
  const bit = b.shiftLeft(num(b, 1), global);

  storeBusyWord(b, b.bitAnd(busyWord(b), b.bitNot(bit)));
}

/** 忙位变化后同步中央活动槽与下一次服务期限。 */
function syncDmaActivity(b: Body): void {
  const busy = busyWord(b);

  b.if(b.notEqual(types.number, busy, num(b, 0)), (active) => {
    const body = asBody(active);

    setPeripheralActive(body, PeripheralSlot.Dma, true);
    setPeripheralDeadline(body, PeripheralSlot.Dma, num(body, DMA_ITEM_PS));
    refreshTick(body);
  });
  b.if(b.equal(types.number, busy, num(b, 0)), (idle) => {
    const body = asBody(idle);

    setPeripheralActive(body, PeripheralSlot.Dma, false);
    setPeripheralDeadline(body, PeripheralSlot.Dma, num(body, NO_DEADLINE_PS));
    refreshTick(body);
  });
}

function setFlag(b: Body, controller: DmaController, local: Value<number>, mask: number): void {
  const shift = b.multiply(local, num(b, 4));
  const value = b.shiftLeft(num(b, mask), shift);
  const current = load(b, controller.stateBase, ISR);

  store(b, controller.stateBase, ISR, b.bitOr(current, value));
}

function startChannel(b: Body, controller: DmaController, local: Value<number>): void {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));
  const count = b.bitAnd(
    loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CNDTR)),
    num(b, CNDTR_MASK),
  );
  const par = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CPAR));
  const mar = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CMAR));

  storeAt(b, controller.stateBase, shadowOffsetAt(b, local, 0), count);
  storeAt(b, controller.stateBase, shadowOffsetAt(b, local, 4), par);
  storeAt(b, controller.stateBase, shadowOffsetAt(b, local, 8), mar);
  b.if(b.greaterThan(count, num(b, 0)), (running) => {
    const body = asBody(running);

    setBusy(body, body.add(local, num(body, controller.index === 1 ? 0 : 6)));
    syncDmaActivity(body);
  });
  b.if(b.equal(types.number, count, num(b, 0)), (complete) => {
    const body = asBody(complete);

    setFlag(body, controller, local, FLAG_GIF | FLAG_TC);
    storeAt(
      body,
      controller.stateBase,
      guestRegisterOffsetAt(body, local, CCR),
      body.bitAnd(ccr, num(body, ~1)),
    );
  });
}

function stopChannel(b: Body, controller: DmaController, local: Value<number>): void {
  clearBusy(b, b.add(local, num(b, controller.index === 1 ? 0 : 6)));
  syncDmaActivity(b);
}

function handleCcr(
  b: Body,
  controller: DmaController,
  local: Value<number>,
  oldCcr: Value<number>,
  newCcr: Value<number>,
): void {
  const oldEnable = boolBitAt(b, oldCcr, 0);
  const newEnable = boolBitAt(b, newCcr, 0);

  b.if(boolAnd(b, b.not(oldEnable), newEnable), (start) =>
    startChannel(asBody(start), controller, local),
  );
  b.if(boolAnd(b, oldEnable, b.not(newEnable)), (stop) =>
    stopChannel(asBody(stop), controller, local),
  );
}

export function writeDma(
  b: Body,
  controller: DmaController,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  b.if(b.lessThan(offset, num(b, DMA_SIZE)), (inWindow) => {
    const window = asBody(inWindow);

    window.if(
      window.equal(types.number, wordOffset, num(window, IFCR)),
      (ifcr) => {
        const body = asBody(ifcr);
        const clears = body.bitAnd(u32(body, value), num(body, 0x00ffffff));
        const current = load(body, controller.stateBase, ISR);

        store(body, controller.stateBase, ISR, body.bitAnd(current, body.bitNot(clears)));
      },
      (other) => {
        const body = asBody(other);

        body.if(
          body.equal(types.number, wordOffset, num(body, ISR)),
          () => {},
          (register) => {
            const scope = asBody(register);

            scope.if(
              boolAnd(
                scope,
                scope.greaterThanOrEqual(wordOffset, num(scope, CHANNEL_BASE)),
                scope.lessThanOrEqual(wordOffset, num(scope, CHANNEL_LAST)),
              ),
              (channel) => {
                const body2 = asBody(channel);
                const { local, register: reg, reserved } = guestChannel(body2, wordOffset);

                body2.if(body2.not(reserved), (valid) => {
                  const body3 = asBody(valid);
                  const current = loadAt(body3, controller.stateBase, wordOffset);
                  const merged = merge(body3, current, value, offset, size);
                  const masked = body3.select(
                    types.number,
                    body3.equal(types.number, reg, num(body3, CCR)),
                    (inner) => inner.bitAnd(merged, inner.constant(types.number, CCR_MASK)),
                    (inner) =>
                      inner.select(
                        types.number,
                        inner.equal(types.number, reg, inner.constant(types.number, CNDTR)),
                        (inner2) =>
                          inner2.bitAnd(merged, inner2.constant(types.number, CNDTR_MASK)),
                        () => merged,
                      ),
                  );

                  storeAt(body3, controller.stateBase, wordOffset, masked);
                  body3.if(body3.equal(types.number, reg, num(body3, CCR)), (ccr) => {
                    handleCcr(asBody(ccr), controller, local, current, masked);
                  });
                });
              },
            );
          },
        );
      },
    );
  });
}

function busReadSized(
  b: Body,
  bus: DmaBus,
  address: Value<number>,
  size: Value<number>,
): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, size, num(b, 1)),
    (byte) => byte.setLocal(result, bus.read(asBody(byte), address, 1)),
    (wide) => {
      const body = asBody(wide);

      body.if(
        body.equal(types.number, size, num(body, 2)),
        (half) => half.setLocal(result, bus.read(asBody(half), address, 2)),
        (word) => word.setLocal(result, bus.read(asBody(word), address, 4)),
      );
    },
  );

  return b.getLocal(result);
}

function busWriteSized(
  b: Body,
  bus: DmaBus,
  address: Value<number>,
  size: Value<number>,
  value: Value<number>,
): void {
  b.if(
    b.equal(types.number, size, num(b, 1)),
    (byte) => bus.write(asBody(byte), address, 1, value),
    (wide) => {
      const body = asBody(wide);

      body.if(
        body.equal(types.number, size, num(body, 2)),
        (half) => bus.write(asBody(half), address, 2, value),
        (word) => bus.write(asBody(word), address, 4, value),
      );
    },
  );
}

function busValidSized(
  b: Body,
  bus: DmaBus,
  address: Value<number>,
  size: Value<number>,
  access: 'read' | 'write',
): Value<boolean> {
  const validate = bus.valid;

  if (validate === undefined) return bool(b, true);

  const result = b.local(types.bool, true);

  b.if(
    b.equal(types.number, size, num(b, 1)),
    (byte) => byte.setLocal(result, validate(asBody(byte), address, 1, access)),
    (wide) => {
      const body = asBody(wide);

      body.if(
        body.equal(types.number, size, num(body, 2)),
        (half) => half.setLocal(result, validate(asBody(half), address, 2, access)),
        (word) => word.setLocal(result, validate(asBody(word), address, 4, access)),
      );
    },
  );

  return b.getLocal(result);
}

function sizeValue(b: Body, field: Value<number>): Value<number> {
  return b.shiftLeft(num(b, 1), field);
}

function maskForSize(b: Body, size: Value<number>): Value<number> {
  return b.select(
    types.number,
    b.equal(types.number, size, num(b, 1)),
    (inner) => inner.constant(types.number, 0xff),
    (inner) =>
      inner.select(
        types.number,
        inner.equal(types.number, size, inner.constant(types.number, 2)),
        (inner2) => inner2.constant(types.number, 0xffff),
        (inner2) => inner2.constant(types.number, 0xffffffff),
      ),
  );
}

function readRequestData(
  b: Body,
  runtime: DmaRuntime,
  requestId: Value<number>,
  context: DmaRequestContext,
  address: Value<number>,
  size: Value<number>,
): Value<number> {
  const result = b.local(types.number, 0);
  const handled = b.local(types.bool, false);

  for (const source of runtime.requests) {
    const read = source.read;

    if (read === undefined) continue;
    b.if(b.equal(types.number, requestId, num(b, source.id)), (hit) => {
      const body = asBody(hit);

      body.setLocal(result, read(body, context));
      body.setLocal(handled, body.constant(types.bool, true));
    });
  }

  b.if(b.not(b.getLocal(handled)), (fallback) => {
    fallback.setLocal(result, busReadSized(asBody(fallback), runtime.bus, address, size));
  });

  return b.getLocal(result);
}

function writeRequestData(
  b: Body,
  runtime: DmaRuntime,
  requestId: Value<number>,
  context: DmaRequestContext,
  address: Value<number>,
  size: Value<number>,
  value: Value<number>,
): void {
  const handled = b.local(types.bool, false);

  for (const source of runtime.requests) {
    const write = source.write;

    if (write === undefined) continue;
    b.if(b.equal(types.number, requestId, num(b, source.id)), (hit) => {
      const body = asBody(hit);

      write(body, context, value);
      body.setLocal(handled, body.constant(types.bool, true));
    });
  }

  b.if(b.not(b.getLocal(handled)), (fallback) => {
    busWriteSized(asBody(fallback), runtime.bus, address, size, value);
  });
}

function transferError(b: Body, controller: DmaController, local: Value<number>): void {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));

  setFlag(b, controller, local, FLAG_GIF | FLAG_TE);
  storeAt(
    b,
    controller.stateBase,
    guestRegisterOffsetAt(b, local, CCR),
    b.bitAnd(ccr, num(b, ~1)),
  );
  stopChannel(b, controller, local);
}

function finishRegular(b: Body, controller: DmaController, local: Value<number>): void {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));

  storeAt(
    b,
    controller.stateBase,
    guestRegisterOffsetAt(b, local, CCR),
    b.bitAnd(ccr, num(b, ~1)),
  );
  stopChannel(b, controller, local);
}

function resetCircular(b: Body, controller: DmaController, local: Value<number>): void {
  storeAt(
    b,
    controller.stateBase,
    guestRegisterOffsetAt(b, local, CNDTR),
    loadAt(b, controller.stateBase, shadowOffsetAt(b, local, 0)),
  );
  storeAt(
    b,
    controller.stateBase,
    guestRegisterOffsetAt(b, local, CPAR),
    loadAt(b, controller.stateBase, shadowOffsetAt(b, local, 4)),
  );
  storeAt(
    b,
    controller.stateBase,
    guestRegisterOffsetAt(b, local, CMAR),
    loadAt(b, controller.stateBase, shadowOffsetAt(b, local, 8)),
  );
}

function completeItem(b: Body, controller: DmaController, local: Value<number>): void {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));
  const count = b.bitAnd(
    loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CNDTR)),
    num(b, CNDTR_MASK),
  );
  const baseCount = b.bitAnd(
    loadAt(b, controller.stateBase, shadowOffsetAt(b, local, 0)),
    num(b, CNDTR_MASK),
  );
  const circular = boolBitAt(b, ccr, 5);

  b.if(
    b.equal(types.number, count, num(b, 0)),
    (complete) => {
      const body = asBody(complete);

      setFlag(body, controller, local, FLAG_GIF | FLAG_TC);
      body.if(circular, (again) => resetCircular(asBody(again), controller, local), (done) =>
        finishRegular(asBody(done), controller, local),
      );
    },
    (partial) => {
      const body = asBody(partial);
      const half = body.floor(body.divide(baseCount, num(body, 2)));

      body.if(
        boolAnd(
          body,
          body.greaterThan(baseCount, num(body, 1)),
          body.equal(types.number, count, half),
        ),
        (hit) => setFlag(asBody(hit), controller, local, FLAG_GIF | FLAG_HT),
      );
    },
  );
}

function writeAddress(
  b: Body,
  controller: DmaController,
  local: Value<number>,
  usePar: Value<boolean>,
  address: Value<number>,
  increment: Value<boolean>,
  size: Value<number>,
): void {
  b.if(increment, (inc) => {
    const body = asBody(inc);
    const updated = body.add(address, size);
    const parAt = guestRegisterOffsetAt(body, local, CPAR);
    const marAt = guestRegisterOffsetAt(body, local, CMAR);

    body.if(usePar, (par) => {
      storeAt(asBody(par), controller.stateBase, parAt, updated);
    });
    body.if(body.not(usePar), (mar) => {
      storeAt(asBody(mar), controller.stateBase, marAt, updated);
    });
  });
}

function requestReady(
  b: Body,
  controller: DmaController,
  local: Value<number>,
  runtime: DmaRuntime,
): Value<boolean> {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));
  const global = b.add(local, num(b, controller.index === 1 ? 0 : 6));
  const context: DmaRequestContext = {
    controller,
    channel: b.add(local, num(b, 1)),
    globalChannel: global,
  };
  const requestId = dmamuxRequestId(b, global);
  const mem2mem = boolBitAt(b, ccr, 14);
  const ready = b.local(types.bool, false);

  b.if(mem2mem, (memory) => memory.setLocal(ready, memory.constant(types.bool, true)));
  b.if(boolAnd(b, b.not(mem2mem), b.equal(types.number, requestId, num(b, 0))), (software) => {
    asBody(software).setLocal(ready, software.constant(types.bool, true));
  });

  for (const source of runtime.requests) {
    b.if(
      boolAnd(b, b.not(mem2mem), b.equal(types.number, requestId, num(b, source.id))),
      (hit) => {
        const body = asBody(hit);

        body.setLocal(ready, source.ready(body, context));
      },
    );
  }

  return b.getLocal(ready);
}

function transferChannel(
  b: Body,
  controller: DmaController,
  local: Value<number>,
  runtime: DmaRuntime,
): void {
  const ccr = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CCR));
  const cndtr = b.bitAnd(
    loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CNDTR)),
    num(b, CNDTR_MASK),
  );
  const cpar = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CPAR));
  const cmar = loadAt(b, controller.stateBase, guestRegisterOffsetAt(b, local, CMAR));
  const global = b.add(local, num(b, controller.index === 1 ? 0 : 6));
  const context: DmaRequestContext = {
    controller,
    channel: b.add(local, num(b, 1)),
    globalChannel: global,
  };
  const requestId = dmamuxRequestId(b, global);
  const mem2mem = boolBitAt(b, ccr, 14);
  const direction = boolBitAt(b, ccr, 4);
  const ready = requestReady(b, controller, local, runtime);

  b.if(ready, (transfer) => {
    const body = asBody(transfer);
    const sourceCpar = boolOr(body, mem2mem, body.not(direction));
    const sourceIsPeripheral = boolAnd(body, body.not(mem2mem), body.not(direction));
    const destIsPeripheral = boolAnd(body, body.not(mem2mem), direction);
    const sourceAddress = body.select(types.number, sourceCpar, () => cpar, () => cmar);
    const destAddress = body.select(types.number, sourceCpar, () => cmar, () => cpar);
    const psize = body.bitAnd(body.shiftRightUnsigned(ccr, num(body, 8)), num(body, 3));
    const msize = body.bitAnd(body.shiftRightUnsigned(ccr, num(body, 10)), num(body, 3));
    const sourceField = body.select(types.number, sourceCpar, () => psize, () => msize);
    const destField = body.select(types.number, sourceCpar, () => msize, () => psize);
    const sourceSize = sizeValue(body, sourceField);
    const destSize = sizeValue(body, destField);

    body.if(
      boolOr(
        body,
        body.greaterThan(sourceField, num(body, 2)),
        body.greaterThan(destField, num(body, 2)),
      ),
      (invalid) => transferError(asBody(invalid), controller, local),
      (valid) => {
        const scope = asBody(valid);
        const sourceOk = busValidSized(scope, runtime.bus, sourceAddress, sourceSize, 'read');
        const destOk = busValidSized(scope, runtime.bus, destAddress, destSize, 'write');

        scope.if(
          boolAnd(scope, sourceOk, destOk),
          (ok) => {
            const body2 = asBody(ok);
            const raw = sourceIsPeripheral
              ? readRequestData(
                  body2,
                  runtime,
                  requestId,
                  context,
                  sourceAddress,
                  sourceSize,
                )
              : busReadSized(body2, runtime.bus, sourceAddress, sourceSize);
            const data = body2.bitAnd(raw, maskForSize(body2, destSize));

            if (destIsPeripheral) {
              writeRequestData(
                body2,
                runtime,
                requestId,
                context,
                destAddress,
                destSize,
                data,
              );
            } else {
              busWriteSized(body2, runtime.bus, destAddress, destSize, data);
            }

            const pinc = boolBitAt(body2, ccr, 6);
            const minc = boolBitAt(body2, ccr, 7);
            const sourceIncrement = body2.select(
              types.bool,
              sourceIsPeripheral,
              () => pinc,
              () => minc,
            );
            const destIncrement = body2.select(
              types.bool,
              destIsPeripheral,
              () => pinc,
              () => minc,
            );

            writeAddress(
              body2,
              controller,
              local,
              sourceCpar,
              sourceAddress,
              sourceIncrement,
              sourceSize,
            );
            writeAddress(
              body2,
              controller,
              local,
              body2.not(sourceCpar),
              destAddress,
              destIncrement,
              destSize,
            );
            storeAt(
              body2,
              controller.stateBase,
              guestRegisterOffsetAt(body2, local, CNDTR),
              body2.subtract(cndtr, num(body2, 1)),
            );
            completeItem(body2, controller, local);
          },
          (failed) => transferError(asBody(failed), controller, local),
        );
      },
    );
  });
}

/** 每个 tick、每个控制器按 PL 选一个通道；同优先级按通道号小者优先。 */
export function advanceDma(b: Body, elapsedPs: Value<number>, runtime: DmaRuntime): void {
  b.if(b.greaterThan(elapsedPs, num(b, 0)), (elapsed) => {
    const body = asBody(elapsed);
    const best1 = body.local(types.number, -1);
    const best2 = body.local(types.number, -1);
    const priority1 = body.local(types.number, -1);
    const priority2 = body.local(types.number, -1);
    const channel = body.local(types.number, 0);
    const busy = busyWord(body);
    const one = body.constant(types.number, 1);

    body.while(
      (test) =>
        test.lessThan(
          test.getLocal(channel),
          test.constant(types.number, DMA_CHANNEL_COUNT),
        ),
      (loop) => {
        const scope = asBody(loop);
        const current = scope.getLocal(channel);
        const bit = scope.shiftLeft(one, current);

        scope.if(
          scope.notEqual(types.number, scope.bitAnd(busy, bit), num(scope, 0)),
          (busyChannel) => {
            const hit = asBody(busyChannel);
            const local = hit.select(
              types.number,
              hit.lessThan(current, num(hit, 6)),
              () => current,
              (inner) => inner.subtract(current, inner.constant(types.number, 6)),
            );

            hit.if(hit.lessThan(current, num(hit, 6)), (first) => {
              const body2 = asBody(first);
              const ccr = loadAt(
                body2,
                DMA_CONTROLLERS[0]!.stateBase,
                guestRegisterOffsetAt(body2, local, CCR),
              );
              const level = body2.bitAnd(
                body2.shiftRightUnsigned(ccr, num(body2, 12)),
                num(body2, 3),
              );

              const ready = requestReady(body2, DMA_CONTROLLERS[0]!, local, runtime);

              body2.if(
                boolAnd(body2, ready, body2.greaterThan(level, body2.getLocal(priority1))),
                (better) => {
                  const inner = asBody(better);

                  inner.setLocal(best1, local);
                  inner.setLocal(priority1, level);
                },
              );
            });
            hit.if(hit.greaterThanOrEqual(current, num(hit, 6)), (second) => {
              const body2 = asBody(second);
              const ccr = loadAt(
                body2,
                DMA_CONTROLLERS[1]!.stateBase,
                guestRegisterOffsetAt(body2, local, CCR),
              );
              const level = body2.bitAnd(
                body2.shiftRightUnsigned(ccr, num(body2, 12)),
                num(body2, 3),
              );

              const ready = requestReady(body2, DMA_CONTROLLERS[1]!, local, runtime);

              body2.if(
                boolAnd(body2, ready, body2.greaterThan(level, body2.getLocal(priority2))),
                (better) => {
                  const inner = asBody(better);

                  inner.setLocal(best2, local);
                  inner.setLocal(priority2, level);
                },
              );
            });
          },
        );
        scope.setLocal(channel, scope.add(scope.getLocal(channel), one));
      },
    );

    body.if(body.greaterThanOrEqual(body.getLocal(best1), num(body, 0)), (first) => {
      const scope = asBody(first);

      transferChannel(scope, DMA_CONTROLLERS[0]!, scope.getLocal(best1), runtime);
    });
    body.if(body.greaterThanOrEqual(body.getLocal(best2), num(body, 0)), (second) => {
      const scope = asBody(second);

      transferChannel(scope, DMA_CONTROLLERS[1]!, scope.getLocal(best2), runtime);
    });
    syncDmaActivity(body);
  });
}

/** 任一 DMA 通道忙；中央 tick 据此把服务粒度收到 DMA_ITEM_PS。 */
export function dmaActive(b: Body): Value<boolean> {
  return b.notEqual(types.number, busyWord(b), num(b, 0));
}

export function dmaChannelPending(
  b: Body,
  controller: DmaController,
  channel: number,
): Value<boolean> {
  const ccr = load(b, controller.stateBase, guestRegisterOffset(channel - 1, CCR));
  const isr = load(b, controller.stateBase, ISR);
  const shift = (channel - 1) * 4;

  return boolOr(
    b,
    boolAnd(b, boolBitAt(b, ccr, 1), boolBitAt(b, isr, shift + 1)),
    boolOr(
      b,
      boolAnd(b, boolBitAt(b, ccr, 2), boolBitAt(b, isr, shift + 2)),
      boolAnd(b, boolBitAt(b, ccr, 3), boolBitAt(b, isr, shift + 3)),
    ),
  );
}

/** 绝对地址入口；DMA1 与 DMA2 各 0x400，总线只会把对应区间的访问送到这里。 */
export function readDmaAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  const result = b.local(types.number, 0);

  b.if(b.lessThan(address, num(b, DMA2_BASE)), (first) => {
    const body = asBody(first);

    first.setLocal(
      result,
      readDma(body, DMA_CONTROLLERS[0]!, body.subtract(address, num(body, DMA1_BASE)), size),
    );
  });
  b.if(b.greaterThanOrEqual(address, num(b, DMA2_BASE)), (second) => {
    const body = asBody(second);

    second.setLocal(
      result,
      readDma(body, DMA_CONTROLLERS[1]!, body.subtract(address, num(body, DMA2_BASE)), size),
    );
  });

  return b.getLocal(result);
}

export function writeDmaAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.if(b.lessThan(address, num(b, DMA2_BASE)), (first) => {
    const body = asBody(first);

    writeDma(
      body,
      DMA_CONTROLLERS[0]!,
      body.subtract(address, num(body, DMA1_BASE)),
      size,
      value,
    );
  });
  b.if(b.greaterThanOrEqual(address, num(b, DMA2_BASE)), (second) => {
    const body = asBody(second);

    writeDma(
      body,
      DMA_CONTROLLERS[1]!,
      body.subtract(address, num(body, DMA2_BASE)),
      size,
      value,
    );
  });
}

/**
 * 中央 `PeripheralModule` 工厂。运行时注入真实总线与请求表，DMA 核心本身不 import
 * 任何外设模块。时间行为使用 `PeripheralSlot.Dma`。
 */
export function dmaChannelIrq(controller: DmaController, channel: number): number {
  if (controller.index === 1) return 11 + channel - 1;
  if (channel === 6) return 97;

  return 56 + channel - 1;
}

export function createDmaModule(runtime: DmaRuntime): PeripheralModule {
  const interrupts = [];

  for (const controller of DMA_CONTROLLERS) {
    for (let channel = 1; channel <= DMA_CHANNELS; channel += 1) {
      interrupts.push({
        exception: dmaChannelIrq(controller, channel) + 16,
        pending: (b: Body) => dmaChannelPending(b, controller, channel),
        acknowledge: () => {},
      });
    }
  }

  return {
    id: 'dma',
    ranges: [
      { base: DMA1_BASE, size: 0x400 },
      { base: DMA2_BASE, size: 0x400 },
    ],
    read: readDmaAddress,
    write: writeDmaAddress,
    slot: PeripheralSlot.Dma,
    advance: (b, elapsedPs) => advanceDma(b, elapsedPs, runtime),
    interrupts,
  };
}

export function clearDmaFlags(
  b: Body,
  controller: DmaController,
  channel: number,
  flags: number,
): void {
  const current = load(b, controller.stateBase, ISR);
  const mask = flags << ((channel - 1) * 4);

  store(b, controller.stateBase, ISR, b.bitAnd(current, num(b, ~mask)));
}

export { IFCR as DMA_IFCR, ISR as DMA_ISR };
