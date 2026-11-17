import { types } from '@mica-js/sdk/model';
import type { EnumValue, Value } from '@mica-js/sdk/model';
import { GPIO_SYNC, SERVICE_IRQ, SERVICE_PIN_SYNC } from './layout';
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
  u32,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { extract, merge, place } from './analog';
import { peripheralClockHz } from './clock-tree';
import { pinConfigured } from './alt-pin';
import { syncPin } from './gpio';
import { PORTS, machine } from './machine';
import type { AlternateDriver } from './machine';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { InterruptSource, PeripheralModule } from './peripheral';
import { cpuCyclePs, refreshTick } from './tick';
import {
  SPI,
  SPI_CONFIGS,
  SPI_CR1,
  SPI_CR2,
  SPI_CRCPR,
  SPI_DR,
  SPI_F_BIT,
  SPI_F_BITS,
  SPI_F_FLAGS,
  SPI_F_FRACTION,
  SPI_F_PHASE,
  SPI_F_REMAINING,
  SPI_F_RX,
  SPI_F_RX_SHIFT,
  SPI_F_TX,
  SPI_F_TX_SHIFT,
  SPI_FLAG_DR_READ,
  SPI_FLAG_OVR,
  SPI_FLAG_RX_FULL,
  SPI_FLAG_TX_LOADED,
  SPI_I2SCFGR,
  SPI_I2SPR,
  SPI_INTERNAL_OFFSET,
  SPI_RANGE_SIZE,
  SPI_REGISTER_SIZE,
  SPI_SLOT,
  SPI_SR,
  SPI_STATE,
  SPI_STATE_STRIDE,
} from './spi-layout';
import type { SpiConfig } from './spi-layout';

/**
 * SPI1/2/3 主机 full-duplex 移位模型。
 *
 * 支持 CPOL/CPHA/BR/LSBFIRST/SPE/MSTR、8/16 位（DS=7/15，也接受 1..16）、DR 写入
 * 启动一帧、TXE/RXNE/BSY/OVR、接收中断。SCK/MOSI 是推挽 AF 输出，MISO 只采样；
 * 每半个 SCK 周期推进一个边沿，数据在正确的边沿采样/改变。没有外部从机时可由板级
 * 把 MOSI 与 MISO 短接做真实回环。
 *
 * 边界：NSS 输入/输出与 MODF、CRC、I2S、DMA、FIFO、从机模式未建模；SCK 半周期
 * 由 `peripheralClockHz` 计算：SPI1 用 PCLK2，SPI2/3 用 PCLK1，跟随 RCC/APB 分频。
 */

const PHASE_IDLE = 0;
const PHASE_LEAD = 1;
const PHASE_TRAIL = 2;

const CR1_CPHA = 1 << 0;
const CR1_CPOL = 1 << 1;
const CR1_MSTR = 1 << 2;
const CR1_SPE = 1 << 6;
const CR1_LSBFIRST = 1 << 7;

const CR2_RXDMAEN = 1 << 0;
const CR2_TXDMAEN = 1 << 1;
const CR2_ERRIE = 1 << 5;
const CR2_RXNEIE = 1 << 6;
const CR2_TXEIE = 1 << 7;

const SR_RXNE = 1 << 0;
const SR_TXE = 1 << 1;
const SR_OVR = 1 << 6;
const SR_BSY = 1 << 7;

const stateBase = (config: SpiConfig): number => SPI_STATE + (config.index - 1) * SPI_STATE_STRIDE;
const internalBase = (config: SpiConfig): number => stateBase(config) + SPI_INTERNAL_OFFSET;

const loadReg = (b: Body, config: SpiConfig, offset: number): Value<number> =>
  readWordAt(b, SPI, stateBase(config) + offset);
const storeReg = (b: Body, config: SpiConfig, offset: number, value: Value<number>): void => {
  writeWordAt(b, SPI, stateBase(config) + offset, value);
};
const loadRegAt = (b: Body, config: SpiConfig, offset: Value<number>): Value<number> =>
  readWord(b, SPI, b.add(num(b, stateBase(config)), offset));
