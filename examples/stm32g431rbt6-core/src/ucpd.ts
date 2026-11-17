import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import { IRQ_DIRTY, PERIPH, PeripheralSlot, RCC_RCC_STATE, SERVICE_IRQ, SYS, UCPD } from './layout';
import type { AccessSize } from './layout';
import { RCC_APB1ENR2, RCC_APB1RSTR2 } from './clock-tree';
import { PWR_CR3, PWR_REGISTERS } from './pwr';
import { asBody, bool, markService, num, readWord, readWordAt, u32, writeWordAt } from './ir';
import type { Body } from './ir';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { InterruptSource, PeripheralModule } from './peripheral';
import { refreshTick } from './tick';
import { RESET_COUNT } from './system-layout';
import {
  UCPD1_BASE,
  UCPD1_IRQ,
  UCPD1_SIZE,
  UCPD_CC1_PIN,
  UCPD_CC2_PIN,
  UCPD_CFG1,
  UCPD_CFG1_WRITABLE,
  UCPD_CFG2,
  UCPD_CFG2_WRITABLE,
  UCPD_CR,
  UCPD_CR_ANASUBMODE_SHIFT,
  UCPD_CR_CCENABLE_SHIFT,
  UCPD_CR_FRSTX,
  UCPD_CR_TXHRST,
  UCPD_CR_TXSEND,
  UCPD_CR_WRITABLE,
  UCPD_EVENT_OFFSET,
  UCPD_ICR,
  UCPD_ICR_WRITABLE,
  UCPD_IMR,
  UCPD_IMR_WRITABLE,
  UCPD_POLL_PS,
  UCPD_RD_OHM,
  UCPD_REGISTER_OFFSET,
  UCPD_RESET_MARKER,
  UCPD_RP_1_5A_OHM,
  UCPD_RP_3A_OHM,
  UCPD_RP_DEFAULT_OHM,
  UCPD_SR,
  UCPD_SR_FRSEVT,
  UCPD_SR_TXMSGDISC,
  UCPD_SR_HRSTDISC,
  UCPD_SR_TYPECEVT1,
  UCPD_SR_TYPECEVT2,
  UCPD_TXDR,
  UCPD_TX_ORDSET,
  UCPD_TX_PAYSZ,
  UCPD_VSTATE_OFFSET,
} from './ucpd-layout';

/**
 * STM32G431RBT6 UCPD1 的 Type-C 检测模型。
 *
 * 实现范围：
 * - UCPD_CFG1/CFG2/CR/IMR/SR/ICR 与 PD 数据寄存器的真实偏移；
 * - UCPDEN 使能/关闭；关闭时控制位按 RM 复位；
 * - ANAMODE/ANASUBMODE/CCENABLE/PHYCCSEL/CCxTCDIS；
 * - sink 模式 CC 线 5.1 kΩ Rd；source 模式 56 kΩ/22 kΩ/10 kΩ Rp；
 * - PWR_CR3.UCPD_DBDIS：DBDIS=0 时两条 CC 线保留 dead-battery Rd；DBDIS=1 后
 *   才由 UCPD 配置接管；
 * - RCC_APB1ENR2.UCPD1EN 与 APB1RSTR2.UCPD1RST 门控；
 * - 从 `PB6`/`PB4` 的真实引脚电压采样 TYPEC_VSTATE_CC1/2，按 0.2 V / 0.65 V
 *   阈值映射 1/2/3；检测到变化置 TYPECEVT1/2；
 * - TYPECEVT1/2 的 IMR/ICR/IRQ 63；SR 为只读合成寄存器；
 * - 寄存器 byte/halfword/word 部分访问；复位移位标记使用 sys 的复位计数。
 *
 * 明确未实现：
 * - BMC 编解码、4b5b、PD 报文/FIFO/CRC、Hard Reset、Cable Reset、BIST、FRS；
 * - VBUS/VCONN 策略、功率角色协商、Type-C 完整状态机；
 * - 源模式 Rp 的 VBUS 参考（本器件 DDL 没有 VBUS 引脚，暂以 VDD1 代替）；
 * - RXDR/TXDR 的字节流语义；TXSEND/TXHRST 只置 discard 标志，不伪造发送成功；
 * - CC 去抖的具体滤波时间；模型以 1 ms 服务节拍采样。
 */

const UCPD_SLOT = PeripheralSlot.Ucpd;

const readRegAt = (b: Body, offset: number): Value<number> =>
  readWordAt(b, UCPD, UCPD_REGISTER_OFFSET + offset);
