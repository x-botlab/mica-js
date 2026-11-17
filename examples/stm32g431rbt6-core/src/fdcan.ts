import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { CAN, IRQ_DIRTY, PeripheralSlot, SERVICE_IRQ } from './layout';
import type { AccessSize } from './layout';
import { peripheralClockHz } from './clock-tree';
import {
  asBody,
  bool,
  boolAnd,
  boolBit,
  boolOr,
  markService,
  num,
  readWord,
  readWordAt,
  writeWord,
  u32,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { InterruptSource, PeripheralModule } from './peripheral';
import { refreshTick } from './tick';
import {
  FDCAN1_BASE,
  FDCAN1_IT0_IRQ,
  FDCAN1_IT1_IRQ,
  FDCAN1_RAM_BASE,
  FDCAN_CCCR,
  FDCAN_CCCR_ASM,
  FDCAN_CCCR_CCE,
  FDCAN_CCCR_DAR,
  FDCAN_CCCR_INIT,
  FDCAN_CCCR_MON,
  FDCAN_CCCR_PROTECTED_MASK,
  FDCAN_CCCR_TEST,
  FDCAN_CKDIV,
  FDCAN_CREL,
  FDCAN_DBTP,
  FDCAN_DBTP_WRITABLE_MASK,
  FDCAN_ELEMENT_DATA_OFFSET,
  FDCAN_ELEMENT_SIZE,
  FDCAN_ENDN,
  FDCAN_IE,
  FDCAN_IE_MASK,
  FDCAN_ILE,
  FDCAN_ILE_MASK,
  FDCAN_ILS,
  FDCAN_ILS_GROUPS,
  FDCAN_ILS_MASK,
  FDCAN_IR,
  FDCAN_IR_HPM,
  FDCAN_IR_IMPLEMENTED,
  FDCAN_IR_RF0F,
  FDCAN_IR_RF0L,
  FDCAN_IR_RF0N,
  FDCAN_IR_RF1F,
  FDCAN_IR_RF1L,
  FDCAN_IR_RF1N,
  FDCAN_IR_TC,
  FDCAN_IR_TCF,
  FDCAN_IR_TFE,
  FDCAN_MESSAGE_RAM_END,
  FDCAN_NBTP,
  FDCAN_NBTP_WRITABLE_MASK,
  FDCAN_PSR,
  FDCAN_RAM_OFFSET,
  FDCAN_RAM_SIZE,
  FDCAN_REGISTER_OFFSET,
  FDCAN_REGISTER_SIZE,
  FDCAN_RESET_VALUES,
  FDCAN_RX0_START,
  FDCAN_RX1_START,
  FDCAN_RXGFC,
  FDCAN_RXGFC_ANFS_SHIFT,
  FDCAN_RXGFC_WRITABLE_MASK,
  FDCAN_RXF0A,
  FDCAN_RXF0S,
  FDCAN_RXF0S_F0F,
  FDCAN_RXF1A,
  FDCAN_RXF1S,
  FDCAN_RXF1S_F1F,
  FDCAN_RWD,
  FDCAN_STATE_WRITTEN,
  FDCAN_STATE_RX0_FILL,
  FDCAN_STATE_RX0_GET,
  FDCAN_STATE_RX0_PUT,
  FDCAN_STATE_RX1_FILL,
  FDCAN_STATE_RX1_GET,
  FDCAN_STATE_RX1_PUT,
  FDCAN_STATE_TX_ACTIVE,
  FDCAN_STATE_TX_GET,
  FDCAN_STATE_TX_PENDING,
  FDCAN_STATE_TX_PUT,
  FDCAN_STATE_TX_REMAINING,
  FDCAN_STD_FILTER_COUNT,
  FDCAN_TDCR,
  FDCAN_TEST,
  FDCAN_TEST_WRITABLE_MASK,
  FDCAN_TOCV,
  FDCAN_TOCC,
  FDCAN_TSCV,
  FDCAN_TSCC,
  FDCAN_TXBC,
  FDCAN_TXBC_TFQM,
  FDCAN_TXBCF,
  FDCAN_TXBCIE,
  FDCAN_TXBAR,
  FDCAN_TXBRP,
  FDCAN_TXBTO,
  FDCAN_TXBTIE,
  FDCAN_TXBCR,
  FDCAN_TX_BUFFER_COUNT,
  FDCAN_TX_BUFFER_START,
  FDCAN_TXFQS,
  FDCAN_TXFQS_TFQF,
  FDCAN_XIDAM,
  FDCAN_XIDAM_MASK,
} from './fdcan-layout';

/**
 * STM32G431RBT6 FDCAN1 模型。
 *
 * 本模块先把 CAN 核心的真实寄存器与 Message RAM 访问补齐，并实现可用于
 * 自检的内部 loopback：Tx buffer0–2 → 内部反馈 → 标准 ID 过滤器 → Rx FIFO0/1。
 * 不伪造外部总线：没有 FDCAN_TX/FDCAN_RX 引脚驱动，也没有位流/仲裁/错误帧。
 *
 * 已实现：
 * - CREL/ENDN/DBTP/TEST/RWD/CCCR/NBTP/TSCC/TSCV/TOCC/TOCV/ECR/PSR/TDCR、
 *   IR/IE/ILS/ILE、RXGFC/XIDAM/HPMS、RXF0S/RXF0A/RXF1S/RXF1A、
 *   TXBC/TXFQS/TXBRP/TXBAR/TXBCR/TXBTO/TXBCF/TXBTIE/TXBCIE/TXEFS/TXEFA、
 *   FDCAN_CONFIG.CKDIV；
 * - 寄存器 byte/halfword/word 部分访问；
 * - INIT/CCE 保护、TEST.TEST 保护、IR 写 1 清除、FIFO acknowledge；
 * - Message RAM 直接读写（0x4000A400–0x4000A7FF）；
 * - `TEST.LBCK` + `CCCR.MON` 的内部 loopback；经典 CAN 11 位 ID/8 字节；
 * - 标准 ID 过滤器（range/dual/classic mask、FIFO0/FIFO1/reject/priority）；
 * - Tx/Rx FIFO 状态、Tx 完成与 Rx 新消息中断、两条中断线的 ILS/ILE 路由；
 * - NBTP/CKDIV 的帧时长（按 PCLK1 和外设门控计算），发送完成有真实耗时。
 *
 * 明确未实现：
 * - 外部 FDCAN_TX/FDCAN_RX 引脚、收发器、位流、仲裁、ACK、错误帧与 bus-off；
 * - ECR/PSR 的错误计数、错误被动/警告/bus-off、协议错误、TDC/SSP、时间戳计数器、
 *   超时计数器、RAM watchdog 的实际计时；
 * - CAN FD 数据相位切换的精确时序、>8 字节 DLC 的填充/CRC、扩展 ID 过滤器；
 * - Tx event FIFO 的实际存储、Tx FIFO/queue 的严格优先级/顺序（loopback 先按
 *   最低缓冲区号发送）；
 * - 外部帧注入/发送的 typed method/event（后续事务层）。
 */

const FDCAN_SLOT = PeripheralSlot.Can;
const REGISTER_MASK = FDCAN_REGISTER_SIZE - 1;
const RAM_MASK = FDCAN_RAM_SIZE - 1;
const PICOSECONDS_PER_SECOND = 1_000_000_000_000;

const readState = (b: Body, offset: number): Value<number> => readWordAt(b, CAN, offset);
const writeState = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, CAN, offset, value);
};
const readRamAt = (b: Body, offset: number): Value<number> =>
  readWordAt(b, CAN, FDCAN_RAM_OFFSET + offset);