const storeRegAt = (
  b: Body,
  config: SpiConfig,
  offset: Value<number>,
  value: Value<number>,
): void => {
  writeWord(b, SPI, b.add(num(b, stateBase(config)), offset), value);
};

const loadInternal = (b: Body, config: SpiConfig, field: number): Value<number> =>
  readWordAt(b, SPI, internalBase(config) + field);
const storeInternal = (b: Body, config: SpiConfig, field: number, value: Value<number>): void => {
  writeWordAt(b, SPI, internalBase(config) + field, u32(b, value));
};

const loadFlags = (b: Body, config: SpiConfig): Value<number> =>
  loadInternal(b, config, SPI_F_FLAGS);
const storeFlags = (b: Body, config: SpiConfig, value: Value<number>): void => {
  storeInternal(b, config, SPI_F_FLAGS, value);
};

function setFlag(b: Body, config: SpiConfig, mask: number, set: Value<boolean>): void {
  const flags = loadFlags(b, config);
  const value = b.select(
    types.number,
    set,
    (inner) => inner.bitOr(flags, inner.constant(types.number, mask)),
    (inner) => inner.bitAnd(flags, inner.constant(types.number, ~mask >>> 0)),
  );

  storeFlags(b, config, value);
}

const activeFrame = (b: Body, config: SpiConfig): Value<boolean> =>
  b.notEqual(types.number, loadInternal(b, config, SPI_F_PHASE), num(b, 0));

const enabled = (b: Body, config: SpiConfig): Value<boolean> => {
  const cr1 = loadReg(b, config, SPI_CR1);

  return boolAnd(b, boolBit(b, cr1, CR1_SPE), boolBit(b, cr1, CR1_MSTR));
};

function cpol(b: Body, config: SpiConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, SPI_CR1), CR1_CPOL);
}

function cpha(b: Body, config: SpiConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, SPI_CR1), CR1_CPHA);
}

function lsbFirst(b: Body, config: SpiConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, SPI_CR1), CR1_LSBFIRST);
}

function dataBits(b: Body, config: SpiConfig): Value<number> {
  const ds = b.bitAnd(b.shiftRightUnsigned(loadReg(b, config, SPI_CR2), num(b, 8)), num(b, 0xf));

  return b.min(b.add(ds, num(b, 1)), num(b, 16));
}

function dataMask(b: Body, config: SpiConfig): Value<number> {
  const bits = dataBits(b, config);
  const shifted = b.subtract(b.shiftLeft(num(b, 1), bits), num(b, 1));
  const all = b.constant(types.number, 0xffff);

  return b.select(
    types.number,
    b.equal(types.number, bits, num(b, 16)),
    () => all,
    () => shifted,
  );
}

function halfPeriod(b: Body, config: SpiConfig): Value<number> {
  const cr1 = loadReg(b, config, SPI_CR1);
  const br = b.bitAnd(b.shiftRightUnsigned(cr1, num(b, 3)), num(b, 7));
  const hz = peripheralClockHz(b, config.clockName);
  const period = b.floor(
    b.divide(b.multiply(num(b, 1_000_000_000_000), b.shiftLeft(num(b, 1), br)), hz),
  );

  return b.select(
    types.number,
    b.greaterThan(hz, num(b, 0)),
    (inner) => inner.max(period, inner.constant(types.number, 1)),
    (inner) => inner.constant(types.number, 1),
  );
}

/** 精确皮秒 -> (核心周期, 余数) 两个 32 位字，保留每批小 elapsed。 */
function splitTime(
  b: Body,
  config: SpiConfig,
  cyclesField: number,
  fractionField: number,
  ps: Value<number>,
): void {
  const cyclePs = num(b, machine().cyclePs);
  const cycles = b.floor(b.divide(ps, cyclePs));
  const fraction = b.subtract(ps, b.multiply(cycles, cyclePs));

  storeInternal(b, config, cyclesField, cycles);
  storeInternal(b, config, fractionField, fraction);
}