const readReg = (b: Body, offset: Value<number>): Value<number> =>
  readWord(b, UCPD, b.add(num(b, UCPD_REGISTER_OFFSET), offset));
const storeRegAt = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, UCPD, UCPD_REGISTER_OFFSET + offset, value);
};
const readEvent = (b: Body): Value<number> => readWordAt(b, UCPD, UCPD_EVENT_OFFSET);
const storeEvent = (b: Body, value: Value<number>): void => {
  writeWordAt(b, UCPD, UCPD_EVENT_OFFSET, value);
};
const readVstate = (b: Body): Value<number> => readWordAt(b, UCPD, UCPD_VSTATE_OFFSET);
const storeVstate = (b: Body, value: Value<number>): void => {
  writeWordAt(b, UCPD, UCPD_VSTATE_OFFSET, value);
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

const widthOf = (size: number): number => (size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff);

const place = (
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return u32(b, value);
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, widthOf(size))), shift);
};

const maskAt = (b: Body, offset: Value<number>, size: number): Value<number> => {
  if (size === 4) return num(b, 0xffffffff);
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(num(b, widthOf(size)), shift);
};

const u32Of = (b: Body, value: Value<number>): Value<number> => u32(b, value);

const expectedMarker = (b: Body): Value<number> =>
  u32Of(b, b.bitXor(readWordAt(b, SYS, RESET_COUNT), num(b, 0xffffffff)));
const ready = (b: Body): Value<boolean> =>
  b.equal(types.number, u32Of(b, readWordAt(b, UCPD, UCPD_RESET_MARKER)), expectedMarker(b));

const setIrq = (b: Body): void => {
  b.writeState(IRQ_DIRTY, bool(b, true));
  markService(b, SERVICE_IRQ);
};

/**
 * 寄存器访问门控。`APB1ENR2.UCPD1EN` 为 1 且 `APB1RSTR2.UCPD1RST` 为 0 才有时钟。
 * 用 0/1 数值计算，避免把 bool 合成留在热路径里。
 */
function gateNumeric(b: Body): Value<number> {
  const enabled = b.bitAnd(readWordAt(b, PERIPH, RCC_RCC_STATE + RCC_APB1ENR2), num(b, 1 << 8));
  const reset = b.bitAnd(readWordAt(b, PERIPH, RCC_RCC_STATE + RCC_APB1RSTR2), num(b, 1 << 8));
  const enabledBit = b.shiftRightUnsigned(enabled, num(b, 8));
  const resetBit = b.shiftRightUnsigned(reset, num(b, 8));

  return b.multiply(enabledBit, b.subtract(num(b, 1), resetBit));
}

/** PWR_CR3.UCPD_DBDIS 的 0/1 值；0 表示 dead-battery Rd 仍接在 CC 上。 */
function dbdisNumeric(b: Body): Value<number> {
  return b.shiftRightUnsigned(
    b.bitAnd(readWordAt(b, PERIPH, PWR_REGISTERS + PWR_CR3), num(b, 1 << 14)),
    num(b, 14),
  );
}

const nonzero = (b: Body, value: Value<number>): Value<boolean> =>
  b.notEqual(types.number, value, num(b, 0));

function zeroRegister(b: Body): void {
  for (let offset = 0; offset < 0x40; offset += 4) {
    storeRegAt(b, offset, num(b, 0));
  }
  storeEvent(b, num(b, 0));
  storeVstate(b, num(b, 0));
}

/** 首次写/推进时清空寄存器与私有状态，并写复位标记。 */
export function resetUcpd(b: Body): void {
  zeroRegister(b);
  writeWordAt(b, UCPD, UCPD_RESET_MARKER, expectedMarker(b));
}

function ensureReset(b: Body): void {
  b.if(b.not(ready(b)), (init) => {
    resetUcpd(asBody(init));
  });
}

interface CcConfig {
  readonly gate: Value<number>;
  readonly dbdis: Value<number>;
  readonly ucpden: Value<number>;
  readonly cr: Value<number>;
  readonly cc1: Value<number>;
  readonly cc2: Value<number>;
  readonly anmode: Value<number>;
  readonly anasub: Value<number>;
}