const readRam = (b: Body, offset: Value<number>): Value<number> =>
  readWord(b, CAN, b.add(num(b, FDCAN_RAM_OFFSET), offset));
const writeRamAt = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, CAN, FDCAN_RAM_OFFSET + offset, value);
};
const writeRam = (b: Body, offset: Value<number>, value: Value<number>): void => {
  writeWord(b, CAN, b.add(num(b, FDCAN_RAM_OFFSET), offset), value);
};

const extractAt = (b: Body, word: Value<number>, offset: number, size: number): Value<number> => {
  if (size === 4) return word;
  const shift = (offset & 3) * 8;
  const shifted = shift === 0 ? word : b.shiftRightUnsigned(word, num(b, shift));

  return b.bitAnd(shifted, num(b, size === 2 ? 0xffff : 0xff));
};

const extract = (
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
};

const maskFor = (size: number): number => (size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff);

/** 把一次窄写入放到目标字中。 */
const place = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return u32(b, value);
  const width = maskFor(size);
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
};

const maskAt = (b: Body, offset: Value<number>, size: number): Value<number> => {
  if (size === 4) return num(b, 0xffffffff);
  const width = maskFor(size);
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(num(b, width), shift);
};

/** 0..5 的整数对 3 取模；FIFO 的 put/get 差值最多 5。 */
function mod3(b: Body, value: Value<number>): Value<number> {
  const reduced = b.select(
    types.number,
    b.greaterThanOrEqual(value, num(b, 3)),
    (inner) => inner.subtract(value, inner.constant(types.number, 3)),
    () => value,
  );

  return b.select(
    types.number,
    b.greaterThanOrEqual(reduced, num(b, 3)),
    (inner) => inner.subtract(reduced, inner.constant(types.number, 3)),
    () => reduced,
  );
}

const merge = (
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> =>
  size === 4
    ? u32(b, value)
    : u32(
        b,
        b.bitOr(
          b.bitAnd(current, b.bitNot(maskAt(b, offset, size))),
          b.bitAnd(place(b, value, offset, size), maskAt(b, offset, size)),
        ),
      );

const setIrq = (b: Body): void => {
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
};

/**
 * 带非零复位值的寄存器用 written 掩码记录是否被固件写过。复位清空
 * `can[0x000..0x1ff]` 时该掩码一起归零，读取回落到 RM 复位值。
 */
const TRACKED_CCCR = 1 << 0;
const TRACKED_DBTP = 1 << 1;
const TRACKED_NBTP = 1 << 2;
const TRACKED_TOCC = 1 << 3;
const TRACKED_TOCV = 1 << 4;
const TRACKED_XIDAM = 1 << 5;
const TRACKED_CREL = 1 << 6;
const TRACKED_ENDN = 1 << 7;
const TRACKED_PSR = 1 << 8;

function trackedMask(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, 0);

  for (const [offset, bit] of [
    [FDCAN_CCCR, TRACKED_CCCR],
    [FDCAN_DBTP, TRACKED_DBTP],
    [FDCAN_NBTP, TRACKED_NBTP],
    [FDCAN_TOCC, TRACKED_TOCC],
    [FDCAN_TOCV, TRACKED_TOCV],
    [FDCAN_XIDAM, TRACKED_XIDAM],
    [FDCAN_CREL, TRACKED_CREL],
    [FDCAN_ENDN, TRACKED_ENDN],
    [FDCAN_PSR, TRACKED_PSR],
  ] as const) {
    b.if(b.equal(types.number, wordOffset, num(b, offset)), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), bit));
    });
  }

  return b.getLocal(result);
}

/** 带非零复位值寄存器的复位值；其他寄存器复位值为 0。 */
function resetRegisterValue(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, 0);

  for (const [offset, value] of Object.entries(FDCAN_RESET_VALUES)) {
    if (value === 0) continue;
    b.if(b.equal(types.number, wordOffset, num(b, Number(offset))), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), value));
    });
  }

  return b.getLocal(result);
}

/** 读取当前寄存器值：带复位默认的寄存器在写过之前使用复位值。 */
function currentRegisterValue(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, loadRegister(b, wordOffset));
  const tracked = trackedMask(b, wordOffset);

  b.if(b.notEqual(types.number, tracked, num(b, 0)), (hit) => {
    const body = asBody(hit);
    const written = body.notEqual(
      types.number,
      body.bitAnd(readState(body, FDCAN_STATE_WRITTEN), tracked),
      num(body, 0),
    );

    body.if(
      written,
      () => {},
      (unwritten) => {
        const scope = asBody(unwritten);

        scope.setLocal(result, resetRegisterValue(scope, wordOffset));
      },
    );
  });

  return b.getLocal(result);
}

function markWritten(b: Body, wordOffset: Value<number>): void {
  const tracked = trackedMask(b, wordOffset);
  const writable = b.local(types.number, tracked);

  for (const offset of [FDCAN_CREL, FDCAN_ENDN, FDCAN_PSR]) {
    b.if(b.equal(types.number, wordOffset, num(b, offset)), (hit) => {
      asBody(hit).setLocal(writable, num(asBody(hit), 0));
    });
  }

  b.if(b.notEqual(types.number, b.getLocal(writable), num(b, 0)), (hit) => {
    const body = asBody(hit);

    writeState(
      body,
      FDCAN_STATE_WRITTEN,
      body.bitOr(readState(body, FDCAN_STATE_WRITTEN), body.getLocal(writable)),
    );
  });
}

const loadRegister = (b: Body, wordOffset: Value<number>): Value<number> =>
  readWord(b, CAN, b.add(num(b, FDCAN_REGISTER_OFFSET), wordOffset));

const storeRegister = (b: Body, wordOffset: Value<number>, value: Value<number>): void => {
  writeWord(b, CAN, b.add(num(b, FDCAN_REGISTER_OFFSET), wordOffset), value);
};

/** DLC → 实际数据字节数；经典 CAN 的 9–15 都表示 8 字节。 */
function dataLengthOf(b: Body, dlc: Value<number>, fdf: Value<boolean>): Value<number> {
  const result = b.local(types.number, 8);

  b.if(b.lessThanOrEqual(dlc, num(b, 8)), (classic) => {
    asBody(classic).setLocal(result, dlc);
  });
  for (const [code, bytes] of [
    [9, 12],
    [10, 16],
    [11, 20],
    [12, 24],
    [13, 32],
    [14, 48],
    [15, 64],
  ] as const) {
    b.if(b.equal(types.number, dlc, num(b, code)), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), bytes));
    });
  }

  const classicResult = b.local(types.number, 0);

  b.if(
    b.lessThanOrEqual(dlc, num(b, 8)),
    (classic) => {
      asBody(classic).setLocal(classicResult, dlc);
    },
    (extended) => {
      asBody(extended).setLocal(classicResult, num(asBody(extended), 8));
    },
  );

  const fdResult = b.getLocal(result);
  const classic = b.getLocal(classicResult);

  return b.select(
    types.number,
    fdf,
    () => fdResult,
    () => classic,
  );
}

/** CKDIV.PDIV: 0 → /1，n>0 → /(2n+2)。 */
function clockDividerOf(b: Body, pdiv: Value<number>): Value<number> {
  return b.select(
    types.number,
    b.equal(types.number, pdiv, num(b, 0)),
    (inner) => inner.constant(types.number, 1),
    (inner) =>
      inner.add(
        inner.multiply(pdiv, inner.constant(types.number, 2)),
        inner.constant(types.number, 2),
      ),
  );
}