function totalTime(
  b: Body,
  config: SpiConfig,
  cyclesField: number,
  fractionField: number,
): Value<number> {
  return b.add(
    b.multiply(loadInternal(b, config, cyclesField), num(b, machine().cyclePs)),
    loadInternal(b, config, fractionField),
  );
}

type LogicLevel = EnumValue<'Logic', 'low' | 'high' | 'unknown'>;

function pinLevel(b: Body, config: SpiConfig, role: 'miso'): Value<LogicLevel> {
  let level: Value<LogicLevel> = b.constant(types.logic, types.logic.members.unknown);

  for (const pin of config.pins) {
    if (pin.role !== role) continue;
    const name = PORTS[pin.port]?.pins[pin.pin];

    if (name === undefined || name === null) continue;
    const matches = pinConfigured(b, pin.port, pin.pin, pin.af);

    level = b.select(
      types.logic,
      matches,
      (inner) => inner.field(inner.readSample(name), 'level'),
      () => level,
    );
  }

  return level;
}

function misoHigh(b: Body, config: SpiConfig): Value<boolean> {
  return b.equal(
    types.logic,
    pinLevel(b, config, 'miso'),
    b.constant(types.logic, types.logic.members.high),
  );
}

/** SCK 高电平：CPOL=1 时 idle/trail 为高，leading 边沿为低；CPOL=0 相反。 */
function sckHigh(b: Body, config: SpiConfig): Value<boolean> {
  const phase = loadInternal(b, config, SPI_F_PHASE);
  const high = cpol(b, config);

  return b.select(
    types.bool,
    b.equal(types.number, phase, num(b, PHASE_LEAD)),
    (inner) => inner.not(high),
    () => high,
  );
}

function mosiBit(b: Body, config: SpiConfig): Value<number> {
  const phase = loadInternal(b, config, SPI_F_PHASE);
  const shift = loadInternal(b, config, SPI_F_TX_SHIFT);
  const bit = loadInternal(b, config, SPI_F_BIT);
  const bits = loadInternal(b, config, SPI_F_BITS);
  const lastBit = b.subtract(bits, num(b, 1));
  const safeBit = b.min(bit, lastBit);
  const position = b.select(
    types.number,
    lsbFirst(b, config),
    () => safeBit,
    (inner) => inner.subtract(lastBit, safeBit),
  );

  return b.select(
    types.number,
    b.equal(types.number, phase, num(b, PHASE_IDLE)),
    (inner) => inner.constant(types.number, 0),
    (inner) =>
      inner.bitAnd(inner.shiftRightUnsigned(shift, position), inner.constant(types.number, 1)),
  );
}

function mosiHigh(b: Body, config: SpiConfig): Value<boolean> {
  return b.notEqual(types.number, mosiBit(b, config), num(b, 0));
}

function lineLevel(b: Body, config: SpiConfig, role: 'sck' | 'mosi'): Value<boolean> {
  return role === 'sck' ? sckHigh(b, config) : mosiHigh(b, config);
}

export function spiSyncPins(b: Body, config: SpiConfig): void {
  for (const pin of config.pins) {
    if (pin.role === 'miso') continue;
    b.if(pinConfigured(b, pin.port, pin.pin, pin.af), (hit) => {
      syncPin(asBody(hit), pin.port, pin.pin);
    });
  }
}

function requestPinSync(b: Body, config: SpiConfig): void {
  let mask = 0;

  for (const pin of config.pins) {
    if (pin.role !== 'miso') mask |= 1 << pin.port;
  }
  b.writeState(GPIO_SYNC, b.bitOr(b.readState(GPIO_SYNC, types.number), num(b, mask)));
  markService(b, SERVICE_PIN_SYNC);
}

function irqDirty(b: Body): void {
  b.writeState('irqDirty', bool(b, true));
  markService(b, SERVICE_IRQ);
}