function ccConfig(b: Body): CcConfig {
  const gate = gateNumeric(b);
  const dbdis = dbdisNumeric(b);
  const cfg1 = readRegAt(b, UCPD_CFG1);
  const cr = readRegAt(b, UCPD_CR);
  const ucpden = b.bitAnd(b.shiftRightUnsigned(cfg1, num(b, 31)), num(b, 1));
  const ccenable = b.bitAnd(b.shiftRightUnsigned(cr, num(b, UCPD_CR_CCENABLE_SHIFT)), num(b, 3));
  const cc1Disabled = b.bitAnd(b.shiftRightUnsigned(cr, num(b, 20)), num(b, 1));
  const cc2Disabled = b.bitAnd(b.shiftRightUnsigned(cr, num(b, 21)), num(b, 1));
  const cc1 = b.multiply(b.bitAnd(ccenable, num(b, 1)), b.subtract(num(b, 1), cc1Disabled));
  const cc2 = b.multiply(
    b.bitAnd(b.shiftRightUnsigned(ccenable, num(b, 1)), num(b, 1)),
    b.subtract(num(b, 1), cc2Disabled),
  );
  const anmode = b.bitAnd(b.shiftRightUnsigned(cr, num(b, 9)), num(b, 1));
  const anasub = b.bitAnd(b.shiftRightUnsigned(cr, num(b, UCPD_CR_ANASUBMODE_SHIFT)), num(b, 3));

  return { gate, dbdis, ucpden, cr, cc1, cc2, anmode, anasub };
}

