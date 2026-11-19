import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  USB_PMA_BASE,
  USB_PMA_SIZE,
  USB_REGISTER_SIZE,
  USB_MEMORY_SIZE,
  USB_PMA_OFFSET,
  USB_FRAME_TIMER,
  USB_FRAME_PS,
  USB_FRAME_MASK,
  USB_EP_COUNT,
  USB_EP_STRIDE,
  USB_CNTR,
  USB_ISTR,
  USB_FNR,
  USB_DADDR,
  USB_BTABLE,
  USB_LPMCSR,
  USB_BCDR,
  USB_CNTR_LPMODE,
  USB_CNTR_PDWN,
  USB_CNTR_FRES,
  USB_ISTR_CTR,
  USB_ISTR_WKUP,
  USB_ISTR_SUSP,
  USB_ISTR_RESET,
  USB_ISTR_SOF,
  USB_EP_CTR_RX,
  USB_EP_DTOG_RX,
  USB_EP_STAT_RX,
  USB_EP_SETUP,
  USB_EP_TYPE,
  USB_EP_KIND,
  USB_EP_CTR_TX,
  USB_EP_DTOG_TX,
  USB_EP_STAT_TX,
  USB_EP_EA,
  USB_EP_TYPE_BULK,
  USB_EP_TYPE_CONTROL,
  USB_EP_TYPE_ISO,
  USB_STAT_DISABLED,
  USB_STAT_STALL,
  USB_STAT_NAK,
  USB_BCDR_DPPU,
} from './usb-layout';
import { IRQ_DIRTY, SERVICE_IRQ, USB, USB_BASE, PeripheralSlot } from './layout';
import type { PeripheralModule } from './peripheral';
import {
  activatePeripheralSlot,
  deactivatePeripheralSlot,
  setPeripheralDeadline,
} from './peripheral';
import {
  asBody,
  bool,
  boolAnd,
  boolBitAt,
  boolOr,
  markService,
  num,
  readByte,
  readHalf,
  readWord,
  readWordAt,
  syncIrqService,
  u32,
  writeByte,
  writeHalf,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { refreshTick } from './tick';

/**
 * STM32G431 USB FS device controller 的 transaction-level 模型。
 *
 * 这里不是 USB host/OTG，也不是 12 Mbps 的 bit-level PHY。固件仍然通过真实的
 * USB_EPnR / USB_CNTR / USB_ISTR / USB_DADDR / USB_BTABLE / PMA 访问控制器；
 * 外部虚拟 host 通过 `usbHost*` 注入 reset/SETUP/OUT/IN/SOF 事务，读取真实的 PMA
 * 数据和端点状态。控制器不包含设备描述符、类请求或枚举策略，全部由固件提供。
 *
 * 支持子集（详见 core/docs/usb.md）：
 * - 8 个单缓冲端点寄存器，CTR_RX/TX、DTOG_RX/TX、STAT_RX/TX、SETUP、EA；
 * - 1 KiB PMA、BTABLE/ADDR/COUNT 缓冲描述符；
 * - EP0 control SETUP/DATA IN/OUT/status，bulk/interrupt 单缓冲收发；
 * - USB reset、suspend/resume、SOF 基础事件，IRQ19/20/42；
 * - 事务级 ACK/NAK/STALL/TIMEOUT。
 *
 * 未支持：isochronous、double-buffer、LPM、BCD、remote wakeup、设备主动 resume、
 * bit-stuffing/NRZI/CRC 物理层时序、精确 3 ms suspend 计时、全部 8 端点高级特性。
 */

const USB_SLOT = PeripheralSlot.Usb;
const FRAME_PS = USB_FRAME_PS;

const CORE_IRQ_LP = 16 + 20;
const CORE_IRQ_HP = 16 + 19;
const CORE_IRQ_WAKEUP = 16 + 42;

const EP_OFFSET = (index: number): number => index * USB_EP_STRIDE;

const inRange = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

function merge16(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 2 || size === 4) return b.bitAnd(value, num(b, 0xffff));
  const shift = b.multiply(b.bitAnd(offset, num(b, 1)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(value, num(b, 0xff)), shift);

  return b.bitOr(b.bitAnd(current, b.bitNot(b.shiftLeft(num(b, 0xff), shift))), placed);
}

/** 16 位寄存器按字节/半字/字读取；字访问的高 16 位是保留区，读 0。 */
function extract16(
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 2 || size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 1)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, 0xff));
}

function readHalfAt(b: Body, offset: number): Value<number> {
  return readHalf(b, USB, num(b, offset));
}

function writeHalfAt(b: Body, offset: number, value: Value<number>): void {
  writeHalf(b, USB, num(b, offset), b.bitAnd(value, num(b, 0xffff)));
}

function readEp(b: Body, index: number): Value<number> {
  return readHalfAt(b, EP_OFFSET(index));
}

function readEpDynamic(b: Body, index: Value<number>): Value<number> {
  return readHalf(b, USB, b.shiftLeft(index, num(b, 2)));
}