function startFrame(b: Body, config: SpiConfig, value: Value<number>): void {
  const bits = dataBits(b, config);
  const data = b.bitAnd(value, dataMask(b, config));

  storeInternal(b, config, SPI_F_TX_SHIFT, data);
  storeInternal(b, config, SPI_F_RX_SHIFT, num(b, 0));
  storeInternal(b, config, SPI_F_BIT, num(b, 0));
  storeInternal(b, config, SPI_F_BITS, bits);
  storeInternal(b, config, SPI_F_PHASE, num(b, PHASE_LEAD));
  splitTime(b, config, SPI_F_REMAINING, SPI_F_FRACTION, halfPeriod(b, config));
  setFlag(b, config, SPI_FLAG_TX_LOADED, bool(b, false));
  requestPinSync(b, config);
  irqDirty(b);
}

/** 完成一帧：写入 RXDR，必要时立即开始排队中的下一帧。 */
function completeFrame(b: Body, config: SpiConfig): void {
  const value = b.bitAnd(loadInternal(b, config, SPI_F_RX_SHIFT), dataMask(b, config));
  const alreadyFull = boolBit(b, loadFlags(b, config), SPI_FLAG_RX_FULL);
  const queued = boolBit(b, loadFlags(b, config), SPI_FLAG_TX_LOADED);

  setFlag(b, config, SPI_FLAG_OVR, alreadyFull);
  storeInternal(b, config, SPI_F_RX, value);
  setFlag(b, config, SPI_FLAG_RX_FULL, bool(b, true));
  irqDirty(b);
  b.if(
    queued,
    (next) => {
      const body = asBody(next);

      storeInternal(body, config, SPI_F_TX_SHIFT, loadInternal(body, config, SPI_F_TX));
      clearTxLoaded(body, config);
      storeInternal(body, config, SPI_F_RX_SHIFT, num(body, 0));
      storeInternal(body, config, SPI_F_BIT, num(body, 0));
      storeInternal(body, config, SPI_F_PHASE, num(body, PHASE_LEAD));
      splitTime(body, config, SPI_F_REMAINING, SPI_F_FRACTION, halfPeriod(body, config));
      requestPinSync(body, config);
    },
    (idle) => {
      const body = asBody(idle);

      storeInternal(body, config, SPI_F_PHASE, num(body, PHASE_IDLE));
      storeInternal(body, config, SPI_F_REMAINING, num(body, 0));
      storeInternal(body, config, SPI_F_FRACTION, num(body, 0));
      requestPinSync(body, config);
    },
  );
}

function clearTxLoaded(b: Body, config: SpiConfig): void {
  setFlag(b, config, SPI_FLAG_TX_LOADED, bool(b, false));
}

function shiftIn(b: Body, config: SpiConfig): void {
  const bit = loadInternal(b, config, SPI_F_BIT);
  const shift = loadInternal(b, config, SPI_F_RX_SHIFT);
  const high = misoHigh(b, config);
  const value = b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.constant(types.number, 0),
  );
  const next = b.select(
    types.number,
    lsbFirst(b, config),
    (inner) => inner.bitOr(shift, inner.shiftLeft(value, bit)),
    (inner) => inner.bitOr(inner.shiftLeft(shift, inner.constant(types.number, 1)), value),
  );

  storeInternal(b, config, SPI_F_RX_SHIFT, b.bitAnd(next, num(b, 0xffff)));
}

function advanceEdges(b: Body, config: SpiConfig, carry: Value<number>): void {
  const phase = loadInternal(b, config, SPI_F_PHASE);
  const edgeCpha = cpha(b, config);

  b.if(
    b.equal(types.number, phase, num(b, PHASE_LEAD)),
    (lead) => {
      const body = asBody(lead);

      body.if(
        edgeCpha,
        (second) => {
          const scope = asBody(second);

          storePhase(scope, config, PHASE_TRAIL, halfPeriod(scope, config), carry);
        },
        (first) => {
          const scope = asBody(first);

          shiftIn(scope, config);
          storeInternal(
            scope,
            config,
            SPI_F_BIT,
            scope.add(loadInternal(scope, config, SPI_F_BIT), num(scope, 1)),
          );
          storePhase(scope, config, PHASE_TRAIL, halfPeriod(scope, config), carry);
        },
      );
      requestPinSync(body, config);
    },
    (trail) => {
      const body = asBody(trail);
      const bits = loadInternal(body, config, SPI_F_BITS);
      const bit = loadInternal(body, config, SPI_F_BIT);

      body.if(
        edgeCpha,
        (second) => {
          const scope = asBody(second);

          shiftIn(scope, config);
          storeInternal(
            scope,
            config,
            SPI_F_BIT,
            scope.add(loadInternal(scope, config, SPI_F_BIT), num(scope, 1)),
          );
          scope.if(
            scope.greaterThanOrEqual(scope.add(bit, num(scope, 1)), bits),
            (done) => completeFrame(asBody(done), config),
            (more) =>
              storePhase(asBody(more), config, PHASE_LEAD, halfPeriod(asBody(more), config), carry),
          );
        },
        (first) => {
          const scope = asBody(first);

          scope.if(
            scope.greaterThanOrEqual(bit, bits),
            (done) => completeFrame(asBody(done), config),
            (more) =>
              storePhase(asBody(more), config, PHASE_LEAD, halfPeriod(asBody(more), config), carry),
          );
        },
      );
      requestPinSync(body, config);
    },
  );
}