/** 一条 CC 线的正电阻 intent：dead-battery/sink 为 Rd，source 为 Rp。 */
function ccIntent(
  b: Body,
  pin: string,
  lineEnable: Value<number>,
  dbdis: Value<number>,
  anmode: Value<number>,
  anasub: Value<number>,
): void {
  const deadBattery = b.subtract(num(b, 1), dbdis);
  const sink = b.multiply(lineEnable, anmode);
  const source = b.multiply(lineEnable, b.subtract(num(b, 1), anmode));
  const sourceDefault = b.multiply(
    source,
    b.select(
      types.number,
      b.equal(types.number, anasub, num(b, 1)),
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
  const source15 = b.multiply(
    source,
    b.select(
      types.number,
      b.equal(types.number, anasub, num(b, 2)),
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
  const source3 = b.multiply(
    source,
    b.select(
      types.number,
      b.equal(types.number, anasub, num(b, 3)),
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );

  const resistor = (body: Body, target: string, ohm: number): Value<IntentValue> =>
    body.resistor(target, body.constant(types.number, ohm));

  let intent = b.select(
    types.intent,
    nonzero(b, deadBattery),
    (inner) => resistor(asBody(inner), 'VSS1', UCPD_RD_OHM),
    (inner) => inner.combineIntents(),
  );

  intent = b.select(
    types.intent,
    nonzero(b, sink),
    (inner) => resistor(asBody(inner), 'VSS1', UCPD_RD_OHM),
    () => intent,
  );
  intent = b.select(
    types.intent,
    nonzero(b, sourceDefault),
    (inner) => resistor(asBody(inner), 'VDD1', UCPD_RP_DEFAULT_OHM),
    () => intent,
  );
  intent = b.select(
    types.intent,
    nonzero(b, source15),
    (inner) => resistor(asBody(inner), 'VDD1', UCPD_RP_1_5A_OHM),
    () => intent,
  );
  intent = b.select(
    types.intent,
    nonzero(b, source3),
    (inner) => resistor(asBody(inner), 'VDD1', UCPD_RP_3A_OHM),
    () => intent,
  );

  b.writeIntent(pin, intent);
}

/** 根据 PWR/RCC/CR 更新 CC1/CC2 的正电阻 intent。 */
export function syncCcIntents(b: Body): void {
  const config = ccConfig(b);
  const base = b.multiply(b.multiply(config.gate, config.ucpden), config.dbdis);
  const line1 = b.multiply(base, config.cc1);
  const line2 = b.multiply(base, config.cc2);

  ccIntent(b, UCPD_CC1_PIN, line1, config.dbdis, config.anmode, config.anasub);
  ccIntent(b, UCPD_CC2_PIN, line2, config.dbdis, config.anmode, config.anasub);
}

function pinVoltage(b: Body, pin: string): Value<number> {
  const voltage = b.field(b.readSample(pin), 'voltage');

  return b.select(
    types.number,
    b.isNone(voltage),
    (inner) => inner.constant(types.number, 0),
    (present) => present.nonNull(voltage),
  );
}

/** 单条 CC 线的 VSTATE：0=关闭，1=vRa/低，2=vRd-USB，3=vRd-1.5/3.0 或 vOpen。 */
function voltageState(b: Body, pin: string, detector: Value<number>): Value<number> {
  const voltage = pinVoltage(b, pin);
  const result = b.local(types.number, 0);

  b.if(nonzero(b, detector), (enabled) => {
    const body = asBody(enabled);

    body.setLocal(result, num(body, 1));
    body.if(body.greaterThan(voltage, num(body, 0.2)), (low) => {
      asBody(low).setLocal(result, num(asBody(low), 2));
    });
    body.if(body.greaterThan(voltage, num(body, 0.65)), (high) => {
      asBody(high).setLocal(result, num(asBody(high), 3));
    });
  });

  return b.getLocal(result);
}

/**
 * 采样 CC1/CC2 电压并维护 TYPECEVT1/2。只有检测器真正使能时才产生电压变化事件；
 * 检测器关闭时把上一状态清 0，避免重新使能时把旧状态当成变化。
 */
export function sampleTypeC(b: Body): void {
  const config = ccConfig(b);
  const base = b.multiply(b.multiply(config.gate, config.ucpden), config.dbdis);
  const detector1 = b.multiply(base, config.cc1);
  const detector2 = b.multiply(base, config.cc2);
  const state1 = voltageState(b, UCPD_CC1_PIN, detector1);
  const state2 = voltageState(b, UCPD_CC2_PIN, detector2);
  const vstate = readVstate(b);
  const previous1 = b.bitAnd(vstate, num(b, 3));
  const previous2 = b.bitAnd(b.shiftRightUnsigned(vstate, num(b, 2)), num(b, 3));
  const event = readEvent(b);
  const changed1 = b.notEqual(types.number, state1, previous1);
  const changed2 = b.notEqual(types.number, state2, previous2);
  const eventAdd = b.local(types.number, 0);
  const nextVstate = b.bitOr(
    b.bitAnd(vstate, num(b, ~0xf)),
    b.bitOr(state1, b.shiftLeft(state2, num(b, 2))),
  );

  b.if(nonzero(b, detector1), (active) => {
    const body = asBody(active);

    body.if(changed1, (changed) => {
      asBody(changed).setLocal(eventAdd, num(asBody(changed), UCPD_SR_TYPECEVT1));
    });
  });
  b.if(nonzero(b, detector2), (active) => {
    const body = asBody(active);

    body.if(changed2, (changed) => {
      const inner = asBody(changed);

      inner.setLocal(
        eventAdd,
        inner.bitOr(inner.getLocal(eventAdd), inner.constant(types.number, UCPD_SR_TYPECEVT2)),
      );
    });
  });

  const nextEvent = b.bitOr(event, b.getLocal(eventAdd));

  storeVstate(b, nextVstate);
  storeEvent(b, nextEvent);
  b.if(nonzero(b, b.getLocal(eventAdd)), (raised) => {
    setIrq(asBody(raised));
  });
}

function updateUcpdSlot(b: Body): void {
  const config = ccConfig(b);
  const detecting = b.multiply(
    b.multiply(b.multiply(config.gate, config.ucpden), config.dbdis),
    b.bitOr(config.cc1, config.cc2),
  );
  const active = nonzero(b, detecting);

  setPeripheralActive(b, UCPD_SLOT, active);
  setPeripheralDeadline(
    b,
    UCPD_SLOT,
    b.select(
      types.number,
      active,
      (inner) => inner.constant(types.number, UCPD_POLL_PS),
      (inner) => inner.constant(types.number, 0),
    ),
  );
  refreshTick(b);
}

/** 1 ms 节拍：同步 intent、采样电压、维护事件。 */
export function advanceUcpd(b: Body, elapsedPs: Value<number>): void {
  void elapsedPs;
  ensureReset(b);
  syncCcIntents(b);
  sampleTypeC(b);
  updateUcpdSlot(b);
}

/* ---------------- 寄存器读 ---------------- */

function srValue(b: Body): Value<number> {
  syncCcIntents(b);
  sampleTypeC(b);

  const event = readEvent(b);
  const vstate = readVstate(b);

  return b.bitOr(event, b.shiftLeft(vstate, num(b, 16)));
}

function registerValue(
  b: Body,
  wordOffset: Value<number>,
  readyValue: Value<boolean>,
): Value<number> {
  const stored = readReg(b, wordOffset);
  const result = b.local(
    types.number,
    b.select(
      types.number,
      readyValue,
      () => stored,
      (inner) => inner.constant(types.number, 0),
    ),
  );

  b.if(readyValue, (initialized) => {
    const body = asBody(initialized);

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_SR)), (hit) => {
      const scope = asBody(hit);

      scope.setLocal(result, srValue(scope));
    });
    body.if(body.equal(types.number, wordOffset, num(body, UCPD_ICR)), (hit) => {
      asBody(hit).setLocal(result, num(asBody(hit), 0));
    });
  });

  return b.getLocal(result);
}

export function readUcpd(b: Body, address: Value<number>, size: number): Value<number> {
  ensureReset(b);
  syncCcIntents(b);
  const offset = b.subtract(address, num(b, UCPD1_BASE));
  const result = b.local(types.number, 0);

  b.if(b.lessThan(u32(b, offset), num(b, UCPD1_SIZE)), (hit) => {
    const body = asBody(hit);
    const wordOffset = body.bitAnd(offset, num(body, 0x3fc));

    body.if(body.lessThan(wordOffset, num(body, 0x40)), (modeled) => {
      const scope = asBody(modeled);
      const word = registerValue(scope, wordOffset, ready(scope));

      scope.setLocal(result, extract(scope, word, offset, size));
    });
  });

  return b.getLocal(result);
}

export function readUcpdAt(b: Body, address: number, size: number): Value<number> {
  if (address < UCPD1_BASE || address >= UCPD1_BASE + UCPD1_SIZE) return num(b, 0);
  ensureReset(b);
  syncCcIntents(b);
  const offset = address - UCPD1_BASE;

  if (offset >= 0x40) return num(b, 0);
  const wordOffset = offset & 0x3fc;
  const word = registerValue(b, num(b, wordOffset), ready(b));

  return extractAt(b, word, offset, size);
}

/* ---------------- 寄存器写 ---------------- */

function writeCfg1(
  b: Body,
  current: Value<number>,
  placed: Value<number>,
  mask: Value<number>,
): void {
  const requested = b.bitOr(b.bitAnd(current, b.bitNot(mask)), b.bitAnd(placed, mask));
  const currentEnabled = b.bitAnd(b.shiftRightUnsigned(current, num(b, 31)), num(b, 1));
  const nextEnabled = b.bitAnd(b.shiftRightUnsigned(requested, num(b, 31)), num(b, 1));
  const config = b.bitAnd(requested, num(b, UCPD_CFG1_WRITABLE));

  b.if(
    b.equal(types.number, nextEnabled, num(b, 0)),
    (disable) => {
      const body = asBody(disable);

      zeroRegister(body);
      storeRegAt(body, UCPD_CFG1, num(body, 0));
    },
    (enable) => {
      const body = asBody(enable);

      body.if(
        body.equal(types.number, currentEnabled, num(body, 0)),
        (turnOn) => {
          storeRegAt(asBody(turnOn), UCPD_CFG1, config);
        },
        (alreadyOn) => {
          storeRegAt(asBody(alreadyOn), UCPD_CFG1, current);
        },
      );
    },
  );
}

function writeCr(
  b: Body,
  current: Value<number>,
  placed: Value<number>,
  mask: Value<number>,
): void {
  const requested = b.bitOr(b.bitAnd(current, b.bitNot(mask)), b.bitAnd(placed, mask));
  const writable = b.bitAnd(requested, num(b, UCPD_CR_WRITABLE));
  const txSend = b.bitAnd(writable, num(b, UCPD_CR_TXSEND));
  const txHrst = b.bitAnd(writable, num(b, UCPD_CR_TXHRST));
  const frstx = b.bitAnd(writable, num(b, UCPD_CR_FRSTX));
  const next = b.bitAnd(writable, num(b, ~(UCPD_CR_TXSEND | UCPD_CR_TXHRST | UCPD_CR_FRSTX)));
  const event = readEvent(b);
  const discarded = b.bitOr(
    b.bitOr(
      b.select(
        types.number,
        nonzero(b, txSend),
        (inner) => inner.constant(types.number, UCPD_SR_TXMSGDISC),
        (inner) => inner.constant(types.number, 0),
      ),
      b.select(
        types.number,
        nonzero(b, txHrst),
        (inner) => inner.constant(types.number, UCPD_SR_HRSTDISC),
        (inner) => inner.constant(types.number, 0),
      ),
    ),
    b.select(
      types.number,
      nonzero(b, frstx),
      (inner) => inner.constant(types.number, UCPD_SR_FRSEVT),
      (inner) => inner.constant(types.number, 0),
    ),
  );

  storeRegAt(b, UCPD_CR, next);
  storeEvent(b, b.bitOr(event, discarded));
  b.if(nonzero(b, discarded), (raised) => setIrq(asBody(raised)));
}

function writeUcpdRegisters(
  b: Body,
  offset: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const current = readReg(b, wordOffset);
  const placed = place(b, value, offset, size);
  const mask = maskAt(b, offset, size);
  const enabled = b.bitAnd(b.shiftRightUnsigned(readRegAt(b, UCPD_CFG1), num(b, 31)), num(b, 1));

  b.if(b.lessThan(wordOffset, num(b, 0x40)), (modeled) => {
    const body = asBody(modeled);

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_CFG1)), (hit) => {
      writeCfg1(asBody(hit), current, placed, mask);
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_CFG2)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 0)), (off) => {
        storeRegAt(
          asBody(off),
          UCPD_CFG2,
          asBody(off).bitAnd(placed, asBody(off).constant(types.number, UCPD_CFG2_WRITABLE)),
        );
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_CR)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        writeCr(asBody(on), current, placed, mask);
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_IMR)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        storeRegAt(
          asBody(on),
          UCPD_IMR,
          asBody(on).bitAnd(placed, asBody(on).constant(types.number, UCPD_IMR_WRITABLE)),
        );
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_ICR)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        const scope = asBody(on);
        const clear = scope.bitAnd(placed, scope.constant(types.number, UCPD_ICR_WRITABLE));
        const event = readEvent(scope);

        storeEvent(scope, scope.bitAnd(event, scope.bitNot(clear)));
        storeRegAt(scope, UCPD_ICR, num(scope, 0));
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_TX_ORDSET)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        storeRegAt(
          asBody(on),
          UCPD_TX_ORDSET,
          asBody(on).bitAnd(placed, asBody(on).constant(types.number, 0xfffff)),
        );
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_TX_PAYSZ)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        storeRegAt(
          asBody(on),
          UCPD_TX_PAYSZ,
          asBody(on).bitAnd(placed, asBody(on).constant(types.number, 0x3ff)),
        );
      });
    });

    body.if(body.equal(types.number, wordOffset, num(body, UCPD_TXDR)), (hit) => {
      const inner = asBody(hit);

      inner.if(inner.equal(types.number, enabled, num(inner, 1)), (on) => {
        storeRegAt(
          asBody(on),
          UCPD_TXDR,
          asBody(on).bitAnd(placed, asBody(on).constant(types.number, 0xff)),
        );
      });
    });
  });

  syncCcIntents(b);
  updateUcpdSlot(b);
}