function writeEpDynamic(
  b: Body,
  index: Value<number>,
  value: Value<number>,
  writeMask: Value<number>,
): void {
  const at = b.shiftLeft(index, num(b, 2));
  const current = readHalf(b, USB, at);
  const outside = b.bitAnd(current, b.bitNot(writeMask));
  const ctrMask = b.bitAnd(num(b, USB_EP_CTR_RX | USB_EP_CTR_TX), writeMask);
  const ctr = b.bitAnd(b.bitAnd(current, value), ctrMask);
  const toggleMask = b.bitAnd(
    num(b, USB_EP_DTOG_RX | USB_EP_STAT_RX | USB_EP_DTOG_TX | USB_EP_STAT_TX),
    writeMask,
  );
  const toggled = b.bitAnd(
    b.bitXor(current, b.bitAnd(value, toggleMask)),
    toggleMask,
  );
  const setup = b.bitAnd(current, num(b, USB_EP_SETUP));
  const configMask = b.bitAnd(num(b, USB_EP_TYPE | USB_EP_KIND | USB_EP_EA), writeMask);
  const config = b.bitOr(
    b.bitAnd(value, configMask),
    b.bitAnd(current, b.bitAnd(num(b, USB_EP_TYPE | USB_EP_KIND | USB_EP_EA), b.bitNot(writeMask))),
  );
  const next = b.bitOr(b.bitOr(outside, ctr), b.bitOr(toggled, b.bitOr(setup, config)));

  writeHalf(b, USB, at, next);
  updateCtrSummary(b);
}

/**
 * USB_EPnR 的写语义：CTR_RX/CTR_TX 写 0 清除、写 1 保持；DTOG_RX/TX 与
 * STAT_RX/TX 写 1 翻转、写 0 保持；SETUP 只读；其余字段正常写入。
 */