function storePhase(
  b: Body,
  config: SpiConfig,
  phase: number,
  durationPs: Value<number>,
  carryPs: Value<number>,
): void {
  storeInternal(b, config, SPI_F_PHASE, num(b, phase));
  splitTime(
    b,
    config,
    SPI_F_REMAINING,
    SPI_F_FRACTION,
    b.max(num(b, 0), b.subtract(durationPs, carryPs)),
  );
}

export function advanceSpi(b: Body, elapsedPs: Value<number>): void {
  const wasActive = spiActive(b);

  for (const config of SPI_CONFIGS) {
    b.if(activeFrame(b, config), (active) => {
      const scope = asBody(active);
      const remaining = scope.subtract(
        totalTime(scope, config, SPI_F_REMAINING, SPI_F_FRACTION),
        elapsedPs,
      );

      scope.if(
        scope.greaterThan(remaining, num(scope, 0)),
        (hold) => splitTime(asBody(hold), config, SPI_F_REMAINING, SPI_F_FRACTION, remaining),
        (fire) => {
          const body = asBody(fire);
          const carry = body.max(num(body, 0), body.subtract(num(body, 0), remaining));

          advanceEdges(body, config, carry);
        },
      );
    });
  }
  b.if(boolAnd(b, wasActive, b.not(spiActive(b))), (done) => {
    const body = asBody(done);

    setPeripheralActive(body, SPI_SLOT, false);
    setPeripheralDeadline(body, SPI_SLOT, num(body, 0));
    refreshTick(body);
  });
}

export function spiActive(b: Body): Value<boolean> {
  let active = bool(b, false);

  for (const config of SPI_CONFIGS) active = boolOr(b, active, activeFrame(b, config));

  return active;
}

export function spiRequestedTickPs(b: Body): Value<number> {
  const result = b.local(types.number, 0);
  const seen = b.local(types.bool, false);

  for (const config of SPI_CONFIGS) {
    b.if(activeFrame(b, config), (active) => {
      const scope = asBody(active);
      const period = scope.max(cpuCyclePs(scope), halfPeriod(scope, config));

      scope.if(
        scope.getLocal(seen),
        (has) => {
          const body = asBody(has);

          body.setLocal(result, body.min(body.getLocal(result), period));
        },
        (first) => {
          const body = asBody(first);

          body.setLocal(seen, bool(body, true));
          body.setLocal(result, period);
        },
      );
    });
  }

  return b.getLocal(result);
}

export function spiNextDeadlinePs(b: Body): Value<number> {
  const result = b.local(types.number, 0);
  const seen = b.local(types.bool, false);

  for (const config of SPI_CONFIGS) {
    b.if(activeFrame(b, config), (active) => {
      const scope = asBody(active);
      const remaining = totalTime(scope, config, SPI_F_REMAINING, SPI_F_FRACTION);

      scope.if(
        scope.getLocal(seen),
        (has) => {
          const body = asBody(has);

          body.setLocal(result, body.min(body.getLocal(result), remaining));
        },
        (first) => {
          const body = asBody(first);

          body.setLocal(seen, bool(body, true));
          body.setLocal(result, remaining);
        },
      );
    });
  }

  return b.getLocal(result);
}