/** 一帧的近似时长（ps）：标称位时长 × 帧位数；FD 数据相位不单独加速。 */
function frameDurationPs(b: Body, dlc: Value<number>, fdf: Value<boolean>): Value<number> {
  const hz = peripheralClockHz(b, 'fdcan');
  const safeHz = b.max(hz, num(b, 1));
  const kernelPs = b.floor(b.divide(num(b, PICOSECONDS_PER_SECOND), safeHz));
  const ckdiv = clockDividerOf(b, b.bitAnd(readRegister(b, num(b, FDCAN_CKDIV)), num(b, 0xf)));
  const nbtp = readRegister(b, num(b, FDCAN_NBTP));
  const brp = b.add(b.bitAnd(b.shiftRightUnsigned(nbtp, num(b, 16)), num(b, 0x1ff)), num(b, 1));
  const seg1 = b.add(b.bitAnd(b.shiftRightUnsigned(nbtp, num(b, 8)), num(b, 0xff)), num(b, 1));
  const seg2 = b.add(b.bitAnd(nbtp, num(b, 0x7f)), num(b, 1));
  const tq = b.multiply(b.multiply(kernelPs, ckdiv), brp);
  const bitTime = b.multiply(tq, b.add(b.add(seg1, seg2), num(b, 1)));
  const dataBytes = dataLengthOf(b, dlc, fdf);
  const bits = b.add(num(b, 47), b.multiply(dataBytes, num(b, 8)));

  return b.max(b.multiply(bitTime, bits), num(b, 1));
}

/* ---------------- 寄存器读合成 ---------------- */

function rxFifoStatus(
  b: Body,
  putOffset: number,
  getOffset: number,
  fillOffset: number,
  lastBit: number,
  fullBit: number,
): Value<number> {
  const put = readState(b, putOffset);
  const get = readState(b, getOffset);
  const fill = readState(b, fillOffset);
  const ir = loadRegister(b, num(b, FDCAN_IR));
  const full = b.greaterThanOrEqual(fill, num(b, 3));
  const lost = b.notEqual(types.number, b.bitAnd(ir, num(b, lastBit)), num(b, 0));

  return b.bitOr(
    b.bitOr(
      b.select(
        types.number,
        lost,
        (inner) => inner.constant(types.number, lastBit),
        (inner) => inner.constant(types.number, 0),
      ),
      b.select(
        types.number,
        full,
        (inner) => inner.constant(types.number, fullBit),
        (inner) => inner.constant(types.number, 0),
      ),
    ),
    b.bitOr(
      b.shiftLeft(b.bitAnd(put, num(b, 3)), num(b, 16)),
      b.bitOr(b.shiftLeft(b.bitAnd(get, num(b, 3)), num(b, 8)), b.bitAnd(fill, num(b, 0xf))),
    ),
  );
}

function txFifoStatus(b: Body): Value<number> {
  const pending = readState(b, FDCAN_STATE_TX_PENDING);
  const count = b.add(
    b.add(
      b.bitAnd(pending, num(b, 1)),
      b.bitAnd(b.shiftRightUnsigned(pending, num(b, 1)), num(b, 1)),
    ),
    b.bitAnd(b.shiftRightUnsigned(pending, num(b, 2)), num(b, 1)),
  );
  const free = b.subtract(num(b, 3), count);
  const full = b.equal(types.number, count, num(b, 3));
  const queue = b.notEqual(
    types.number,
    b.bitAnd(loadRegister(b, num(b, FDCAN_TXBC)), num(b, FDCAN_TXBC_TFQM)),
    num(b, 0),
  );

  return b.bitOr(
    b.bitOr(
      b.select(
        types.number,
        full,
        (inner) => inner.constant(types.number, FDCAN_TXFQS_TFQF),
        (inner) => inner.constant(types.number, 0),
      ),
      b.shiftLeft(b.bitAnd(readState(b, FDCAN_STATE_TX_PUT), num(b, 3)), num(b, 16)),
    ),
    b.bitOr(
      b.select(
        types.number,
        queue,
        (inner) => inner.constant(types.number, 0),
        (inner) =>
          inner.bitOr(
            inner.shiftLeft(
              inner.bitAnd(
                readState(asBody(inner), FDCAN_STATE_TX_GET),
                inner.constant(types.number, 3),
              ),
              inner.constant(types.number, 8),
            ),
            inner.bitAnd(free, inner.constant(types.number, 0x7)),
          ),
      ),
      num(b, 0),
    ),
  );
}

function registerWord(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, currentRegisterValue(b, wordOffset));

  b.if(b.equal(types.number, wordOffset, num(b, FDCAN_RXF0S)), (hit) => {
    const scope = asBody(hit);

    scope.setLocal(
      result,
      rxFifoStatus(
        scope,
        FDCAN_STATE_RX0_PUT,
        FDCAN_STATE_RX0_GET,
        FDCAN_STATE_RX0_FILL,
        FDCAN_IR_RF0L,
        FDCAN_RXF0S_F0F,
      ),
    );
  });
  b.if(b.equal(types.number, wordOffset, num(b, FDCAN_RXF1S)), (hit) => {
    const scope = asBody(hit);

    scope.setLocal(
      result,
      rxFifoStatus(
        scope,
        FDCAN_STATE_RX1_PUT,
        FDCAN_STATE_RX1_GET,
        FDCAN_STATE_RX1_FILL,
        FDCAN_IR_RF1L,
        FDCAN_RXF1S_F1F,
      ),
    );
  });
  b.if(b.equal(types.number, wordOffset, num(b, FDCAN_TXFQS)), (hit) => {
    asBody(hit).setLocal(result, txFifoStatus(asBody(hit)));
  });
  b.if(b.equal(types.number, wordOffset, num(b, FDCAN_TXBRP)), (hit) => {
    const scope = asBody(hit);

    scope.setLocal(result, readState(scope, FDCAN_STATE_TX_PENDING));
  });

  return b.getLocal(result);
}

function readRegister(b: Body, wordOffset: Value<number>): Value<number> {
  return registerWord(b, wordOffset);
}

function readRegisterAt(b: Body, offset: number): Value<number> {
  const wordOffset = offset & REGISTER_MASK & 0x3fc;

  if (offset >= 0x180) return num(b, 0);

  return registerWord(b, num(b, wordOffset));
}

/* ---------------- 寄存器写路径 ---------------- */