function readRegister(b: Body, offset: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);
  const even = b.bitAnd(offset, num(b, 0xfffe));

  // EP0R..EP7R 在 0x00..0x1F；每个占 4 字节槽，低 16 位有效。
  b.if(
    boolAnd(
      b,
      b.lessThan(offset, num(b, 0x20)),
      b.equal(types.number, b.bitAnd(offset, num(b, 2)), num(b, 0)),
    ),
    (hit) => {
      const body = asBody(hit);
      const index = body.shiftRightUnsigned(offset, num(body, 2));

      body.if(body.lessThan(index, num(body, USB_EP_COUNT)), (valid) => {
        const scope = asBody(valid);

        scope.setLocal(result, extract16(scope, readEpDynamic(scope, index), offset, size));
      });
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, even, num(body, USB_CNTR)),
        (cntr) =>
          cntr.setLocal(
            result,
            extract16(asBody(cntr), readHalfAt(asBody(cntr), USB_CNTR), offset, size),
          ),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, even, num(scope, USB_ISTR)),
            (istr) =>
              istr.setLocal(
                result,
                extract16(asBody(istr), readHalfAt(asBody(istr), USB_ISTR), offset, size),
              ),
            (afterIstr) => {
              const body2 = asBody(afterIstr);

              body2.if(
                body2.equal(types.number, even, num(body2, USB_FNR)),
                (fnr) =>
                  fnr.setLocal(
                    result,
                    extract16(asBody(fnr), readHalfAt(asBody(fnr), USB_FNR), offset, size),
                  ),
                (afterFnr) => {
                  const body3 = asBody(afterFnr);

                  body3.if(
                    body3.equal(types.number, even, num(body3, USB_DADDR)),
                    (daddr) =>
                      daddr.setLocal(
                        result,
                        extract16(
                          asBody(daddr),
                          readHalfAt(asBody(daddr), USB_DADDR),
                          offset,
                          size,
                        ),
                      ),
                    (afterDaddr) => {
                      const body4 = asBody(afterDaddr);

                      body4.if(
                        body4.equal(types.number, even, num(body4, USB_BTABLE)),
                        (btable) =>
                          btable.setLocal(
                            result,
                            extract16(
                              asBody(btable),
                              readHalfAt(asBody(btable), USB_BTABLE),
                              offset,
                              size,
                            ),
                          ),
                        (afterBtable) => {
                          const body5 = asBody(afterBtable);

                          body5.if(
                            body5.equal(types.number, even, num(body5, USB_LPMCSR)),
                            (lpm) =>
                              lpm.setLocal(
                                result,
                                extract16(
                                  asBody(lpm),
                                  readHalfAt(asBody(lpm), USB_LPMCSR),
                                  offset,
                                  size,
                                ),
                              ),
                            (afterLpm) => {
                              const body6 = asBody(afterLpm);

                              body6.if(
                                body6.equal(types.number, even, num(body6, USB_BCDR)),
                                (bcdr) =>
                                  bcdr.setLocal(
                                    result,
                                    extract16(
                                      asBody(bcdr),
                                      readHalfAt(asBody(bcdr), USB_BCDR),
                                      offset,
                                      size,
                                    ),
                                  ),
                              );
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
        },
      );
    },
  );

  return b.getLocal(result);
}

function writeRegister(
  b: Body,
  address: Value<number>,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const even = b.bitAnd(offset, num(b, 0xfffe));

  b.if(
    boolAnd(
      b,
      b.lessThan(offset, num(b, 0x20)),
      b.equal(types.number, b.bitAnd(offset, num(b, 2)), num(b, 0)),
    ),
    (hit) => {
      const body = asBody(hit);
      const index = body.shiftRightUnsigned(offset, num(body, 2));
      const shift = body.multiply(body.bitAnd(offset, num(body, 1)), num(body, 8));
      const mask =
        size === 1 ? body.shiftLeft(num(body, 0xff), shift) : num(body, 0xffff);
      const placed =
        size === 1 ? body.shiftLeft(body.bitAnd(value, num(body, 0xff)), shift) : value;

      body.if(body.lessThan(index, num(body, USB_EP_COUNT)), (valid) => {
        const scope = asBody(valid);

        writeEpDynamic(scope, index, placed, mask);
      });
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, even, num(body, USB_CNTR)),
        (cntr) => {
          const scope = asBody(cntr);
          const next = merge16(scope, readHalfAt(scope, USB_CNTR), value, offset, size);

          writeHalfAt(scope, USB_CNTR, next);
          scope.if(boolBitAt(scope, next, 0), (reset) => applyUsbReset(asBody(reset)));
          syncUsbSlot(scope);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, even, num(scope, USB_ISTR)),
            (istr) => {
              const body2 = asBody(istr);
              const current = readHalfAt(body2, USB_ISTR);
              const shift = body2.multiply(body2.bitAnd(offset, num(body2, 1)), num(body2, 8));
              const mask =
                size === 1
                  ? body2.shiftLeft(num(body2, 0xff), shift)
                  : num(body2, 0xffff);
              const placed =
                size === 1
                  ? body2.shiftLeft(body2.bitAnd(value, num(body2, 0xff)), shift)
                  : value;
              const eventMask = body2.bitAnd(num(body2, 0x7f80), mask);
              // 只处理本次写入 lane 的事件位：写 0 清除、写 1 保持；其余 lane 与只读位保留。
              const next = body2.bitAnd(
                current,
                body2.bitOr(placed, body2.bitNot(eventMask)),
              );

              writeHalfAt(body2, USB_ISTR, next);
            },
            (afterIstr) => {
              const body2 = asBody(afterIstr);

              body2.if(
                body2.equal(types.number, even, num(body2, USB_FNR)),
                () => {},
                (afterFnr) => {
                  const body2 = asBody(afterFnr);

                  body2.if(
                    body2.equal(types.number, even, num(body2, USB_DADDR)),
                    (daddr) => {
                      const scope = asBody(daddr);
                      const merged = merge16(
                        scope,
                        readHalfAt(scope, USB_DADDR),
                        value,
                        offset,
                        size,
                      );

                      writeHalfAt(scope, USB_DADDR, scope.bitAnd(merged, num(scope, 0x00ff)));
                    },
                    (afterDaddr) => {
                      const body2 = asBody(afterDaddr);

                      body2.if(
                        body2.equal(types.number, even, num(body2, USB_BTABLE)),
                        (btable) => {
                          const scope = asBody(btable);
                          const merged = merge16(
                            scope,
                            readHalfAt(scope, USB_BTABLE),
                            value,
                            offset,
                            size,
                          );

                          writeHalfAt(scope, USB_BTABLE, scope.bitAnd(merged, num(scope, 0xfff8)));
                        },
                        (afterBtable) => {
                          const body2 = asBody(afterBtable);

                          body2.if(
                            body2.equal(types.number, even, num(body2, USB_LPMCSR)),
                            (lpm) => {
                              const scope = asBody(lpm);
                              const merged = merge16(
                                scope,
                                readHalfAt(scope, USB_LPMCSR),
                                value,
                                offset,
                                size,
                              );

                              writeHalfAt(
                                scope,
                                USB_LPMCSR,
                                scope.bitAnd(merged, num(scope, 0x00ff)),
                              );
                            },
                            (afterLpm) => {
                              const body2 = asBody(afterLpm);

                              body2.if(
                                body2.equal(types.number, even, num(body2, USB_BCDR)),
                                (bcdr) => {
                                  const scope = asBody(bcdr);
                                  const merged = merge16(
                                    scope,
                                    readHalfAt(scope, USB_BCDR),
                                    value,
                                    offset,
                                    size,
                                  );

                                  // 只实现 DPPU；BCD 检测位保持只读 0。
                                  writeHalfAt(
                                    scope,
                                    USB_BCDR,
                                    scope.bitAnd(merged, num(scope, USB_BCDR_DPPU)),
                                  );
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
            },
          );
        },
      );
    },
  );
}

function readPma(b: Body, offset: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);

  b.if(b.lessThan(offset, num(b, USB_PMA_SIZE)), (inside) => {
    const body = asBody(inside);
    const at = body.add(num(body, USB_PMA_OFFSET), offset);

    if (size === 1) {
      body.setLocal(result, readByte(body, USB, at));

      return;
    }

    if (size === 2) {
      body.setLocal(result, readHalf(body, USB, at));

      return;
    }

    body.setLocal(result, readWord(body, USB, at));
  });

  return b.getLocal(result);
}

function writePma(b: Body, offset: Value<number>, size: number, value: Value<number>): void {
  b.if(b.lessThan(offset, num(b, USB_PMA_SIZE)), (inside) => {
    const body = asBody(inside);
    const at = body.add(num(body, USB_PMA_OFFSET), offset);

    if (size === 1) {
      writeByte(body, USB, at, value);

      return;
    }

    if (size === 2) {
      writeHalf(body, USB, at, value);

      return;
    }

    writeWord(body, USB, at, value);
  });
}

export function readUsb(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);

  b.if(
    inRange(b, address, USB_BASE, USB_REGISTER_SIZE),
    (registers) => {
      const body = asBody(registers);

      body.setLocal(result, readRegister(body, body.subtract(address, num(body, USB_BASE)), size));
    },
    (memory) => {
      const body = asBody(memory);

      body.if(inRange(body, address, USB_PMA_BASE, USB_PMA_SIZE), (pma) => {
        const scope = asBody(pma);

        scope.setLocal(
          result,
          readPma(scope, scope.subtract(address, num(scope, USB_PMA_BASE)), size),
        );
      });
    },
  );

  return b.getLocal(result);
}

export function writeUsb(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.if(
    inRange(b, address, USB_BASE, USB_REGISTER_SIZE),
    (registers) => {
      const body = asBody(registers);

      writeRegister(body, address, body.subtract(address, num(body, USB_BASE)), size, value);
    },
    (memory) => {
      const body = asBody(memory);

      body.if(inRange(body, address, USB_PMA_BASE, USB_PMA_SIZE), (pma) => {
        const scope = asBody(pma);

        writePma(scope, scope.subtract(address, num(scope, USB_PMA_BASE)), size, value);
      });
    },
  );
}

/** 依据 CNTR 的 PDWN/FRES 决定是否让 USB 时间槽保持活跃。 */
function syncUsbSlot(b: Body): void {
  const cntr = readHalfAt(b, USB_CNTR);

  b.if(
    boolOr(b, boolBitAt(b, cntr, 0), boolBitAt(b, cntr, 1)),
    (off) => {
      const scope = asBody(off);

      deactivatePeripheralSlot(scope, USB_SLOT);
      refreshTick(scope);
    },
    (on) => {
      const scope = asBody(on);

      activatePeripheralSlot(scope, USB_SLOT, num(scope, FRAME_PS));
      refreshTick(scope);
    },
  );
}

function updateCtrSummary(b: Body): void {
  const found = b.local(types.number, 0);
  const epId = b.local(types.number, 0);
  const dir = b.local(types.number, 0);

  for (let index = 0; index < USB_EP_COUNT; index += 1) {
    const ep = readEp(b, index);

    b.if(
      boolAnd(
        b,
        b.equal(types.number, b.getLocal(found), num(b, 0)),
        b.notEqual(types.number, b.bitAnd(ep, num(b, 0x8080)), num(b, 0)),
      ),
      (hit) => {
        const body = asBody(hit);

        body.setLocal(found, num(body, 1));
        body.setLocal(epId, num(body, index));
        body.setLocal(dir, body.bitAnd(body.shiftRightUnsigned(ep, num(body, 15)), num(body, 1)));
      },
    );
  }

  const istr = readHalfAt(b, USB_ISTR);
  const base = b.bitAnd(istr, num(b, 0x7fe0));
  const status = b.local(types.number, base);

  b.if(b.notEqual(types.number, b.getLocal(found), num(b, 0)), (hit) => {
    const body = asBody(hit);

    body.setLocal(
      status,
      body.bitOr(
        body.getLocal(status),
        body.bitOr(
          num(body, USB_ISTR_CTR),
          body.bitOr(body.shiftLeft(body.getLocal(dir), num(body, 4)), body.getLocal(epId)),
        ),
      ),
    );
  });

  writeHalfAt(b, USB_ISTR, b.getLocal(status));
}

function applyUsbReset(b: Body): void {
  for (let index = 0; index < USB_EP_COUNT; index += 1) {
    const ep = readEp(b, index);

    // USB reset 保留 endpoint 的 CTR_RX/CTR_TX，防止刚完成的事务通知丢失。
    writeHalfAt(b, EP_OFFSET(index), b.bitAnd(ep, num(b, 0x8080)));
  }

  writeHalfAt(b, USB_DADDR, num(b, 0));
  writeHalfAt(b, USB_ISTR, num(b, USB_ISTR_RESET));
  writeHalfAt(b, USB_FNR, num(b, 0));
  writeWordAt(b, USB, USB_FRAME_TIMER, num(b, FRAME_PS));
  updateCtrSummary(b);
}

function highPriorityCtr(b: Body, istr: Value<number>): Value<boolean> {
  const ep = b.bitAnd(istr, num(b, 0x0f));
  const reg = readHalf(b, USB, b.shiftLeft(ep, num(b, 2)));
  const type = b.bitAnd(b.shiftRightUnsigned(reg, num(b, 9)), num(b, 3));
  const kind = b.bitAnd(b.shiftRightUnsigned(reg, num(b, 8)), num(b, 1));

  return boolOr(
    b,
    b.equal(types.number, type, num(b, USB_EP_TYPE_ISO)),
    boolAnd(
      b,
      b.equal(types.number, type, num(b, USB_EP_TYPE_BULK)),
      b.equal(types.number, kind, num(b, 1)),
    ),
  );
}

export function usbLowPending(b: Body): Value<boolean> {
  const istr = readHalfAt(b, USB_ISTR);
  const cntr = readHalfAt(b, USB_CNTR);
  const masked = b.bitAnd(istr, b.bitAnd(cntr, num(b, 0x7f80)));
  const ctr = boolBitAt(b, istr, 15);
  const high = highPriorityCtr(b, istr);

  return boolOr(b, b.notEqual(types.number, masked, num(b, 0)), boolAnd(b, ctr, b.not(high)));
}

export function usbHighPending(b: Body): Value<boolean> {
  const istr = readHalfAt(b, USB_ISTR);

  return boolAnd(b, boolBitAt(b, istr, 15), highPriorityCtr(b, istr));
}

export function usbWakePending(b: Body): Value<boolean> {
  return boolBitAt(b, readHalfAt(b, USB_ISTR), 12);
}

/** 事务级时间推进：1 ms 帧、SOF 标志、IRQ dirty。 */
export function advanceUsb(b: Body, elapsedPs: Value<number>): void {
  const cntr = readHalfAt(b, USB_CNTR);

  b.if(
    boolOr(b, boolBitAt(b, cntr, 0), boolBitAt(b, cntr, 1)),
    (off) => deactivatePeripheralSlot(asBody(off), USB_SLOT),
    (on) => {
      const body = asBody(on);
      const timer = readWordAt(body, USB, USB_FRAME_TIMER);
      const remaining = body.subtract(timer, elapsedPs);

      body.if(
        body.lessThanOrEqual(remaining, num(body, 0)),
        (expired) => {
          const scope = asBody(expired);
          const frame = scope.bitAnd(readHalfAt(scope, USB_FNR), num(scope, USB_FRAME_MASK));
          const next = scope.bitAnd(scope.add(frame, num(scope, 1)), num(scope, USB_FRAME_MASK));
          const istr = readHalfAt(scope, USB_ISTR);

          writeHalfAt(scope, USB_FNR, scope.bitOr(next, num(scope, 0x2000)));
          writeHalfAt(scope, USB_ISTR, scope.bitOr(istr, num(scope, USB_ISTR_SOF)));
          writeWordAt(scope, USB, USB_FRAME_TIMER, num(scope, FRAME_PS));
        },
        (next) => {
          writeWordAt(asBody(next), USB, USB_FRAME_TIMER, remaining);
        },
      );

      const irq = boolOr(
        body,
        usbLowPending(body),
        boolOr(body, usbHighPending(body), usbWakePending(body)),
      );

      body.if(irq, (dirty) => {
        const scope = asBody(dirty);

        scope.writeState(IRQ_DIRTY, bool(scope, true));
        markService(scope, SERVICE_IRQ);
        syncIrqService(scope);
      });

      const deadline = readWordAt(body, USB, USB_FRAME_TIMER);

      setPeripheralDeadline(
        body,
        USB_SLOT,
        body.select(
          types.number,
          body.greaterThan(deadline, num(body, 0)),
          () => deadline,
          (zero) => zero.constant(types.number, 1),
        ),
      );
    },
  );
}

export const USB_MODULE: PeripheralModule = {
  id: 'usb',
  ranges: [
    { base: USB_BASE, size: USB_REGISTER_SIZE },
    { base: USB_PMA_BASE, size: USB_PMA_SIZE },
  ],
  read: (b, address, size) => readUsb(b, address, size),
  write: (b, address, size, value) => writeUsb(b, address, size, value),
  slot: USB_SLOT,
  advance: (b, elapsedPs) => advanceUsb(b, elapsedPs),
  interrupts: [
    { exception: CORE_IRQ_HP, pendingIsPure: true, pending: usbHighPending, acknowledge: () => {} },
    { exception: CORE_IRQ_LP, pendingIsPure: true, pending: usbLowPending, acknowledge: () => {} },
    { exception: CORE_IRQ_WAKEUP, pendingIsPure: true, pending: usbWakePending, acknowledge: () => {} },
  ],
};

/* ------------------------------------------------------------------------- */
/* Host-side transaction API                                                  */
/* ------------------------------------------------------------------------- */

export type UsbHandshake = 'ACK' | 'NAK' | 'STALL' | 'TIMEOUT' | 'ERROR';
export type UsbDataHandshake = 'DATA0' | 'DATA1' | 'NAK' | 'STALL' | 'TIMEOUT' | 'ERROR';

export interface UsbOutResult {
  readonly handshake: UsbHandshake;
}

export interface UsbInResult {
  readonly handshake: UsbDataHandshake;
  readonly data?: Uint8Array;
}

const u16 = (usb: Uint8Array, offset: number): number =>
  (usb[offset] ?? 0) | ((usb[offset + 1] ?? 0) << 8);

const put16 = (usb: Uint8Array, offset: number, value: number): void => {
  usb[offset] = value & 0xff;
  usb[offset + 1] = (value >>> 8) & 0xff;
};

const pmaRead = (usb: Uint8Array, offset: number, size: number): Uint8Array => {
  const start = USB_PMA_OFFSET + (offset & ~1);
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = usb[start + index] ?? 0;

  return bytes;
};

const pmaWrite = (usb: Uint8Array, offset: number, data: Uint8Array): boolean => {
  const start = USB_PMA_OFFSET + offset;

  if ((offset & 1) !== 0 || start + data.length > USB_MEMORY_SIZE) return false;

  usb.set(data, start);

  // 奇数长度时清掉最后一个半字的高字节，保持 PMA 的 16 位语义。
  if ((data.length & 1) !== 0 && start + data.length < USB_MEMORY_SIZE)
    usb[start + data.length] = 0;

  return true;
};

const epAt = (usb: Uint8Array, index: number): number => u16(usb, EP_OFFSET(index));

const setEp = (usb: Uint8Array, index: number, value: number): void => {
  put16(usb, EP_OFFSET(index), value & 0xffff);
};

const epType = (ep: number): number => (ep >>> 9) & 3;
const epKind = (ep: number): number => (ep >>> 8) & 1;
const unsupportedEndpoint = (ep: number): boolean =>
  epType(ep) === USB_EP_TYPE_ISO || (epType(ep) === USB_EP_TYPE_BULK && epKind(ep) === 1);
const statRx = (ep: number): number => (ep >>> 12) & 3;
const statTx = (ep: number): number => (ep >>> 4) & 3;
const dtogRx = (ep: number): number => (ep >>> 14) & 1;
const dtogTx = (ep: number): number => (ep >>> 6) & 1;

const findEndpoint = (usb: Uint8Array, endpoint: number): number => {
  for (let index = 0; index < USB_EP_COUNT; index += 1)
    if ((epAt(usb, index) & USB_EP_EA) === (endpoint & 0x0f)) return index;

  return -1;
};

const deviceAddress = (usb: Uint8Array): number => {
  const daddr = u16(usb, USB_DADDR);

  return (daddr & 0x80) !== 0 ? daddr & 0x7f : -1;
};

const attached = (usb: Uint8Array): boolean =>
  (u16(usb, USB_BCDR) & USB_BCDR_DPPU) !== 0 &&
  (u16(usb, USB_CNTR) & (USB_CNTR_PDWN | USB_CNTR_FRES)) === 0;

const updateCtrSummaryJs = (usb: Uint8Array): void => {
  let found = -1;

  for (let index = 0; index < USB_EP_COUNT; index += 1) {
    const ep = epAt(usb, index);

    if ((ep & (USB_EP_CTR_RX | USB_EP_CTR_TX)) !== 0) {
      found = index;
      break;
    }
  }

  const istr = u16(usb, USB_ISTR);
  let next = istr & ~(USB_ISTR_CTR | 0x10 | 0x0f);

  if (found >= 0) {
    const ep = epAt(usb, found);

    next |= USB_ISTR_CTR | found;
    if ((ep & USB_EP_CTR_RX) !== 0) next |= 0x10;
  }

  put16(usb, USB_ISTR, next);
};

const resetJs = (usb: Uint8Array): void => {
  for (let index = 0; index < USB_EP_COUNT; index += 1)
    setEp(usb, index, epAt(usb, index) & (USB_EP_CTR_RX | USB_EP_CTR_TX));

  put16(usb, USB_DADDR, 0);
  put16(usb, USB_ISTR, USB_ISTR_RESET);
  put16(usb, USB_FNR, 0);
  put16(usb, USB_FRAME_TIMER, FRAME_PS & 0xffff);
  put16(usb, USB_FRAME_TIMER + 2, (FRAME_PS >>> 16) & 0xffff);
  updateCtrSummaryJs(usb);
};

const markCtr = (usb: Uint8Array, endpoint: number, dir: 0 | 1): void => {
  const istr = u16(usb, USB_ISTR) & ~(0x10 | 0x0f);

  put16(usb, USB_ISTR, istr | USB_ISTR_CTR | (dir << 4) | (endpoint & 0x0f));
};

const buffer = (
  usb: Uint8Array,
  endpoint: number,
): {
  readonly txAddr: number;
  readonly txCount: number;
  readonly rxAddr: number;
  readonly rxCount: number;
  readonly rxSize: number;
} => {
  const table = USB_PMA_OFFSET + (u16(usb, USB_BTABLE) & 0xfff8);
  const at = table + endpoint * 8;
  const rxCount = u16(usb, at + 6);
  const blockSize = (rxCount & 0x8000) !== 0;
  const blocks = (rxCount >>> 10) & 0x1f;
  const rxSize = blockSize ? (blocks === 0 ? 32 : blocks * 32) : blocks * 2;

  return {
    txAddr: u16(usb, at) & 0xfffe,
    txCount: u16(usb, at + 2) & 0x03ff,
    rxAddr: u16(usb, at + 4) & 0xfffe,
    rxCount,
    rxSize,
  };
};

/** 初始化 `usb` memory 到复位值；中央资源层应在实例创建时调用一次。 */
export function initUsbMemory(usb: Uint8Array | undefined): boolean {
  // 中央的 DeviceContext.memory 是 ReadonlyBytes 快照；它不能用于初始化。
  // 只有实例内部的可变 Uint8Array 才能写入。返回 false 让调用方选择 DDL/实例路径。
  if (usb === undefined || typeof usb.length !== 'number' || typeof usb.set !== 'function')
    return false;
  if (usb.length < USB_MEMORY_SIZE)
    throw new Error(
      `usb: memory must be at least 0x${USB_MEMORY_SIZE.toString(16)} bytes, got 0x${usb.length.toString(16)}`,
    );

  usb.fill(0);
  put16(usb, USB_CNTR, USB_CNTR_PDWN | USB_CNTR_FRES);
  put16(usb, USB_DADDR, 0);
  put16(usb, USB_BTABLE, 0);
  put16(usb, USB_FRAME_TIMER, FRAME_PS & 0xffff);
  put16(usb, USB_FRAME_TIMER + 2, (FRAME_PS >>> 16) & 0xffff);

  return true;
}

/** 虚拟 host：USB bus reset。设备未连接/PDWN 时无效果。 */
export function usbHostReset(usb: Uint8Array): void {
  if (!attached(usb)) return;
  resetJs(usb);
}

export function usbHostSetup(
  usb: Uint8Array,
  address: number,
  endpoint: number,
  setup: Uint8Array,
): UsbOutResult {
  if (setup.length !== 8) throw new RangeError('usb setup packet must be exactly 8 bytes');
  if (!attached(usb) || deviceAddress(usb) !== (address & 0x7f)) return { handshake: 'TIMEOUT' };

  const index = findEndpoint(usb, endpoint);

  if (index < 0) return { handshake: 'TIMEOUT' };
  const ep = epAt(usb, index);

  if (unsupportedEndpoint(ep)) return { handshake: 'ERROR' };
  if (epType(ep) !== USB_EP_TYPE_CONTROL) return { handshake: 'TIMEOUT' };
  if ((ep & USB_EP_CTR_RX) !== 0) return { handshake: 'TIMEOUT' };
  if (statRx(ep) === USB_STAT_DISABLED) return { handshake: 'TIMEOUT' };

  const buf = buffer(usb, index);

  if (buf.rxSize < 8 || !pmaWrite(usb, buf.rxAddr, setup)) return { handshake: 'STALL' };

  put16(usb, bufferTableOffset(usb, index) + 6, (buf.rxCount & 0xfc00) | 8);
  setEp(
    usb,
    index,
    (ep &
      ~(
        USB_EP_DTOG_RX |
        USB_EP_STAT_RX |
        USB_EP_SETUP |
        USB_EP_CTR_TX |
        USB_EP_DTOG_TX |
        USB_EP_STAT_TX
      )) |
      USB_EP_CTR_RX |
      USB_EP_SETUP |
      (USB_STAT_NAK << 12) |
      (USB_STAT_NAK << 4) |
      USB_EP_DTOG_TX |
      (ep & (USB_EP_TYPE | USB_EP_KIND | USB_EP_EA)),
  );
  markCtr(usb, endpoint, 1);

  return { handshake: 'ACK' };
}

export function usbHostOut(
  usb: Uint8Array,
  address: number,
  endpoint: number,
  data: Uint8Array,
  dataToggle?: 0 | 1,
): UsbOutResult {
  if (data.length > 64) throw new RangeError('usb FS OUT packet must be at most 64 bytes');
  if (!attached(usb) || deviceAddress(usb) !== (address & 0x7f)) return { handshake: 'TIMEOUT' };

  const index = findEndpoint(usb, endpoint);

  if (index < 0) return { handshake: 'TIMEOUT' };
  const ep = epAt(usb, index);

  if (unsupportedEndpoint(ep)) return { handshake: 'ERROR' };
  if (statRx(ep) === USB_STAT_DISABLED) return { handshake: 'TIMEOUT' };
  if (statRx(ep) === USB_STAT_NAK) return { handshake: 'NAK' };
  if (statRx(ep) === USB_STAT_STALL) return { handshake: 'STALL' };

  const buf = buffer(usb, index);

  if (data.length > buf.rxSize) return { handshake: 'STALL' };

  const control = epType(ep) === USB_EP_TYPE_CONTROL;
  const firstControlOut = control && (ep & USB_EP_SETUP) !== 0;
  const statusOut = control && data.length === 0;
  const expected = dtogRx(ep);
  const received = dataToggle ?? (firstControlOut || statusOut ? 1 : expected);

  if (!firstControlOut && !statusOut && received !== expected) {
    // USB 规范：PID 不匹配时 ACK 并丢弃，不置 CTR、不改变 toggle、不写 PMA。
    return { handshake: 'ACK' };
  }

  if (!pmaWrite(usb, buf.rxAddr, data)) return { handshake: 'STALL' };

  put16(usb, bufferTableOffset(usb, index) + 6, (buf.rxCount & 0xfc00) | data.length);
  setEp(
    usb,
    index,
    (ep & ~(USB_EP_SETUP | USB_EP_CTR_RX | USB_EP_STAT_RX | USB_EP_DTOG_RX)) |
      USB_EP_CTR_RX |
      (USB_STAT_NAK << 12) |
      ((received ^ 1) << 14),
  );
  markCtr(usb, endpoint, 1);

  return { handshake: 'ACK' };
}

export function usbHostIn(usb: Uint8Array, address: number, endpoint: number): UsbInResult {
  if (!attached(usb) || deviceAddress(usb) !== (address & 0x7f)) return { handshake: 'TIMEOUT' };

  const index = findEndpoint(usb, endpoint);

  if (index < 0) return { handshake: 'TIMEOUT' };
  const ep = epAt(usb, index);

  if (unsupportedEndpoint(ep)) return { handshake: 'ERROR' };
  if (statTx(ep) === USB_STAT_DISABLED) return { handshake: 'TIMEOUT' };
  if (statTx(ep) === USB_STAT_NAK) return { handshake: 'NAK' };
  if (statTx(ep) === USB_STAT_STALL) return { handshake: 'STALL' };

  const buf = buffer(usb, index);

  if (buf.txCount > 64) return { handshake: 'ERROR' };

  const data = pmaRead(usb, buf.txAddr, buf.txCount);
  const toggle = dtogTx(ep);

  setEp(
    usb,
    index,
    (ep & ~(USB_EP_CTR_TX | USB_EP_STAT_TX | USB_EP_DTOG_TX)) |
      USB_EP_CTR_TX |
      (USB_STAT_NAK << 4) |
      ((toggle ^ 1) << 6),
  );
  markCtr(usb, endpoint, 0);

  return { handshake: toggle === 0 ? 'DATA0' : 'DATA1', data };
}

export function usbHostSof(usb: Uint8Array, frame?: number): void {
  if (!attached(usb)) return;

  const current = u16(usb, USB_FNR) & USB_FRAME_MASK;
  const next = frame === undefined ? (current + 1) & USB_FRAME_MASK : frame & USB_FRAME_MASK;

  put16(usb, USB_FNR, next | 0x2000);
  put16(usb, USB_ISTR, u16(usb, USB_ISTR) | USB_ISTR_SOF);
  put16(usb, USB_FRAME_TIMER, FRAME_PS & 0xffff);
  put16(usb, USB_FRAME_TIMER + 2, (FRAME_PS >>> 16) & 0xffff);
}

export function usbHostSuspend(usb: Uint8Array): void {
  if (!attached(usb)) return;
  put16(usb, USB_ISTR, u16(usb, USB_ISTR) | USB_ISTR_SUSP);
}

export function usbHostResume(usb: Uint8Array): void {
  if (!attached(usb)) return;

  const cntr = u16(usb, USB_CNTR);

  put16(usb, USB_CNTR, cntr & ~USB_CNTR_LPMODE);
  put16(usb, USB_ISTR, (u16(usb, USB_ISTR) & ~USB_ISTR_SUSP) | USB_ISTR_WKUP);
}

/**
 * 计算两次 usb memory 快照之间的窄 patch。格式为连续的
 * `[offset u16 LE, length u16 LE, data...]`，中央通过 input channel 发送后由
 * DDL/模型只写入这些字节；不覆盖 guest 已经改写的其它 USB 字节，也不做整块异步回灌。
 */
export function usbPatchBytes(before: Uint8Array, after: Uint8Array): Uint8Array {
  const size = Math.min(before.length, after.length, USB_MEMORY_SIZE);
  const out: number[] = [];
  let index = 0;

  while (index < size) {
    if ((before[index] ?? 0) === (after[index] ?? 0)) {
      index += 1;
      continue;
    }

    const start = index;

    while (index < size && (before[index] ?? 0) !== (after[index] ?? 0)) index += 1;
    const length = index - start;

    if (length > 0xffff) throw new RangeError('usb patch run is too long');
    out.push(start & 0xff, (start >>> 8) & 0xff, length & 0xff, (length >>> 8) & 0xff);
    for (let at = start; at < index; at += 1) out.push(after[at] ?? 0);
  }

  return Uint8Array.from(out);
}

/** 应用 `usbPatchBytes` 生成的窄 patch；越界或截断输入返回 false。 */
export function usbApplyPatch(usb: Uint8Array, patch: Uint8Array): boolean {
  let at = 0;

  while (at < patch.length) {
    if (at + 4 > patch.length) return false;
    const offset = (patch[at] ?? 0) | ((patch[at + 1] ?? 0) << 8);
    const length = (patch[at + 2] ?? 0) | ((patch[at + 3] ?? 0) << 8);

    at += 4;
    if (at + length > patch.length || offset + length > usb.length) return false;
    usb.set(patch.subarray(at, at + length), offset);
    at += length;
  }

  return true;
}

/** 内部：测试/诊断读取 PMA 字节。 */
export function usbPmaBytes(usb: Uint8Array, offset: number, length: number): Uint8Array {
  return pmaRead(usb, offset, length);
}

function bufferTableOffset(usb: Uint8Array, endpoint: number): number {
  return USB_PMA_OFFSET + (u16(usb, USB_BTABLE) & 0xfff8) + endpoint * 8;
}

/* 稳定入口：供文档/测试读取支持矩阵。 */
export const USB_SUPPORT = Object.freeze({
  endpoints: USB_EP_COUNT,
  pmaBytes: USB_PMA_SIZE,
  memoryBytes: USB_MEMORY_SIZE,
  irq: { hp: 19, lp: 20, wakeup: 42 },
  maxPacket: 64,
  unsupported: [
    'isochronous',
    'double-buffer',
    'lpm',
    'bcd',
    'remote-wakeup',
    'device-initiated-resume',
    'bit-level-phy',
  ],
} as const);