export function writeUcpd(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const offset = b.subtract(address, num(b, UCPD1_BASE));

  b.if(b.lessThan(u32(b, offset), num(b, UCPD1_SIZE)), (hit) => {
    const body = asBody(hit);

    ensureReset(body);
    writeUcpdRegisters(body, offset, size, value);
  });
}

export function writeUcpdAt(
  b: Body,
  address: number,
  size: AccessSize,
  value: Value<number>,
): void {
  if (address < UCPD1_BASE || address >= UCPD1_BASE + UCPD1_SIZE) return;
  ensureReset(b);
  writeUcpdRegisters(b, num(b, address - UCPD1_BASE), size, value);
}

/** UCPD 全局中断：SR & IMR 且门控打开。 */
export function ucpdPending(b: Body): Value<boolean> {
  const clocked = b.multiply(
    gateNumeric(b),
    b.bitAnd(b.shiftRightUnsigned(readRegAt(b, UCPD_CFG1), num(b, 31)), num(b, 1)),
  );
  const event = readEvent(b);
  const imr = readRegAt(b, UCPD_IMR);
  return nonzero(b, b.multiply(clocked, b.bitAnd(b.bitAnd(event, imr), num(b, UCPD_IMR_WRITABLE))));
}

const ucpdInterrupt: InterruptSource = {
  exception: 16 + UCPD1_IRQ,
  pending: (b) => ucpdPending(b),
  acknowledge: () => {},
};

export const UCPD_MODULE: PeripheralModule = {
  id: 'ucpd1',
  ranges: [{ base: UCPD1_BASE, size: UCPD1_SIZE }],
  read: (b, address, size) => readUcpd(b, address, size),
  write: (b, address, size, value) => writeUcpd(b, address, size, value),
  slot: UCPD_SLOT,
  advance: advanceUcpd,
  interrupts: [ucpdInterrupt],
};

export * from './ucpd-layout';