function cccrWrite(
  b: Body,
  current: Value<number>,
  placed: Value<number>,
  mask: Value<number>,
): void {
  const requested = b.bitOr(b.bitAnd(current, b.bitNot(mask)), b.bitAnd(placed, mask));
  const initRequested = b.bitAnd(requested, num(b, 1));
  const cceRequested = b.bitAnd(b.shiftRightUnsigned(requested, num(b, 1)), num(b, 1));
  const configAllowed = b.multiply(initRequested, cceRequested);
  const csr = b.bitAnd(b.shiftRightUnsigned(requested, num(b, 4)), num(b, 1));

  // 位域选择用 0/1 的 configAllowed 做线性插值，避免依赖惰性 select 分支。
  const choose = (wanted: Value<number>, kept: Value<number>): Value<number> =>
    b.add(kept, b.multiply(configAllowed, b.subtract(wanted, kept)));
  const modeMask = num(b, FDCAN_CCCR_TEST | FDCAN_CCCR_MON | FDCAN_CCCR_DAR | FDCAN_CCCR_ASM);
  const modeBits = choose(
    b.bitAnd(requested, modeMask),
    b.bitAnd(b.bitAnd(current, requested), modeMask),
  );
  const protectedBits = choose(
    b.bitAnd(requested, num(b, FDCAN_CCCR_PROTECTED_MASK)),
    b.bitAnd(current, num(b, FDCAN_CCCR_PROTECTED_MASK)),
  );
  const init = b.bitOr(initRequested, csr);
  const cce = b.multiply(b.bitAnd(requested, num(b, FDCAN_CCCR_CCE)), initRequested);
  const csa = b.multiply(csr, num(b, 1 << 3));
  const next = b.bitOr(b.bitOr(b.bitOr(init, cce), b.bitOr(csa, protectedBits)), modeBits);

  storeRegister(b, num(b, FDCAN_CCCR), next);

  // INIT/CCE 使能时，Tx/Rx handler 被冻结并复位 FIFO 状态和 TOCV。
  b.if(
    b.notEqual(types.number, b.bitAnd(cce, num(b, FDCAN_CCCR_CCE)), num(b, 0)),
    (resetHandlers) => {
      const body = asBody(resetHandlers);

      writeState(body, FDCAN_STATE_TX_PENDING, num(body, 0));
      writeState(body, FDCAN_STATE_TX_ACTIVE, num(body, 0));
      writeState(body, FDCAN_STATE_TX_REMAINING, num(body, 0));
      writeState(body, FDCAN_STATE_RX0_PUT, num(body, 0));
      writeState(body, FDCAN_STATE_RX0_GET, num(body, 0));
      writeState(body, FDCAN_STATE_RX0_FILL, num(body, 0));
      writeState(body, FDCAN_STATE_RX1_PUT, num(body, 0));
      writeState(body, FDCAN_STATE_RX1_GET, num(body, 0));
      writeState(body, FDCAN_STATE_RX1_FILL, num(body, 0));
    },
  );

  b.if(b.equal(types.number, b.bitAnd(next, num(b, FDCAN_CCCR_TEST)), num(b, 0)), (testOff) => {
    writeWordAt(asBody(testOff), CAN, FDCAN_REGISTER_OFFSET + FDCAN_TEST, num(testOff, 0));
  });
}

/** 让服务块尽快进入 advance，在 advance 里再计算帧时长并启动发送。 */
function kickTx(b: Body): void {
  setPeripheralActive(b, FDCAN_SLOT, true);
  setPeripheralDeadline(b, FDCAN_SLOT, num(b, 1));
  refreshTick(b);
}

function updateTxSlot(b: Body): void {
  const active = readState(b, FDCAN_STATE_TX_ACTIVE);
  const busy = b.notEqual(types.number, active, num(b, 0));
  const remaining = readState(b, FDCAN_STATE_TX_REMAINING);

  const deadline = b.max(remaining, num(b, 1));

  setPeripheralActive(b, FDCAN_SLOT, busy);
  setPeripheralDeadline(
    b,
    FDCAN_SLOT,
    b.select(
      types.number,
      busy,
      () => deadline,
      (inner) => inner.constant(types.number, 0),
    ),
  );
  refreshTick(b);
}

function startNextTransmission(b: Body): void {
  const active = readState(b, FDCAN_STATE_TX_ACTIVE);

  b.if(b.equal(types.number, active, num(b, 0)), (idle) => {
    const body = asBody(idle);
    const pending = readState(body, FDCAN_STATE_TX_PENDING);
    const index = body.local(types.number, 0);
    const found = body.local(types.bool, false);

    body.if(
      boolAnd(
        body,
        body.notEqual(types.number, pending, num(body, 0)),
        body.greaterThan(peripheralClockHz(body, 'fdcan'), num(body, 0)),
      ),
      (work) => {
        const scope = asBody(work);

        for (let candidate = 0; candidate < FDCAN_TX_BUFFER_COUNT; candidate += 1) {
          scope.if(
            scope.notEqual(
              types.number,
              scope.bitAnd(pending, scope.constant(types.number, 1 << candidate)),
              scope.constant(types.number, 0),
            ),
            (hit) => {
              const inner = asBody(hit);

              inner.if(inner.not(inner.getLocal(found)), (take) => {
                const takeBody = asBody(take);

                takeBody.setLocal(index, num(takeBody, candidate));
                takeBody.setLocal(found, bool(takeBody, true));
              });
            },
          );
        }

        scope.if(scope.getLocal(found), (start) => {
          const inner = asBody(start);
          const base = inner.add(
            num(inner, FDCAN_TX_BUFFER_START),
            inner.multiply(inner.getLocal(index), num(inner, FDCAN_ELEMENT_SIZE)),
          );
          const t1 = readRam(inner, inner.add(base, num(inner, 4)));
          const dlc = inner.bitAnd(inner.shiftRightUnsigned(t1, num(inner, 16)), num(inner, 0xf));
          const fdf = boolBit(inner, t1, 21);
          const duration = frameDurationPs(inner, dlc, fdf);

          writeState(inner, FDCAN_STATE_TX_ACTIVE, inner.add(inner.getLocal(index), num(inner, 1)));
          writeState(inner, FDCAN_STATE_TX_REMAINING, duration);
          setPeripheralActive(inner, FDCAN_SLOT, true);
          setPeripheralDeadline(inner, FDCAN_SLOT, duration);
          refreshTick(inner);
        });
      },
    );
  });
}

/* ---------------- 过滤器与接收 ---------------- */

interface RxElement {
  readonly id: Value<number>;
  readonly xtd: Value<boolean>;
  readonly rtr: Value<boolean>;
  readonly fdf: Value<boolean>;
  readonly brs: Value<boolean>;
  readonly dlc: Value<number>;
  readonly dataBase: Value<number>;
}

function txElement(b: Body, index: Value<number>): RxElement {
  const base = b.add(num(b, FDCAN_TX_BUFFER_START), b.multiply(index, num(b, FDCAN_ELEMENT_SIZE)));
  const t0 = readRam(b, base);
  const t1 = readRam(b, b.add(base, num(b, 4)));

  return {
    id: b.bitAnd(t0, num(b, 0x1fffffff)),
    xtd: boolBit(b, t0, 30),
    rtr: boolBit(b, t0, 29),
    fdf: boolBit(b, t1, 21),
    brs: boolBit(b, t1, 20),
    dlc: b.bitAnd(b.shiftRightUnsigned(t1, num(b, 16)), num(b, 0xf)),
    dataBase: b.add(base, num(b, FDCAN_ELEMENT_DATA_OFFSET)),
  };
}

/*
 * 过滤器实现需要一个既能返回“是否命中”又能返回“目标 FIFO”的 IR 值。重新写成
 * 使用两个 local（matched, target）的版本；上面版本仅保留为草稿会被删除。
 */