function srValue(b: Body, config: SpiConfig): Value<number> {
  const flags = loadFlags(b, config);
  const cr1 = loadReg(b, config, SPI_CR1);
  const phase = loadInternal(b, config, SPI_F_PHASE);
  const txe = boolBit(b, flags, SPI_FLAG_TX_LOADED);
  const rxne = boolBit(b, flags, SPI_FLAG_RX_FULL);
  const ovr = boolBit(b, flags, SPI_FLAG_OVR);
  const busy = boolAnd(
    b,
    boolBit(b, cr1, CR1_SPE),
    b.notEqual(types.number, phase, num(b, PHASE_IDLE)),
  );
  const bit = (condition: Value<boolean>, mask: number): Value<number> =>
    b.select(
      types.number,
      condition,
      (inner) => inner.constant(types.number, mask),
      (inner) => inner.constant(types.number, 0),
    );

  return b.bitOr(
    b.bitOr(bit(rxne, SR_RXNE), bit(b.not(txe), SR_TXE)),
    b.bitOr(bit(ovr, SR_OVR), bit(busy, SR_BSY)),
  );
}

export function readSpi(
  b: Body,
  config: SpiConfig,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const valid = b.lessThan(offset, num(b, SPI_REGISTER_SIZE));
  const lane = b.bitAnd(offset, num(b, 3));
  const bits = dataBits(b, config);
  const wide = b.greaterThan(bits, num(b, 8));
  const dataLane = boolAnd(
    b,
    b.lessThan(lane, num(b, 2)),
    boolOr(b, b.equal(types.number, lane, num(b, 0)), wide),
  );
  const result = b.local(types.number, 0);

  b.if(
    boolAnd(b, valid, b.equal(types.number, wordOffset, num(b, SPI_SR))),
    (sr) => {
      const scope = asBody(sr);
      const flags = loadFlags(scope, config);
      const drRead = boolBit(scope, flags, SPI_FLAG_DR_READ);

      scope.setLocal(result, srValue(scope, config));
      // RM0440：OVR 的清除序列是“先读 DR，再读 SR”；单独读 SR 不清。
      scope.if(drRead, (clear) => {
        const body = asBody(clear);

        setFlag(body, config, SPI_FLAG_OVR, bool(body, false));
        setFlag(body, config, SPI_FLAG_DR_READ, bool(body, false));
      });
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolAnd(
          body,
          valid,
          boolAnd(body, dataLane, body.equal(types.number, wordOffset, num(body, SPI_DR))),
        ),
        (dr) => {
          const scope = asBody(dr);

          scope.setLocal(result, loadInternal(scope, config, SPI_F_RX));
          setFlag(scope, config, SPI_FLAG_RX_FULL, bool(scope, false));
          // 只读 DR 不立即清 OVR；等随后读 SR 再清。
          setFlag(scope, config, SPI_FLAG_DR_READ, bool(scope, true));
          irqDirty(scope);
        },
        (stored) => {
          const scope = asBody(stored);

          scope.if(
            boolAnd(scope, valid, scope.lessThanOrEqual(wordOffset, num(scope, SPI_I2SPR))),
            (register) => {
              const body2 = asBody(register);

              body2.setLocal(result, loadRegAt(body2, config, wordOffset));
            },
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

function writeCr1(
  b: Body,
  config: SpiConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const current = loadReg(b, config, SPI_CR1);
  const merged = merge(b, current, value, offset, size);
  const before = boolBit(b, current, CR1_SPE);
  const after = boolBit(b, merged, CR1_SPE);

  storeReg(b, config, SPI_CR1, merged);
  b.if(boolAnd(b, before, b.not(after)), (off) => {
    const body = asBody(off);

    storeInternal(body, config, SPI_F_PHASE, num(body, PHASE_IDLE));
    storeInternal(body, config, SPI_F_REMAINING, num(body, 0));
    storeInternal(body, config, SPI_F_FRACTION, num(body, 0));
    setFlag(body, config, SPI_FLAG_TX_LOADED, bool(body, false));
    setFlag(body, config, SPI_FLAG_RX_FULL, bool(body, false));
    setFlag(body, config, SPI_FLAG_OVR, bool(body, false));
    setFlag(body, config, SPI_FLAG_DR_READ, bool(body, false));
    requestPinSync(body, config);
  });
  b.if(boolAnd(b, b.not(before), after), (on) => {
    const body = asBody(on);

    setFlag(body, config, SPI_FLAG_OVR, bool(body, false));
    setFlag(body, config, SPI_FLAG_RX_FULL, bool(body, false));
    setFlag(body, config, SPI_FLAG_DR_READ, bool(body, false));
  });
  requestPinSync(b, config);
  irqDirty(b);
}

function writeDr(
  b: Body,
  config: SpiConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const spe = enabled(b, config);
  const busy = activeFrame(b, config);
  const loaded = boolBit(b, loadFlags(b, config), SPI_FLAG_TX_LOADED);
  const lane = b.bitAnd(offset, num(b, 3));
  const bits = dataBits(b, config);
  const wide = b.greaterThan(bits, num(b, 8));
  const dataLane = boolAnd(
    b,
    b.lessThan(lane, num(b, 2)),
    boolOr(b, b.equal(types.number, lane, num(b, 0)), wide),
  );
  const data = b.bitAnd(place(b, value, offset, size), num(b, 0xffff));

  b.if(boolAnd(b, spe, dataLane), (enabledBody) => {
    const body = asBody(enabledBody);

    body.if(
      busy,
      (running) => {
        const scope = asBody(running);

        scope.if(scope.not(loaded), (room) => {
          const ready = asBody(room);

          storeInternal(ready, config, SPI_F_TX, data);
          setFlag(ready, config, SPI_FLAG_TX_LOADED, bool(ready, true));
          irqDirty(ready);
        });
      },
      (start) => startFrame(asBody(start), config, data),
    );
  });
  requestPinSync(b, config);
  irqDirty(b);
}

export function writeSpi(
  b: Body,
  config: SpiConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const valid = b.lessThan(offset, num(b, SPI_REGISTER_SIZE));

  b.if(
    boolAnd(b, valid, b.equal(types.number, wordOffset, num(b, SPI_CR1))),
    (hit) => writeCr1(asBody(hit), config, offset, size, value),
    (other) => {
      const body = asBody(other);

      body.if(
        boolAnd(body, valid, body.equal(types.number, wordOffset, num(body, SPI_DR))),
        (hit) => writeDr(asBody(hit), config, offset, size, value),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, SPI_SR)),
            () => {},
            (register) => {
              const body2 = asBody(register);

              body2.if(
                boolAnd(
                  body2,
                  valid,
                  boolOr(
                    body2,
                    body2.equal(types.number, wordOffset, num(body2, SPI_CR2)),
                    boolOr(
                      body2,
                      body2.equal(types.number, wordOffset, num(body2, SPI_CRCPR)),
                      boolOr(
                        body2,
                        body2.equal(types.number, wordOffset, num(body2, SPI_I2SCFGR)),
                        body2.equal(types.number, wordOffset, num(body2, SPI_I2SPR)),
                      ),
                    ),
                  ),
                ),
                (hit) => {
                  const body3 = asBody(hit);

                  storeRegAt(
                    body3,
                    config,
                    wordOffset,
                    merge(body3, loadRegAt(body3, config, wordOffset), value, offset, size),
                  );
                  irqDirty(body3);
                },
              );
            },
          );
        },
      );
    },
  );
  updateSpiSlot(b, true);
}

/**
 * SPI 的 DMA 请求条件：TX 为 SPE 且 TXDMAEN 且 TXE；RX 为 SPE 且 RXDMAEN 且
 * RXNE。数据仍由 DmaBus 对窄 DR 端点搬运，DR 读写的 OVR/清标志副作用保持。
 */
export function spiDmaRequestReady(b: Body, config: SpiConfig, tx: boolean): Value<boolean> {
  const cr1 = loadReg(b, config, SPI_CR1);
  const cr2 = loadReg(b, config, SPI_CR2);
  const flags = loadFlags(b, config);
  const spe = boolBit(b, cr1, CR1_SPE);
  const dma = boolBit(b, cr2, tx ? CR2_TXDMAEN : CR2_RXDMAEN);
  const ready = tx
    ? b.not(boolBit(b, flags, SPI_FLAG_TX_LOADED))
    : boolBit(b, flags, SPI_FLAG_RX_FULL);

  return boolAnd(b, dma, boolAnd(b, spe, ready));
}

export function spiPending(b: Body, config: SpiConfig): Value<boolean> {
  const cr2 = loadReg(b, config, SPI_CR2);
  const flags = loadFlags(b, config);

  return boolOr(
    b,
    boolAnd(b, boolBit(b, cr2, CR2_RXNEIE), boolBit(b, flags, SPI_FLAG_RX_FULL)),
    boolOr(
      b,
      boolAnd(b, boolBit(b, cr2, CR2_TXEIE), b.not(boolBit(b, flags, SPI_FLAG_TX_LOADED))),
      boolAnd(b, boolBit(b, cr2, CR2_ERRIE), boolBit(b, flags, SPI_FLAG_OVR)),
    ),
  );
}

export function spiDrivers(): readonly AlternateDriver[] {
  const drivers: AlternateDriver[] = [];

  for (const config of SPI_CONFIGS) {
    for (const pin of config.pins) {
      if (pin.role === 'miso') continue;
      const role = pin.role;

      drivers.push({
        port: pin.port,
        pin: pin.pin,
        af: pin.af,
        active: (b) => enabled(b, config),
        level: (b) => lineLevel(b, config, role),
      });
    }
  }

  return drivers;
}

/**
 * 把 SPI 的活动位/节拍写入中央 `peripheral.ts` 槽位。deadline 使用半个 SCK 周期，
 * 保证一个服务节拍最多跨一个边沿。
 */
function updateSpiSlot(b: Body, refresh: boolean): void {
  const active = spiActive(b);
  const deadline = spiRequestedTickPs(b);

  setPeripheralActive(b, SPI_SLOT, active);
  setPeripheralDeadline(
    b,
    SPI_SLOT,
    b.select(
      types.number,
      active,
      () => deadline,
      (inner) => inner.constant(types.number, 0),
    ),
  );
  if (refresh) refreshTick(b);
}

const inRange = (b: Body, address: Value<number>, base: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, SPI_RANGE_SIZE));