function acceptStandard(
  b: Body,
  id: Value<number>,
  remote: Value<boolean>,
): {
  readonly matched: Value<boolean>;
  readonly target: Value<number>;
  readonly filterIndex: Value<number>;
  readonly priority: Value<boolean>;
} {
  const rxgfc = readRegister(b, num(b, FDCAN_RXGFC));
  const lssRaw = b.bitAnd(b.shiftRightUnsigned(rxgfc, num(b, 16)), num(b, 0x1f));
  const lss = b.min(lssRaw, num(b, FDCAN_STD_FILTER_COUNT));
  const matched = b.local(types.bool, false);
  const target = b.local(types.number, 0);
  const filterIndex = b.local(types.number, 0);
  const priority = b.local(types.bool, false);
  const index = b.local(types.number, 0);

  b.while(
    (test) =>
      boolAnd(
        asBody(test),
        test.lessThan(test.getLocal(index), lss),
        test.not(test.getLocal(matched)),
      ),
    (loop) => {
      const body = asBody(loop);
      const word = readRam(body, body.multiply(body.getLocal(index), num(body, 4)));
      const sft = body.bitAnd(body.shiftRightUnsigned(word, num(body, 30)), num(body, 3));
      const sfec = body.bitAnd(body.shiftRightUnsigned(word, num(body, 27)), num(body, 7));
      const id1 = body.bitAnd(body.shiftRightUnsigned(word, num(body, 16)), num(body, 0x7ff));
      const id2 = body.bitAnd(word, num(body, 0x7ff));
      const rangeMatch = boolAnd(
        body,
        body.greaterThanOrEqual(id, id1),
        body.lessThanOrEqual(id, id2),
      );
      const dualMatch = boolOr(
        body,
        body.equal(types.number, id, id1),
        body.equal(types.number, id, id2),
      );
      const maskMatch = body.equal(types.number, body.bitAnd(id, id2), body.bitAnd(id1, id2));
      const typeMatch = body.select(
        types.bool,
        body.equal(types.number, sft, num(body, 0)),
        () => rangeMatch,
        (inner) =>
          inner.select(
            types.bool,
            inner.equal(types.number, sft, inner.constant(types.number, 1)),
            () => dualMatch,
            (last) =>
              last.select(
                types.bool,
                last.equal(types.number, sft, last.constant(types.number, 2)),
                () => maskMatch,
                (none) => none.constant(types.bool, false),
              ),
          ),
      );
      const enabled = boolAnd(
        body,
        body.notEqual(types.number, sfec, num(body, 0)),
        body.notEqual(types.number, sft, num(body, 3)),
      );
      const match = boolAnd(body, enabled, boolAnd(body, typeMatch, body.not(remote)));

      body.if(match, (hit) => {
        const inner = asBody(hit);

        inner.if(
          boolOr(
            inner,
            inner.equal(types.number, sfec, num(inner, 1)),
            inner.equal(types.number, sfec, num(inner, 5)),
          ),
          (fifo) => asBody(fifo).setLocal(target, num(asBody(fifo), 1)),
        );
        inner.if(
          boolOr(
            inner,
            inner.equal(types.number, sfec, num(inner, 2)),
            inner.equal(types.number, sfec, num(inner, 6)),
          ),
          (fifo) => asBody(fifo).setLocal(target, num(asBody(fifo), 2)),
        );
        inner.if(
          boolOr(
            inner,
            inner.equal(types.number, sfec, num(inner, 4)),
            boolOr(
              inner,
              inner.equal(types.number, sfec, num(inner, 5)),
              inner.equal(types.number, sfec, num(inner, 6)),
            ),
          ),
          (priorityHit) => asBody(priorityHit).setLocal(priority, bool(asBody(priorityHit), true)),
        );
        inner.setLocal(matched, bool(inner, true));
        inner.setLocal(filterIndex, inner.getLocal(index));
      });
      body.setLocal(index, body.add(body.getLocal(index), num(body, 1)));
    },
  );

  const noMatchTarget = b.local(types.number, 0);
  const anfs = b.bitAnd(b.shiftRightUnsigned(rxgfc, num(b, FDCAN_RXGFC_ANFS_SHIFT)), num(b, 3));

  b.if(b.not(b.getLocal(matched)), (none) => {
    const body = asBody(none);

    body.if(body.equal(types.number, anfs, num(body, 0)), (fifo) => {
      asBody(fifo).setLocal(noMatchTarget, num(asBody(fifo), 1));
    });
    body.if(body.equal(types.number, anfs, num(body, 1)), (fifo) => {
      asBody(fifo).setLocal(noMatchTarget, num(asBody(fifo), 2));
    });
    body.setLocal(filterIndex, num(body, 0));
  });

  const matchedValue = b.getLocal(matched);
  const targetValue = b.getLocal(target);
  const noMatchValue = b.getLocal(noMatchTarget);

  return {
    matched: matchedValue,
    target: b.select(
      types.number,
      matchedValue,
      () => targetValue,
      () => noMatchValue,
    ),
    filterIndex: b.getLocal(filterIndex),
    priority: b.getLocal(priority),
  };
}

function storeRxElement(
  b: Body,
  fifo: 0 | 1,
  element: RxElement,
  filterIndex: Value<number>,
  nonMatching: Value<boolean>,
  useOverwrite: Value<boolean>,
): void {
  const putOffset = fifo === 0 ? FDCAN_STATE_RX0_PUT : FDCAN_STATE_RX1_PUT;
  const getOffset = fifo === 0 ? FDCAN_STATE_RX0_GET : FDCAN_STATE_RX1_GET;
  const fillOffset = fifo === 0 ? FDCAN_STATE_RX0_FILL : FDCAN_STATE_RX1_FILL;
  const start = fifo === 0 ? FDCAN_RX0_START : FDCAN_RX1_START;
  const newFlag = fifo === 0 ? FDCAN_IR_RF0N : FDCAN_IR_RF1N;
  const lostFlag = fifo === 0 ? FDCAN_IR_RF0L : FDCAN_IR_RF1L;
  const fullFlag = fifo === 0 ? FDCAN_IR_RF0F : FDCAN_IR_RF1F;
  const put = readState(b, putOffset);
  const get = readState(b, getOffset);
  const fill = readState(b, fillOffset);
  const full = b.greaterThanOrEqual(fill, num(b, 3));
  const target = b.local(types.number, put);
  const nextPut = b.local(types.number, b.bitAnd(b.add(put, num(b, 1)), num(b, 3)));
  const nextGet = b.local(types.number, get);
  const nextFill = b.local(types.number, b.min(b.add(fill, num(b, 1)), num(b, 3)));
  const dropped = b.local(types.bool, false);

  b.if(full, (isFull) => {
    const body = asBody(isFull);

    body.if(
      useOverwrite,
      (overwrite) => {
        const scope = asBody(overwrite);

        scope.setLocal(target, get);
        scope.setLocal(nextPut, scope.bitAnd(scope.add(get, num(scope, 1)), num(scope, 3)));
        scope.setLocal(nextGet, scope.getLocal(nextPut));
        scope.setLocal(nextFill, num(scope, 3));
      },
      (blocked) => {
        asBody(blocked).setLocal(dropped, bool(asBody(blocked), true));
      },
    );
  });

  b.if(
    b.getLocal(dropped),
    (lost) => {
      const body = asBody(lost);

      storeIrBits(body, lostFlag);
      setIrq(body);
    },
    (stored) => {
      const body = asBody(stored);
      const base = body.add(
        num(body, start),
        body.multiply(body.getLocal(target), num(body, FDCAN_ELEMENT_SIZE)),
      );
      // Tx/Rx 元素的 T0/R0 使用同一格式：标准 ID 已位于 ID[28:18]。
      const r0 = body.bitOr(
        element.id,
        body.bitOr(
          body.select(
            types.number,
            element.xtd,
            (inner) => inner.constant(types.number, 1 << 30),
            (inner) => inner.constant(types.number, 0),
          ),
          body.select(
            types.number,
            element.rtr,
            (inner) => inner.constant(types.number, 1 << 29),
            (inner) => inner.constant(types.number, 0),
          ),
        ),
      );
      const r1 = body.bitOr(
        body.bitOr(
          body.select(
            types.number,
            nonMatching,
            (inner) => inner.constant(types.number, 0x80000000),
            (inner) => inner.constant(types.number, 0),
          ),
          body.shiftLeft(body.bitAnd(filterIndex, num(body, 0x7f)), num(body, 24)),
        ),
        body.bitOr(
          body.bitOr(
            body.select(
              types.number,
              element.fdf,
              (inner) => inner.constant(types.number, 1 << 21),
              (inner) => inner.constant(types.number, 0),
            ),
            body.select(
              types.number,
              element.brs,
              (inner) => inner.constant(types.number, 1 << 20),
              (inner) => inner.constant(types.number, 0),
            ),
          ),
          body.shiftLeft(body.bitAnd(element.dlc, num(body, 0xf)), num(body, 16)),
        ),
      );
      const bytes = dataLengthOf(body, element.dlc, element.fdf);
      const words = body.min(body.ceil(body.divide(bytes, num(body, 4))), num(body, 16));
      const copied = body.local(types.number, 0);

      writeRam(body, base, r0);
      writeRam(body, body.add(base, num(body, 4)), r1);

      body.while(
        (test) => test.lessThan(test.getLocal(copied), words),
        (loop) => {
          const scope = asBody(loop);
          const data = readRam(
            scope,
            scope.add(element.dataBase, scope.multiply(scope.getLocal(copied), num(scope, 4))),
          );

          writeRam(
            scope,
            scope.add(
              scope.add(base, num(scope, FDCAN_ELEMENT_DATA_OFFSET)),
              scope.multiply(scope.getLocal(copied), num(scope, 4)),
            ),
            data,
          );
          scope.setLocal(copied, scope.add(scope.getLocal(copied), num(scope, 1)));
        },
      );

      writeState(body, putOffset, body.getLocal(nextPut));
      writeState(body, getOffset, body.getLocal(nextGet));
      writeState(body, fillOffset, body.getLocal(nextFill));
      storeIrBits(body, newFlag);
      body.if(body.equal(types.number, body.getLocal(nextFill), num(body, 3)), (fullNow) => {
        const inner = asBody(fullNow);

        storeIrBits(inner, fullFlag);
        setIrq(inner);
      });
      setIrq(body);
    },
  );
}

function storeIrBits(b: Body, bits: number): void {
  const ir = loadRegister(b, num(b, FDCAN_IR));

  storeRegister(b, num(b, FDCAN_IR), b.bitOr(ir, num(b, bits)));
}

function receiveStandard(b: Body, element: RxElement, rxgfc: Value<number>): void {
  const standardId = b.shiftRightUnsigned(element.id, num(b, 18));
  const accept = acceptStandard(b, standardId, element.rtr);
  const rejected = boolAnd(b, element.rtr, boolBit(b, rxgfc, 1));

  b.if(
    rejected,
    () => {},
    (allowed) => {
      const scope = asBody(allowed);
      const target = accept.target;
      const nonMatching = scope.not(accept.matched);
      const overwrite0 = boolBit(scope, rxgfc, 9);
      const overwrite1 = boolBit(scope, rxgfc, 8);

      scope.if(scope.equal(types.number, target, num(scope, 1)), (fifo) => {
        storeRxElement(asBody(fifo), 0, element, accept.filterIndex, nonMatching, overwrite0);
      });
      scope.if(scope.equal(types.number, target, num(scope, 2)), (fifo) => {
        storeRxElement(asBody(fifo), 1, element, accept.filterIndex, nonMatching, overwrite1);
      });
      scope.if(accept.priority, (priority) => {
        const inner = asBody(priority);

        storeIrBits(inner, FDCAN_IR_HPM);
        setIrq(inner);
      });
    },
  );
}

function receiveExtended(b: Body, element: RxElement, rxgfc: Value<number>): void {
  const anfe = b.bitAnd(b.shiftRightUnsigned(rxgfc, num(b, 2)), num(b, 3));
  const rejected = boolAnd(b, element.rtr, boolBit(b, rxgfc, 0));

  b.if(
    rejected,
    () => {},
    (allowed) => {
      const scope = asBody(allowed);
      const overwrite0 = boolBit(scope, rxgfc, 9);
      const overwrite1 = boolBit(scope, rxgfc, 8);

      scope.if(scope.equal(types.number, anfe, num(scope, 0)), (fifo) => {
        storeRxElement(
          asBody(fifo),
          0,
          element,
          num(asBody(fifo), 0),
          bool(asBody(fifo), true),
          overwrite0,
        );
      });
      scope.if(scope.equal(types.number, anfe, num(scope, 1)), (fifo) => {
        storeRxElement(
          asBody(fifo),
          1,
          element,
          num(asBody(fifo), 0),
          bool(asBody(fifo), true),
          overwrite1,
        );
      });
    },
  );
}

function receiveLoopback(b: Body, index: Value<number>): void {
  const element = txElement(b, index);
  const rxgfc = readRegister(b, num(b, FDCAN_RXGFC));

  b.if(
    element.xtd,
    (extended) => {
      receiveExtended(asBody(extended), element, rxgfc);
    },
    (standard) => {
      receiveStandard(asBody(standard), element, rxgfc);
    },
  );
}

function completeTransmission(b: Body): void {
  const active = readState(b, FDCAN_STATE_TX_ACTIVE);

  b.if(b.notEqual(types.number, active, num(b, 0)), (running) => {
    const body = asBody(running);
    const index = body.subtract(active, num(body, 1));
    const pending = readState(body, FDCAN_STATE_TX_PENDING);
    const bit = body.shiftLeft(num(body, 1), index);

    writeState(body, FDCAN_STATE_TX_PENDING, body.bitAnd(pending, body.bitNot(bit)));
    writeState(body, FDCAN_STATE_TX_ACTIVE, num(body, 0));
    writeState(body, FDCAN_STATE_TX_REMAINING, num(body, 0));
    const bto = loadRegister(body, num(body, FDCAN_TXBTO));
    const ccf = loadRegister(body, num(body, FDCAN_TXBCF));

    storeRegister(body, num(body, FDCAN_TXBTO), body.bitOr(bto, bit));
    storeRegister(body, num(body, FDCAN_TXBCF), body.bitAnd(ccf, body.bitNot(bit)));
    storeIrBits(body, FDCAN_IR_TC);
    receiveLoopback(body, index);
    const remainingPending = readState(body, FDCAN_STATE_TX_PENDING);

    body.if(body.equal(types.number, remainingPending, num(body, 0)), (empty) => {
      const inner = asBody(empty);

      storeIrBits(inner, FDCAN_IR_TFE);
      setIrq(inner);
    });
    setIrq(body);
    startNextTransmission(body);
    updateTxSlot(body);
  });
}

/** 推进 loopback 发送：一次服务节拍最多完成一帧。 */
export function advanceFdcan(b: Body, elapsedPs: Value<number>): void {
  // 服务块传入的 elapsedPs 属于外层 builder；嵌套分支里通过 local 重新绑定，
  // 避免 IR_SCOPE（值不可见）以及跨作用域复用。
  const elapsed = b.local(types.number, elapsedPs);
  const active = readState(b, FDCAN_STATE_TX_ACTIVE);

  b.if(
    b.notEqual(types.number, active, num(b, 0)),
    (busy) => {
      const body = asBody(busy);
      const remaining = readState(body, FDCAN_STATE_TX_REMAINING);
      const next = body.subtract(remaining, body.getLocal(elapsed));

      body.if(
        body.lessThanOrEqual(next, num(body, 0)),
        (done) => {
          const inner = asBody(done);

          completeTransmission(inner);
        },
        (waiting) => {
          const inner = asBody(waiting);

          writeState(inner, FDCAN_STATE_TX_REMAINING, next);
          setPeripheralActive(inner, FDCAN_SLOT, true);
          setPeripheralDeadline(inner, FDCAN_SLOT, inner.max(next, num(inner, 1)));
          refreshTick(inner);
        },
      );
    },
    (idle) => {
      const body = asBody(idle);

      startNextTransmission(body);
      updateTxSlot(body);
    },
  );
}

/* ---------------- 总线入口 ---------------- */