function readSpiAddress(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);
  const step = (body: Body, index: number): void => {
    const config = SPI_CONFIGS[index];

    if (config === undefined) return;
    body.if(
      inRange(body, address, config.base),
      (hit) => {
        const scope = asBody(hit);

        scope.setLocal(
          result,
          readSpi(scope, config, scope.subtract(address, num(scope, config.base)), size),
        );
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);

  return b.getLocal(result);
}

function writeSpiAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const step = (body: Body, index: number): void => {
    const config = SPI_CONFIGS[index];

    if (config === undefined) return;
    body.if(
      inRange(body, address, config.base),
      (hit) => {
        const scope = asBody(hit);

        writeSpi(scope, config, scope.subtract(address, num(scope, config.base)), size, value);
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

const spiInterrupts: readonly InterruptSource[] = SPI_CONFIGS.map((config) => ({
  exception: 16 + config.irq,
  pending: (b: Body) => spiPending(b, config),
  acknowledge: () => {},
}));

export const spiModule: PeripheralModule = {
  id: 'spi',
  ranges: SPI_CONFIGS.map((config) => ({ base: config.base, size: SPI_RANGE_SIZE })),
  read: readSpiAddress,
  write: writeSpiAddress,
  slot: SPI_SLOT,
  advance: advanceSpi,
  interrupts: spiInterrupts,
  alternateDrivers: spiDrivers(),
};

export {
  SPI1_BASE,
  SPI2_BASE,
  SPI3_BASE,
  SPI_CONFIGS,
  SPI_STATE,
  SPI_STATE_STRIDE,
} from './spi-layout';