function readRegisters(b: Body, offset: Value<number>): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);

  b.if(b.lessThan(wordOffset, num(b, 0x180)), (modeled) => {
    const body = asBody(modeled);

    body.setLocal(result, registerWord(body, wordOffset));
  });

  return b.getLocal(result);
}

function registerWriteMask(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, 0);
  const add = (offset: number, mask: number): void => {
    b.if(b.equal(types.number, wordOffset, num(b, offset)), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), mask));
    });
  };

  add(FDCAN_DBTP, FDCAN_DBTP_WRITABLE_MASK);
  add(FDCAN_RWD, 0xff);
  add(FDCAN_NBTP, FDCAN_NBTP_WRITABLE_MASK);
  add(FDCAN_TSCC, 0x000f0003);
  add(FDCAN_TSCV, 0xffff);
  add(FDCAN_TOCC, 0xffff0007);
  add(FDCAN_TOCV, 0xffff);
  add(FDCAN_TDCR, 0x7f7f);
  add(FDCAN_IE, FDCAN_IE_MASK);
  add(FDCAN_ILS, FDCAN_ILS_MASK);
  add(FDCAN_ILE, FDCAN_ILE_MASK);
  add(FDCAN_RXGFC, FDCAN_RXGFC_WRITABLE_MASK);
  add(FDCAN_XIDAM, FDCAN_XIDAM_MASK);
  add(FDCAN_TXBC, FDCAN_TXBC_TFQM);
  add(FDCAN_TXBTIE, 0x7);
  add(FDCAN_TXBCIE, 0x7);
  add(FDCAN_CKDIV, 0xf);

  return b.getLocal(result);
}

function registerProtected(b: Body, wordOffset: Value<number>): Value<number> {
  const result = b.local(types.number, 0);
  const add = (offset: number): void => {
    b.if(b.equal(types.number, wordOffset, num(b, offset)), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), 1));
    });
  };

  for (const offset of [
    FDCAN_DBTP,
    FDCAN_RWD,
    FDCAN_NBTP,
    FDCAN_RXGFC,
    FDCAN_XIDAM,
    FDCAN_TXBC,
    FDCAN_CKDIV,
  ]) {
    add(offset);
  }

  return b.getLocal(result);
}

function writeRegisters(
  b: Body,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const placed = place(b, value, offset, size);
  const mask = maskAt(b, offset, size);

  b.if(b.lessThan(wordOffset, num(b, 0x180)), (modeled) => {
    const body = asBody(modeled);
    const current = currentRegisterValue(body, wordOffset);
    const requested = body.bitOr(
      body.bitAnd(current, body.bitNot(mask)),
      body.bitAnd(placed, mask),
    );
    const canConfigure = body.equal(
      types.number,
      body.bitAnd(
        loadRegister(body, num(body, FDCAN_CCCR)),
        num(body, FDCAN_CCCR_INIT | FDCAN_CCCR_CCE),
      ),
      num(body, FDCAN_CCCR_INIT | FDCAN_CCCR_CCE),
    );
    const protectedRegister = body.notEqual(
      types.number,
      registerProtected(body, wordOffset),
      num(body, 0),
    );
    const canWrite = body.local(types.bool, true);

    body.if(protectedRegister, (hit) => {
      asBody(hit).setLocal(canWrite, canConfigure);
    });
    const writeMask = registerWriteMask(body, wordOffset);

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_CCCR)), (hit) => {
      cccrWrite(asBody(hit), current, placed, mask);
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_TEST)), (hit) => {
      const inner = asBody(hit);

      inner.if(
        inner.notEqual(
          types.number,
          inner.bitAnd(loadRegister(inner, num(inner, FDCAN_CCCR)), num(inner, FDCAN_CCCR_TEST)),
          num(inner, 0),
        ),
        (enabled) => {
          const scope = asBody(enabled);

          storeRegister(
            scope,
            wordOffset,
            scope.bitOr(
              scope.bitAnd(current, scope.constant(types.number, ~FDCAN_TEST_WRITABLE_MASK)),
              scope.bitAnd(placed, scope.constant(types.number, FDCAN_TEST_WRITABLE_MASK)),
            ),
          );
        },
        (disabled) => {
          storeRegister(asBody(disabled), wordOffset, num(asBody(disabled), 0));
        },
      );
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_IR)), (hit) => {
      const inner = asBody(hit);

      storeRegister(
        inner,
        wordOffset,
        inner.bitAnd(
          current,
          inner.bitNot(inner.bitAnd(placed, inner.constant(types.number, FDCAN_IR_IMPLEMENTED))),
        ),
      );
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_RXF0A)), (hit) => {
      const inner = asBody(hit);
      const ack = inner.bitAnd(placed, inner.constant(types.number, 7));
      const get = inner.bitAnd(
        inner.add(ack, inner.constant(types.number, 1)),
        inner.constant(types.number, 3),
      );
      const put = readState(inner, FDCAN_STATE_RX0_PUT);

      writeState(inner, FDCAN_STATE_RX0_GET, get);
      writeState(
        inner,
        FDCAN_STATE_RX0_FILL,
        mod3(inner, inner.subtract(inner.add(put, inner.constant(types.number, 3)), get)),
      );
      const ir = loadRegister(inner, num(inner, FDCAN_IR));

      storeRegister(
        inner,
        num(inner, FDCAN_IR),
        inner.bitAnd(ir, inner.constant(types.number, ~FDCAN_IR_RF0F)),
      );
      storeRegister(inner, wordOffset, num(inner, 0));
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_RXF1A)), (hit) => {
      const inner = asBody(hit);
      const ack = inner.bitAnd(placed, inner.constant(types.number, 7));
      const get = inner.bitAnd(
        inner.add(ack, inner.constant(types.number, 1)),
        inner.constant(types.number, 3),
      );
      const put = readState(inner, FDCAN_STATE_RX1_PUT);

      writeState(inner, FDCAN_STATE_RX1_GET, get);
      writeState(
        inner,
        FDCAN_STATE_RX1_FILL,
        mod3(inner, inner.subtract(inner.add(put, inner.constant(types.number, 3)), get)),
      );
      const ir = loadRegister(inner, num(inner, FDCAN_IR));

      storeRegister(
        inner,
        num(inner, FDCAN_IR),
        inner.bitAnd(ir, inner.constant(types.number, ~FDCAN_IR_RF1F)),
      );
      storeRegister(inner, wordOffset, num(inner, 0));
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_TXBAR)), (hit) => {
      const inner = asBody(hit);
      const added = inner.bitAnd(placed, inner.constant(types.number, 7));
      const pending = readState(inner, FDCAN_STATE_TX_PENDING);

      writeState(inner, FDCAN_STATE_TX_PENDING, inner.bitOr(pending, added));
      const bto = loadRegister(inner, num(inner, FDCAN_TXBTO));
      const cf = loadRegister(inner, num(inner, FDCAN_TXBCF));

      storeRegister(inner, num(inner, FDCAN_TXBTO), inner.bitAnd(bto, inner.bitNot(added)));
      storeRegister(inner, num(inner, FDCAN_TXBCF), inner.bitAnd(cf, inner.bitNot(added)));
      storeRegister(inner, wordOffset, num(inner, 0));
      inner.if(inner.notEqual(types.number, added, num(inner, 0)), (request) => {
        kickTx(asBody(request));
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, FDCAN_TXBCR)), (hit) => {
      const inner = asBody(hit);
      const cancel = inner.bitAnd(placed, inner.constant(types.number, 7));
      const pending = readState(inner, FDCAN_STATE_TX_PENDING);
      const active = readState(inner, FDCAN_STATE_TX_ACTIVE);
      const activeBitValue = inner.shiftLeft(
        inner.constant(types.number, 1),
        inner.subtract(active, inner.constant(types.number, 1)),
      );
      const activeBit = inner.select(
        types.number,
        inner.notEqual(types.number, active, num(inner, 0)),
        () => activeBitValue,
        (none) => none.constant(types.number, 0),
      );
      const cf = loadRegister(inner, num(inner, FDCAN_TXBCF));

      writeState(inner, FDCAN_STATE_TX_PENDING, inner.bitAnd(pending, inner.bitNot(cancel)));
      storeRegister(inner, num(inner, FDCAN_TXBCF), inner.bitOr(cf, cancel));
      storeRegister(inner, wordOffset, num(inner, 0));
      inner.if(
        inner.notEqual(types.number, inner.bitAnd(cancel, activeBit), num(inner, 0)),
        (stop) => {
          const scope = asBody(stop);

          writeState(scope, FDCAN_STATE_TX_ACTIVE, num(scope, 0));
          writeState(scope, FDCAN_STATE_TX_REMAINING, num(scope, 0));
          storeIrBits(scope, FDCAN_IR_TCF);
        },
      );
      storeIrBits(inner, FDCAN_IR_TCF);
      setIrq(inner);
      kickTx(inner);
    });

    body.if(body.notEqual(types.number, writeMask, num(body, 0)), (hasMask) => {
      const scope = asBody(hasMask);

      scope.if(scope.getLocal(canWrite), (allowed) => {
        const target = asBody(allowed);

        storeRegister(target, wordOffset, target.bitAnd(requested, writeMask));
      });
    });

    markWritten(body, wordOffset);
  });
}

function writeMemoryWord(
  b: Body,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, RAM_MASK & 0x3fc));
  const at = b.add(num(b, FDCAN_RAM_OFFSET), wordOffset);
  const current = readWord(b, CAN, at);

  writeWord(b, CAN, at, merge(b, current, value, offset, size));
}

export function readFdcan(b: Body, address: Value<number>, size: number): Value<number> {
  const registerOffset = b.subtract(address, num(b, FDCAN1_BASE));
  const ramOffset = b.subtract(address, num(b, FDCAN1_RAM_BASE));
  const result = b.local(types.number, 0);

  b.if(
    b.lessThan(u32(b, registerOffset), num(b, FDCAN_REGISTER_SIZE)),
    (regs) => {
      const body = asBody(regs);

      body.setLocal(result, readRegisters(body, registerOffset));
    },
    (other) => {
      const body = asBody(other);

      body.if(body.lessThan(u32(body, ramOffset), num(body, FDCAN_RAM_SIZE)), (ram) => {
        const inner = asBody(ram);
        const wordOffset = inner.bitAnd(ramOffset, num(inner, RAM_MASK & 0x3fc));
        const word = readWord(inner, CAN, inner.add(num(inner, FDCAN_RAM_OFFSET), wordOffset));

        inner.setLocal(result, extract(inner, word, ramOffset, size));
      });
    },
  );

  return b.getLocal(result);
}

export function readFdcanAt(b: Body, address: number, size: number): Value<number> {
  if (address >= FDCAN1_BASE && address < FDCAN1_BASE + FDCAN_REGISTER_SIZE) {
    return extractAt(b, readRegisterAt(b, address - FDCAN1_BASE), address - FDCAN1_BASE, size);
  }

  if (address >= FDCAN1_RAM_BASE && address < FDCAN1_RAM_BASE + FDCAN_RAM_SIZE) {
    const offset = address - FDCAN1_RAM_BASE;
    const word = readRamAt(b, offset & 0x3fc);

    return extractAt(b, word, offset, size);
  }

  return num(b, 0);
}

export function writeFdcan(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const registerOffset = b.subtract(address, num(b, FDCAN1_BASE));
  const ramOffset = b.subtract(address, num(b, FDCAN1_RAM_BASE));

  b.if(
    b.lessThan(u32(b, registerOffset), num(b, FDCAN_REGISTER_SIZE)),
    (regs) => {
      const body = asBody(regs);

      writeRegisters(body, registerOffset, size, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(body.lessThan(u32(body, ramOffset), num(body, FDCAN_RAM_SIZE)), (ram) => {
        const inner = asBody(ram);

        writeMemoryWord(inner, ramOffset, size, value);
      });
    },
  );
}

export function writeFdcanAt(
  b: Body,
  address: number,
  size: AccessSize,
  value: Value<number>,
): void {
  if (address >= FDCAN1_BASE && address < FDCAN1_BASE + FDCAN_REGISTER_SIZE) {
    writeRegisters(b, num(b, address - FDCAN1_BASE), size, value);

    return;
  }

  if (address >= FDCAN1_RAM_BASE && address < FDCAN1_RAM_BASE + FDCAN_RAM_SIZE) {
    const offset = address - FDCAN1_RAM_BASE;
    const wordOffset = offset & 0x3fc;
    const current = readRamAt(b, wordOffset);

    writeRamAt(b, wordOffset, merge(b, current, value, num(b, offset), size));
  }
}

/** 中断线 0/1 的挂起条件：IR & IE 的对应分组经过 ILS 路由且 ILE 使能。 */
export function fdcanPending(b: Body, line: 0 | 1): Value<boolean> {
  const ir = loadRegister(b, num(b, FDCAN_IR));
  const ie = loadRegister(b, num(b, FDCAN_IE));
  const ils = loadRegister(b, num(b, FDCAN_ILS));
  const ile = loadRegister(b, num(b, FDCAN_ILE));
  const enabled = b.bitAnd(ir, ie);
  let routed = num(b, 0);

  for (const group of FDCAN_ILS_GROUPS) {
    const selected = line === 0 ? b.not(boolBit(b, ils, group.bit)) : boolBit(b, ils, group.bit);
    const contribution = b.select(
      types.number,
      selected,
      (inner) => inner.constant(types.number, group.mask),
      (inner) => inner.constant(types.number, 0),
    );

    routed = b.bitOr(routed, contribution);
  }

  return b.notEqual(
    types.number,
    b.multiply(b.bitAnd(enabled, routed), b.bitAnd(ile, num(b, 1 << line))),
    num(b, 0),
  );
}

export function fdcanPendingAny(b: Body): Value<boolean> {
  return boolOr(b, fdcanPending(b, 0), fdcanPending(b, 1));
}

const fdcanInterrupts: readonly InterruptSource[] = [
  {
    exception: 16 + FDCAN1_IT0_IRQ,
    pending: (b) => fdcanPending(b, 0),
    acknowledge: () => {},
  },
  {
    exception: 16 + FDCAN1_IT1_IRQ,
    pending: (b) => fdcanPending(b, 1),
    acknowledge: () => {},
  },
];

export const FDCAN_MODULE: PeripheralModule = {
  id: 'fdcan1',
  ranges: [
    { base: FDCAN1_BASE, size: FDCAN_REGISTER_SIZE },
    { base: FDCAN1_RAM_BASE, size: FDCAN_RAM_SIZE },
  ],
  read: (b, address, size) => readFdcan(b, address, size),
  write: (b, address, size, value) => writeFdcan(b, address, size, value),
  slot: FDCAN_SLOT,
  advance: advanceFdcan,
  interrupts: fdcanInterrupts,
};

/** 编译期自检：Message RAM 元素不越过 1 KiB 窗口。 */
if (FDCAN_MESSAGE_RAM_END > FDCAN_RAM_SIZE) {
  throw new Error('fdcan: message RAM layout exceeds 1 KiB');
}

export * from './fdcan-layout';
