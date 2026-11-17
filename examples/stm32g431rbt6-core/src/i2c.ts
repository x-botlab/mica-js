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
import { peripheralClockHz, readClockEpoch } from './clock-tree';
import { pinConfigured } from './alt-pin';
import { syncPin } from './gpio';
import { PORTS, machine } from './machine';
import type { AlternateDriver } from './machine';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { InterruptSource, PeripheralModule } from './peripheral';
import { cpuCyclePs, refreshTick } from './tick';
import {
  I2C,
  I2C_CONFIGS,
  I2C_CR1,
  I2C_CR2,
  I2C_FLAG_ADDR,
  I2C_FLAG_NACK,
  I2C_FLAG_OVR,
  I2C_FLAG_RX_FULL,
  I2C_FLAG_START_PENDING,
  I2C_FLAG_STOP,
  I2C_FLAG_STOP_PENDING,
  I2C_FLAG_TC,
  I2C_FLAG_TCR,
  I2C_FLAG_TIMEOUT,
  I2C_FLAG_TX_LOADED,
  I2C_F_BIT,
  I2C_F_CLOCK_EPOCH,
  I2C_F_FLAGS,
  I2C_F_FRACTION,
  I2C_F_HIGH_PS,
  I2C_F_LOW_PS,
  I2C_F_PRESC_PS,
  I2C_F_PHASE,
  I2C_F_REMAINING,
  I2C_F_RX,
  I2C_F_SCRATCH,
  I2C_F_SHIFT,
  I2C_F_STRETCH,
  I2C_F_STRETCH_FRACTION,
  I2C_F_TIMEOUT,
  I2C_F_TX,
  I2C_ICR,
  I2C_INTERNAL_OFFSET,
  I2C_ISR,
  I2C_OAR1,
  I2C_OAR2,
  I2C_RANGE_SIZE,
  I2C_REGISTER_SIZE,
  I2C_RXDR,
  I2C_SLOT,
  I2C_STATE,
  I2C_STATE_STRIDE,
  I2C_TIMEOUTR,
  I2C_TIMINGR,
  I2C_TXDR,
} from './i2c-layout';
import type { I2cConfig } from './i2c-layout';

/**
 * I2C1/2/3 主机模型（I2C v2 外设）。
 *
 * 实现范围是 HAL 轮询/中断主机路径：7 位地址、START/重复 START/STOP、NBYTES/
 * AUTOEND/RELOAD、发送 TXIS→TXDR、接收 RXNE→RXDR、ACK/NACK、TC/TCR/STOPF/NACKF、
 * 时钟拉伸与总线卡低超时。寄存器支持 byte/halfword/word 访问，ISR 动态合成，ICR
 * 为 W1C，只读寄存器写入忽略。
 *
 * 总线不靠直接调用从机：SCL/SDA 是 AF 开漏引脚，拉低时驱动 VSS1，释放时由上拉
 * 电阻决定高电平；每个相位切换后通过 `syncPin` 刷新真实引脚意图。ACK/读数据都在
 * SCL 高电平期间从 SDA 采样。
 *
 * 内部相位放在 `periph` 的 I2C 专属段（见 i2c-layout.ts），不要求 DDL 新增 state。
 * 服务节拍需要不长于最短暂相位；`i2cRequestedTickPs` 供中央 `refreshTick` 取最小值。
 */

const PHASE_IDLE = 0;
const PHASE_START_SETUP = 1;
const PHASE_START_LOW = 2;
/** 保留编码；BIT_FALL 是零时刻 SDA/ACK 边界，状态机不再把它存成计时的 SCLL 相位。 */
const PHASE_BIT_FALL = 3;
const PHASE_BIT_LOW = 4;
const PHASE_BIT_HIGH = 5;
const PHASE_WAIT_TX = 6;
const PHASE_WAIT_STOP = 7;
const PHASE_STOP_LOW_SETUP = 8;
const PHASE_STOP_LOW = 9;
const PHASE_STOP_HIGH = 10;
const PHASE_STOP_RELEASE = 11;
const PHASE_REP_LOW = 12;
const PHASE_REP_RELEASE = 13;
const PHASE_REP_HIGH = 14;
const PHASE_REP_START = 15;
const PHASE_WAIT_TCR = 16;

/** 内部 flags 的 BYTE_DONE 位：ACK 位已结束，下一次 SCL 低电平开始新字节。 */
const FLAG_BYTE_DONE = 1 << 11;

const CR1_PE = 1 << 0;
const CR1_TXIE = 1 << 1;
const CR1_RXIE = 1 << 2;
const CR1_ADDRIE = 1 << 3;
const CR1_NACKIE = 1 << 4;
const CR1_STOPIE = 1 << 5;
const CR1_TCIE = 1 << 6;
const CR1_ERRIE = 1 << 7;
const CR1_TXDMAEN = 1 << 14;
const CR1_RXDMAEN = 1 << 15;

const CR2_RD_WRN = 1 << 10;
const CR2_START = 1 << 13;
const CR2_STOP = 1 << 14;
const CR2_RELOAD = 1 << 24;
const CR2_AUTOEND = 1 << 25;

const ISR_TXE = 1 << 0;
const ISR_TXIS = 1 << 1;
const ISR_RXNE = 1 << 2;
const ISR_ADDR = 1 << 3;
const ISR_NACKF = 1 << 4;
const ISR_STOPF = 1 << 5;
const ISR_TC = 1 << 6;
const ISR_TCR = 1 << 7;
const ISR_OVR = 1 << 10;
const ISR_TIMEOUT = 1 << 12;
const ISR_BUSY = 1 << 15;
const ISR_DIR = 1 << 16;

const ICR_ADDRCF = 1 << 3;
const ICR_NACKCF = 1 << 4;
const ICR_STOPCF = 1 << 5;
const ICR_BERRCF = 1 << 8;
const ICR_ARLOCF = 1 << 9;
const ICR_OVRCF = 1 << 10;
const ICR_PECCF = 1 << 11;
const ICR_TIMOUTCF = 1 << 12;
const ICR_ALERTCF = 1 << 13;

const TIMEOUTR_TIMOUTEN = 1 << 15;

const stateBase = (config: I2cConfig): number => I2C_STATE + (config.index - 1) * I2C_STATE_STRIDE;
const internalBase = (config: I2cConfig): number => stateBase(config) + I2C_INTERNAL_OFFSET;

const loadReg = (b: Body, config: I2cConfig, offset: number): Value<number> =>
  readWordAt(b, I2C, stateBase(config) + offset);
const storeReg = (b: Body, config: I2cConfig, offset: number, value: Value<number>): void => {
  writeWordAt(b, I2C, stateBase(config) + offset, value);
};
const loadRegAt = (b: Body, config: I2cConfig, offset: Value<number>): Value<number> =>
  readWord(b, I2C, b.add(num(b, stateBase(config)), offset));
const storeRegAt = (
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  value: Value<number>,
): void => {
  writeWord(b, I2C, b.add(num(b, stateBase(config)), offset), value);
};

const loadInternal = (b: Body, config: I2cConfig, field: number): Value<number> =>
  readWordAt(b, I2C, internalBase(config) + field);
const storeInternal = (b: Body, config: I2cConfig, field: number, value: Value<number>): void => {
  writeWordAt(b, I2C, internalBase(config) + field, u32(b, value));
};

const loadFlags = (b: Body, config: I2cConfig): Value<number> =>
  loadInternal(b, config, I2C_F_FLAGS);
const storeFlags = (b: Body, config: I2cConfig, value: Value<number>): void => {
  storeInternal(b, config, I2C_F_FLAGS, value);
};

function setFlag(b: Body, config: I2cConfig, mask: number, set: Value<boolean>): void {
  const flags = loadFlags(b, config);
  const value = b.select(
    types.number,
    set,
    (inner) => inner.bitOr(flags, inner.constant(types.number, mask)),
    (inner) => inner.bitAnd(flags, inner.constant(types.number, ~mask >>> 0)),
  );

  storeFlags(b, config, value);
}

function clearFlag(b: Body, config: I2cConfig, mask: number): void {
  storeFlags(b, config, b.bitAnd(loadFlags(b, config), num(b, ~mask >>> 0)));
}

/** 32 位小端按访问宽度合并；`offset` 是运行期字节偏移。 */

/** 把一次写放到 32 位字里的对应字节位置。 */

const activeTransfer = (b: Body, config: I2cConfig): Value<boolean> =>
  b.notEqual(types.number, loadInternal(b, config, I2C_F_PHASE), num(b, 0));

/**
 * TIMINGR 的 PRESC 时钟周期（皮秒）。`f_I2CCLK` 取 `peripheralClockHz`，
 * 跟随 RCC/APB 分频；TIMINGR 或时钟 epoch 变化时重算低/高/PRESC。
 */
/** 从 TIMINGR + RCC 时钟缓存重算低/高/PRESC 时间；只在 TIMINGR 或时钟代变化时调用。 */
function updateI2cTiming(b: Body, config: I2cConfig): void {
  const timing = loadReg(b, config, I2C_TIMINGR);
  const presc = b.add(b.bitAnd(b.shiftRightUnsigned(timing, num(b, 28)), num(b, 0xf)), num(b, 1));
  const hz = peripheralClockHz(b, config.clockName);
  const prescPs = b.select(
    types.number,
    b.greaterThan(hz, num(b, 0)),
    (inner) =>
      inner.max(
        inner.floor(
          inner.divide(inner.multiply(inner.constant(types.number, 1_000_000_000_000), presc), hz),
        ),
        inner.constant(types.number, 1),
      ),
    (inner) => inner.constant(types.number, 1),
  );
  const scll = b.bitAnd(timing, num(b, 0xff));
  const sclh = b.bitAnd(b.shiftRightUnsigned(timing, num(b, 8)), num(b, 0xff));

  storeInternal(b, config, I2C_F_CLOCK_EPOCH, readClockEpoch(b));
  storeInternal(b, config, I2C_F_PRESC_PS, prescPs);
  storeInternal(b, config, I2C_F_LOW_PS, b.multiply(b.add(scll, num(b, 1)), prescPs));
  storeInternal(b, config, I2C_F_HIGH_PS, b.multiply(b.add(sclh, num(b, 1)), prescPs));
}

const prescPeriod = (b: Body, config: I2cConfig): Value<number> =>
  loadInternal(b, config, I2C_F_PRESC_PS);

function lowPeriod(b: Body, config: I2cConfig): Value<number> {
  return loadInternal(b, config, I2C_F_LOW_PS);
}

function highPeriod(b: Body, config: I2cConfig): Value<number> {
  return loadInternal(b, config, I2C_F_HIGH_PS);
}

const shortDelay = (b: Body, config: I2cConfig): Value<number> => lowPeriod(b, config);

/** 使这一路的最短相位时长，用于中央刷新服务节拍。 */
function tickPeriod(b: Body, config: I2cConfig): Value<number> {
  return b.max(cpuCyclePs(b), b.min(lowPeriod(b, config), highPeriod(b, config)));
}

/**
 * 把精确皮秒拆成「核心周期 + 余数」两个 32 位字。整数周期覆盖低频长相位，
 * 余数保留每批不足一个周期的 elapsedPs，避免 floor 丢失并保证分批/一次推进等价。
 */
function splitTime(
  b: Body,
  config: I2cConfig,
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
  config: I2cConfig,
  cyclesField: number,
  fractionField: number,
): Value<number> {
  return b.add(
    b.multiply(loadInternal(b, config, cyclesField), num(b, machine().cyclePs)),
    loadInternal(b, config, fractionField),
  );
}

/**
 * 找到这一路某个角色当前真正配置为 AF4 的引脚，并采样其电平。
 *
 * 固件只应配置一根；这里按引脚表顺序扫描，最后一个匹配项胜出（正常配置下只有
 * 一个匹配）。匹配条件使用 GPIO 影子 state，不依赖 periph 里的字节寄存器。
 */
type LogicLevel = EnumValue<'Logic', 'low' | 'high' | 'unknown'>;

function pinLevel(b: Body, config: I2cConfig, role: 'scl' | 'sda'): Value<LogicLevel> {
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

function pinHigh(b: Body, config: I2cConfig, role: 'scl' | 'sda'): Value<boolean> {
  return b.equal(
    types.logic,
    pinLevel(b, config, role),
    b.constant(types.logic, types.logic.members.high),
  );
}

function nbytes(b: Body, config: I2cConfig): Value<number> {
  return b.bitAnd(b.shiftRightUnsigned(loadReg(b, config, I2C_CR2), num(b, 16)), num(b, 0xff));
}

function reload(b: Body, config: I2cConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, I2C_CR2), CR2_RELOAD);
}

function autoend(b: Body, config: I2cConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, I2C_CR2), CR2_AUTOEND);
}

function readDirection(b: Body, config: I2cConfig): Value<boolean> {
  return boolBit(b, loadReg(b, config, I2C_CR2), CR2_RD_WRN);
}

function ackWanted(b: Body, config: I2cConfig): Value<boolean> {
  return boolOr(b, b.greaterThan(nbytes(b, config), num(b, 1)), reload(b, config));
}

/**
 * SDA 在当前相位是否应被主机拉低。ACK 位对发送方向释放，对接收方向由
 * `ackWanted` 决定；其余数据位发送时输出，接收时释放。
 */
function sdaDriveLow(b: Body, config: I2cConfig): Value<boolean> {
  const phase = loadInternal(b, config, I2C_F_PHASE);
  const bit = loadInternal(b, config, I2C_F_BIT);
  const shift = loadInternal(b, config, I2C_F_SHIFT);
  const stageData = b.notEqual(types.number, loadInternal(b, config, I2C_F_SCRATCH), num(b, 0));
  const receive = boolAnd(b, readDirection(b, config), stageData);
  const bitLow = b.equal(types.number, bit, num(b, 8));
  const dataBit = b.notEqual(
    types.number,
    b.bitAnd(b.shiftRightUnsigned(shift, b.subtract(num(b, 7), bit)), num(b, 1)),
    num(b, 0),
  );
  const transmitLow = b.select(
    types.number,
    bitLow,
    (inner) => inner.constant(types.number, 0),
    (inner) =>
      inner.select(
        types.number,
        dataBit,
        (inner2) => inner2.constant(types.number, 0),
        (inner2) => inner2.constant(types.number, 1),
      ),
  );
  const wantAck = ackWanted(b, config);
  const receiveLow = b.select(
    types.number,
    bitLow,
    (inner) =>
      inner.select(
        types.number,
        wantAck,
        (inner2) => inner2.constant(types.number, 1),
        (inner2) => inner2.constant(types.number, 0),
      ),
    (inner) => inner.constant(types.number, 0),
  );
  const dataLow = b.select(
    types.number,
    receive,
    () => receiveLow,
    () => transmitLow,
  );
  const inBits = boolOr(
    b,
    b.equal(types.number, phase, num(b, PHASE_BIT_LOW)),
    b.equal(types.number, phase, num(b, PHASE_BIT_HIGH)),
  );
  const alwaysLow = boolOr(
    b,
    boolOr(
      b,
      b.equal(types.number, phase, num(b, PHASE_START_SETUP)),
      b.equal(types.number, phase, num(b, PHASE_START_LOW)),
    ),
    boolOr(
      b,
      b.equal(types.number, phase, num(b, PHASE_STOP_LOW)),
      boolOr(
        b,
        b.equal(types.number, phase, num(b, PHASE_STOP_HIGH)),
        b.equal(types.number, phase, num(b, PHASE_REP_START)),
      ),
    ),
  );

  return b.notEqual(
    types.number,
    b.select(
      types.number,
      alwaysLow,
      (inner) => inner.constant(types.number, 1),
      (inner) =>
        inner.select(
          types.number,
          inBits,
          () => dataLow,
          (inner2) => inner2.constant(types.number, 0),
        ),
    ),
    num(b, 0),
  );
}

function sclDriveLow(b: Body, config: I2cConfig): Value<boolean> {
  const phase = loadInternal(b, config, I2C_F_PHASE);

  return boolOr(
    b,
    b.equal(types.number, phase, num(b, PHASE_START_LOW)),
    boolOr(
      b,
      boolOr(
        b,
        b.equal(types.number, phase, num(b, PHASE_BIT_LOW)),
        b.equal(types.number, phase, num(b, PHASE_WAIT_TX)),
      ),
      boolOr(
        b,
        boolOr(
          b,
          b.equal(types.number, phase, num(b, PHASE_WAIT_STOP)),
          b.equal(types.number, phase, num(b, PHASE_STOP_LOW_SETUP)),
        ),
        boolOr(
          b,
          boolOr(
            b,
            b.equal(types.number, phase, num(b, PHASE_STOP_LOW)),
            b.equal(types.number, phase, num(b, PHASE_REP_LOW)),
          ),
          boolOr(
            b,
            b.equal(types.number, phase, num(b, PHASE_REP_RELEASE)),
            b.equal(types.number, phase, num(b, PHASE_WAIT_TCR)),
          ),
        ),
      ),
    ),
  );
}

function lineLow(b: Body, config: I2cConfig, role: 'scl' | 'sda'): Value<boolean> {
  const pe = boolBit(b, loadReg(b, config, I2C_CR1), CR1_PE);
  const line = role === 'scl' ? sclDriveLow(b, config) : sdaDriveLow(b, config);

  return boolAnd(b, pe, line);
}

/** 刷新这一路所有已配置为 AF4 的引脚意图。 */
export function i2cSyncPins(b: Body, config: I2cConfig): void {
  for (const pin of config.pins) {
    b.if(pinConfigured(b, pin.port, pin.pin, pin.af), (hit) => {
      syncPin(asBody(hit), pin.port, pin.pin);
    });
  }
}

/** 寄存器写、能改变总线驱动的状态变化：让服务块在下一拍刷新引脚。 */
function requestPinSync(b: Body, config: I2cConfig): void {
  let mask = 0;

  for (const pin of config.pins) mask |= 1 << pin.port;
  b.writeState(GPIO_SYNC, b.bitOr(b.readState(GPIO_SYNC, types.number), num(b, mask)));
  markService(b, SERVICE_PIN_SYNC);
}

function irqDirty(b: Body): void {
  b.writeState('irqDirty', bool(b, true));
  markService(b, SERVICE_IRQ);
}

function addressByte(b: Body, config: I2cConfig): Value<number> {
  const cr2 = loadReg(b, config, I2C_CR2);
  // I2C v2 的 SADD[7:1] 保存已经左移的 7 位地址（HAL 传入 0x50<<1），
  // SADD[0] 在 7 位模式下不用；R/W# 由独立的 RD_WRN 位决定。
  const address = b.bitAnd(cr2, num(b, 0xfe));

  return b.bitOr(
    address,
    b.select(
      types.number,
      boolBit(b, cr2, CR2_RD_WRN),
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
}

/** ISR 的合成值。 */
function isrValue(b: Body, config: I2cConfig): Value<number> {
  const cr1 = loadReg(b, config, I2C_CR1);
  const cr2 = loadReg(b, config, I2C_CR2);
  const flags = loadFlags(b, config);
  const phase = loadInternal(b, config, I2C_F_PHASE);
  const pe = boolBit(b, cr1, CR1_PE);
  const busy = boolAnd(b, pe, b.notEqual(types.number, phase, num(b, PHASE_IDLE)));
  const receive = boolBit(b, cr2, CR2_RD_WRN);
  const txLoaded = boolBit(b, flags, I2C_FLAG_TX_LOADED);
  const rxFull = boolBit(b, flags, I2C_FLAG_RX_FULL);
  const txe = boolAnd(b, pe, b.not(txLoaded));
  const stageData = b.notEqual(types.number, loadInternal(b, config, I2C_F_SCRATCH), num(b, 0));
  const txis = boolAnd(
    b,
    txe,
    boolAnd(
      b,
      b.not(receive),
      boolAnd(
        b,
        stageData,
        boolAnd(
          b,
          b.greaterThan(nbytes(b, config), num(b, 0)),
          boolAnd(b, busNotNack(b, config), busy),
        ),
      ),
    ),
  );
  const addcode = b.shiftLeft(
    b.bitAnd(b.shiftRightUnsigned(cr2, num(b, 1)), num(b, 0x7f)),
    num(b, 17),
  );
  const set = (condition: Value<boolean>, mask: number): Value<number> =>
    b.select(
      types.number,
      condition,
      (inner) => inner.constant(types.number, mask),
      (inner) => inner.constant(types.number, 0),
    );
  const lower = b.bitOr(
    b.bitOr(
      b.bitOr(set(txe, ISR_TXE), set(txis, ISR_TXIS)),
      b.bitOr(set(rxFull, ISR_RXNE), set(boolBit(b, flags, I2C_FLAG_ADDR), ISR_ADDR)),
    ),
    b.bitOr(
      b.bitOr(
        set(boolBit(b, flags, I2C_FLAG_NACK), ISR_NACKF),
        set(boolBit(b, flags, I2C_FLAG_STOP), ISR_STOPF),
      ),
      b.bitOr(
        b.bitOr(
          set(boolBit(b, flags, I2C_FLAG_TC), ISR_TC),
          set(boolBit(b, flags, I2C_FLAG_TCR), ISR_TCR),
        ),
        b.bitOr(
          set(boolBit(b, flags, I2C_FLAG_OVR), ISR_OVR),
          set(boolBit(b, flags, I2C_FLAG_TIMEOUT), ISR_TIMEOUT),
        ),
      ),
    ),
  );

  return b.bitOr(
    b.bitOr(lower, addcode),
    b.bitOr(set(busy, ISR_BUSY), set(boolAnd(b, busy, receive), ISR_DIR)),
  );
}

function busNotNack(b: Body, config: I2cConfig): Value<boolean> {
  return b.not(boolBit(b, loadFlags(b, config), I2C_FLAG_NACK));
}

function storePhase(
  b: Body,
  config: I2cConfig,
  phase: number,
  durationPs: Value<number> | undefined,
  carryPs: Value<number>,
): void {
  storeInternal(b, config, I2C_F_PHASE, num(b, phase));
  if (durationPs === undefined) {
    storeInternal(b, config, I2C_F_REMAINING, num(b, 0));
    storeInternal(b, config, I2C_F_FRACTION, num(b, 0));
  } else {
    splitTime(
      b,
      config,
      I2C_F_REMAINING,
      I2C_F_FRACTION,
      b.max(num(b, 0), b.subtract(durationPs, carryPs)),
    );
  }
}

function setStage(b: Body, config: I2cConfig, data: boolean): void {
  storeInternal(b, config, I2C_F_SCRATCH, num(b, data ? 1 : 0));
}

function resetTransferState(b: Body, config: I2cConfig): void {
  storeInternal(b, config, I2C_F_PHASE, num(b, PHASE_IDLE));
  storeInternal(b, config, I2C_F_REMAINING, num(b, 0));
  storeInternal(b, config, I2C_F_FRACTION, num(b, 0));
  storeInternal(b, config, I2C_F_BIT, num(b, 0));
  storeInternal(b, config, I2C_F_SHIFT, num(b, 0));
  storeInternal(b, config, I2C_F_TX, num(b, 0));
  storeInternal(b, config, I2C_F_RX, num(b, 0));
  storeInternal(b, config, I2C_F_FLAGS, num(b, 0));
  storeInternal(b, config, I2C_F_STRETCH, num(b, 0));
  storeInternal(b, config, I2C_F_STRETCH_FRACTION, num(b, 0));
  storeInternal(b, config, I2C_F_TIMEOUT, num(b, 0));
  storeInternal(b, config, I2C_F_SCRATCH, num(b, 0));
}

function beginStart(b: Body, config: I2cConfig): void {
  updateI2cTiming(b, config);
  clearFlag(b, config, I2C_FLAG_ADDR);
  clearFlag(b, config, I2C_FLAG_NACK);
  clearFlag(b, config, I2C_FLAG_STOP);
  clearFlag(b, config, I2C_FLAG_TC);
  clearFlag(b, config, I2C_FLAG_TCR);
  clearFlag(b, config, I2C_FLAG_OVR);
  clearFlag(b, config, FLAG_BYTE_DONE);
  setFlag(b, config, I2C_FLAG_TX_LOADED, bool(b, false));
  setFlag(b, config, I2C_FLAG_RX_FULL, bool(b, false));
  storeInternal(b, config, I2C_F_BIT, num(b, 0));
  storeInternal(b, config, I2C_F_SHIFT, addressByte(b, config));
  storeInternal(b, config, I2C_F_STRETCH, num(b, 0));
  storeInternal(b, config, I2C_F_STRETCH_FRACTION, num(b, 0));
  storeInternal(b, config, I2C_F_TIMEOUT, num(b, 0));
  setStage(b, config, false);
  storePhase(b, config, PHASE_START_SETUP, shortDelay(b, config), num(b, 0));
  requestPinSync(b, config);
  irqDirty(b);
}

function startRequested(b: Body, config: I2cConfig): void {
  const phase = loadInternal(b, config, I2C_F_PHASE);

  b.if(
    b.equal(types.number, phase, num(b, PHASE_IDLE)),
    (idle) => beginStart(asBody(idle), config),
    (busy) => {
      const scope = asBody(busy);

      scope.if(
        boolOr(
          scope,
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_STOP)),
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_TCR)),
        ),
        (ready) => {
          const body = asBody(ready);

          clearFlag(body, config, I2C_FLAG_ADDR);
          clearFlag(body, config, I2C_FLAG_TC);
          clearFlag(body, config, I2C_FLAG_TCR);
          clearFlag(body, config, I2C_FLAG_NACK);
          clearFlag(body, config, FLAG_BYTE_DONE);
          setFlag(body, config, I2C_FLAG_TX_LOADED, bool(body, false));
          setFlag(body, config, I2C_FLAG_RX_FULL, bool(body, false));
          setStage(body, config, false);
          setFlag(body, config, I2C_FLAG_START_PENDING, bool(body, false));
          storePhase(body, config, PHASE_REP_LOW, lowPeriod(body, config), num(body, 0));
          requestPinSync(body, config);
          irqDirty(body);
        },
        (during) => {
          setFlag(asBody(during), config, I2C_FLAG_START_PENDING, bool(asBody(during), true));
        },
      );
    },
  );
}

function stopRequested(b: Body, config: I2cConfig): void {
  const phase = loadInternal(b, config, I2C_F_PHASE);

  b.if(
    b.equal(types.number, phase, num(b, PHASE_IDLE)),
    () => {},
    (busy) => {
      const scope = asBody(busy);

      scope.if(
        boolOr(
          scope,
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_STOP)),
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_TCR)),
        ),
        (ready) => {
          const body = asBody(ready);

          clearFlag(body, config, I2C_FLAG_START_PENDING);
          setFlag(body, config, I2C_FLAG_STOP_PENDING, bool(body, false));
          storePhase(body, config, PHASE_STOP_LOW_SETUP, shortDelay(body, config), num(body, 0));
          requestPinSync(body, config);
          irqDirty(body);
        },
        (during) => {
          setFlag(asBody(during), config, I2C_FLAG_STOP_PENDING, bool(asBody(during), true));
        },
      );
    },
  );
}

/** 从 BIT_FALL 进入下一数据位。 */
function nextDataBit(b: Body, config: I2cConfig, carry: Value<number>): void {
  const byteDone = boolBit(b, loadFlags(b, config), FLAG_BYTE_DONE);

  b.if(
    byteDone,
    (newByte) => {
      const body = asBody(newByte);

      clearFlag(body, config, FLAG_BYTE_DONE);
      storeInternal(body, config, I2C_F_BIT, num(body, 0));
      body.if(
        readDirection(body, config),
        (receive) => {
          storeInternal(asBody(receive), config, I2C_F_SHIFT, num(asBody(receive), 0));
          storePhase(
            asBody(receive),
            config,
            PHASE_BIT_LOW,
            lowPeriod(asBody(receive), config),
            carry,
          );
        },
        (transmit) => {
          const txBody = asBody(transmit);
          const loaded = boolBit(txBody, loadFlags(txBody, config), I2C_FLAG_TX_LOADED);

          txBody.if(
            loaded,
            (ready) => {
              const readyBody = asBody(ready);

              storeInternal(
                readyBody,
                config,
                I2C_F_SHIFT,
                loadInternal(readyBody, config, I2C_F_TX),
              );
              clearFlag(readyBody, config, I2C_FLAG_TX_LOADED);
              storePhase(readyBody, config, PHASE_BIT_LOW, lowPeriod(readyBody, config), carry);
              irqDirty(readyBody);
            },
            (empty) => {
              storePhase(asBody(empty), config, PHASE_WAIT_TX, undefined, num(asBody(empty), 0));
              requestPinSync(asBody(empty), config);
            },
          );
        },
      );
    },
    (sameByte) => {
      const body = asBody(sameByte);

      storeInternal(
        body,
        config,
        I2C_F_BIT,
        body.add(loadInternal(body, config, I2C_F_BIT), num(body, 1)),
      );
      storePhase(body, config, PHASE_BIT_LOW, lowPeriod(body, config), carry);
    },
  );
}

/** 采样接收位并写入移位寄存器。 */
function receiveBit(b: Body, config: I2cConfig): void {
  const shift = loadInternal(b, config, I2C_F_SHIFT);
  const high = pinHigh(b, config, 'sda');
  const next = b.bitOr(
    b.shiftLeft(shift, num(b, 1)),
    b.select(
      types.number,
      high,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );

  storeInternal(b, config, I2C_F_SHIFT, b.bitAnd(next, num(b, 0xff)));
}

function completeReceiveByte(b: Body, config: I2cConfig): void {
  const value = loadInternal(b, config, I2C_F_SHIFT);
  const alreadyFull = boolBit(b, loadFlags(b, config), I2C_FLAG_RX_FULL);

  setFlag(b, config, I2C_FLAG_OVR, alreadyFull);
  storeInternal(b, config, I2C_F_RX, value);
  setFlag(b, config, I2C_FLAG_RX_FULL, bool(b, true));
  irqDirty(b);
}

function completeTransfer(b: Body, config: I2cConfig): void {
  const startPending = boolBit(b, loadFlags(b, config), I2C_FLAG_START_PENDING);

  b.if(
    startPending,
    (repeat) => {
      const body = asBody(repeat);

      clearFlag(body, config, I2C_FLAG_START_PENDING);
      clearFlag(body, config, I2C_FLAG_ADDR);
      clearFlag(body, config, I2C_FLAG_TC);
      clearFlag(body, config, I2C_FLAG_TCR);
      clearFlag(body, config, I2C_FLAG_NACK);
      clearFlag(body, config, FLAG_BYTE_DONE);
      storePhase(body, config, PHASE_REP_LOW, lowPeriod(body, config), num(body, 0));
      requestPinSync(body, config);
      irqDirty(body);
    },
    (normal) => {
      const body = asBody(normal);

      body.if(
        boolBit(body, loadFlags(body, config), I2C_FLAG_STOP_PENDING),
        (stop) => {
          const stopBody = asBody(stop);

          clearFlag(stopBody, config, I2C_FLAG_STOP_PENDING);
          storePhase(
            stopBody,
            config,
            PHASE_STOP_LOW_SETUP,
            shortDelay(stopBody, config),
            num(stopBody, 0),
          );
          requestPinSync(stopBody, config);
        },
        (continueTransfer) => {
          const scope = asBody(continueTransfer);

          scope.if(
            reload(scope, config),
            (more) => {
              const reloadBody = asBody(more);

              setFlag(reloadBody, config, I2C_FLAG_TCR, bool(reloadBody, true));
              storePhase(reloadBody, config, PHASE_WAIT_TCR, undefined, num(reloadBody, 0));
              requestPinSync(reloadBody, config);
              irqDirty(reloadBody);
            },
            (end) => {
              const endBody = asBody(end);

              setFlag(endBody, config, I2C_FLAG_TC, bool(endBody, true));
              irqDirty(endBody);
              endBody.if(
                autoend(endBody, config),
                (auto) => {
                  storePhase(
                    asBody(auto),
                    config,
                    PHASE_STOP_LOW_SETUP,
                    shortDelay(asBody(auto), config),
                    num(asBody(auto), 0),
                  );
                  requestPinSync(asBody(auto), config);
                },
                (wait) => {
                  storePhase(
                    asBody(wait),
                    config,
                    PHASE_WAIT_STOP,
                    undefined,
                    num(asBody(wait), 0),
                  );
                  requestPinSync(asBody(wait), config);
                },
              );
            },
          );
        },
      );
    },
  );
}

function setNbytes(b: Body, config: I2cConfig, value: Value<number>): void {
  storeReg(
    b,
    config,
    I2C_CR2,
    u32(
      b,
      b.bitOr(
        b.bitAnd(loadReg(b, config, I2C_CR2), b.bitNot(b.shiftLeft(num(b, 0xff), num(b, 16)))),
        b.shiftLeft(b.bitAnd(value, num(b, 0xff)), num(b, 16)),
      ),
    ),
  );
}

/** ACK 位高电平结束：判断 ACK/NACK、完成字节或开始下一字节。 */
function finishAckBit(b: Body, config: I2cConfig, carry: Value<number>): void {
  const stage = loadInternal(b, config, I2C_F_SCRATCH);
  const addressStage = b.equal(types.number, stage, num(b, 0));

  b.if(
    addressStage,
    (address) => {
      const body = asBody(address);
      const nack = pinHigh(body, config, 'sda');

      body.if(
        nack,
        (failed) => {
          const scope = asBody(failed);

          setFlag(scope, config, I2C_FLAG_NACK, bool(scope, true));
          clearFlag(scope, config, I2C_FLAG_ADDR);
          irqDirty(scope);
          scope.if(
            autoend(scope, config),
            (auto) => {
              storePhase(
                asBody(auto),
                config,
                PHASE_STOP_LOW_SETUP,
                shortDelay(asBody(auto), config),
                carry,
              );
              requestPinSync(asBody(auto), config);
            },
            (wait) => {
              storePhase(asBody(wait), config, PHASE_WAIT_STOP, undefined, num(asBody(wait), 0));
              requestPinSync(asBody(wait), config);
            },
          );
        },
        (acked) => {
          const scope = asBody(acked);
          const current = nbytes(scope, config);

          setFlag(scope, config, I2C_FLAG_ADDR, bool(scope, true));
          setStage(scope, config, true);
          irqDirty(scope);
          scope.if(
            scope.equal(types.number, current, num(scope, 0)),
            (end) => completeTransfer(asBody(end), config),
            (more) => {
              const moreBody = asBody(more);

              storeInternal(moreBody, config, I2C_F_BIT, num(moreBody, 8));
              setFlag(moreBody, config, FLAG_BYTE_DONE, bool(moreBody, true));
              nextDataBit(moreBody, config, carry);
              requestPinSync(moreBody, config);
            },
          );
        },
      );
    },
    (data) => {
      const body = asBody(data);
      const receive = readDirection(body, config);

      body.if(
        receive,
        (read) => {
          const scope = asBody(read);
          const current = nbytes(scope, config);
          const next = scope.select(
            types.number,
            scope.greaterThan(current, num(scope, 0)),
            (inner) => inner.subtract(current, inner.constant(types.number, 1)),
            (inner) => inner.constant(types.number, 0),
          );
          const startPending = boolBit(scope, loadFlags(scope, config), I2C_FLAG_START_PENDING);
          const stopPending = boolBit(scope, loadFlags(scope, config), I2C_FLAG_STOP_PENDING);

          setNbytes(scope, config, next);
          scope.if(
            boolOr(
              scope,
              boolOr(scope, startPending, stopPending),
              scope.equal(types.number, next, num(scope, 0)),
            ),
            (end) => completeTransfer(asBody(end), config),
            (more) => {
              const moreBody = asBody(more);

              storeInternal(moreBody, config, I2C_F_BIT, num(moreBody, 8));
              setFlag(moreBody, config, FLAG_BYTE_DONE, bool(moreBody, true));
              nextDataBit(moreBody, config, carry);
              requestPinSync(moreBody, config);
              irqDirty(moreBody);
            },
          );
        },
        (write) => {
          const scope = asBody(write);
          const nack = pinHigh(scope, config, 'sda');
          const current = nbytes(scope, config);
          const next = scope.select(
            types.number,
            scope.greaterThan(current, num(scope, 0)),
            (inner) => inner.subtract(current, inner.constant(types.number, 1)),
            (inner) => inner.constant(types.number, 0),
          );

          scope.if(
            nack,
            (failed) => {
              const bad = asBody(failed);

              setFlag(bad, config, I2C_FLAG_NACK, bool(bad, true));
              clearFlag(bad, config, I2C_FLAG_ADDR);
              irqDirty(bad);
              bad.if(
                autoend(bad, config),
                (auto) => {
                  storePhase(
                    asBody(auto),
                    config,
                    PHASE_STOP_LOW_SETUP,
                    shortDelay(asBody(auto), config),
                    carry,
                  );
                  requestPinSync(asBody(auto), config);
                },
                (wait) => {
                  storePhase(
                    asBody(wait),
                    config,
                    PHASE_WAIT_STOP,
                    undefined,
                    num(asBody(wait), 0),
                  );
                  requestPinSync(asBody(wait), config);
                },
              );
            },
            (acked) => {
              const ackBody = asBody(acked);

              setNbytes(ackBody, config, next);
              ackBody.if(
                ackBody.equal(types.number, next, num(ackBody, 0)),
                (end) => completeTransfer(asBody(end), config),
                (more) => {
                  const moreBody = asBody(more);

                  storeInternal(moreBody, config, I2C_F_BIT, num(moreBody, 8));
                  setFlag(moreBody, config, FLAG_BYTE_DONE, bool(moreBody, true));
                  nextDataBit(moreBody, config, carry);
                  requestPinSync(moreBody, config);
                  irqDirty(moreBody);
                },
              );
            },
          );
        },
      );
    },
  );
}

/** 采样 SCL 高电平结束时的数据/ACK 位。 */
function finishBitHigh(b: Body, config: I2cConfig, carry: Value<number>): void {
  const bit = loadInternal(b, config, I2C_F_BIT);
  const receive = readDirection(b, config);
  const stageData = b.notEqual(types.number, loadInternal(b, config, I2C_F_SCRATCH), num(b, 0));
  const ackBit = b.equal(types.number, bit, num(b, 8));

  b.if(
    ackBit,
    (ack) => finishAckBit(asBody(ack), config, carry),
    (data) => {
      const body = asBody(data);

      body.if(boolAnd(body, receive, stageData), (read) => {
        const readBody = asBody(read);

        receiveBit(readBody, config);
        readBody.if(
          readBody.equal(types.number, loadInternal(readBody, config, I2C_F_BIT), num(readBody, 7)),
          (last) => completeReceiveByte(asBody(last), config),
        );
      });
      nextDataBit(body, config, carry);
    },
  );
}

function escapeTimeout(b: Body, config: I2cConfig): void {
  setFlag(b, config, I2C_FLAG_TIMEOUT, bool(b, true));
  clearFlag(b, config, I2C_FLAG_ADDR);
  clearFlag(b, config, I2C_FLAG_TC);
  clearFlag(b, config, I2C_FLAG_TCR);
  clearFlag(b, config, FLAG_BYTE_DONE);
  storePhase(b, config, PHASE_WAIT_STOP, undefined, num(b, 0));
  requestPinSync(b, config);
  irqDirty(b);
}

/** SCL 高电平期间检查拉伸/超时；返回是否真的已经高电平。 */
function sclReleasedHigh(b: Body, config: I2cConfig): Value<boolean> {
  return pinHigh(b, config, 'scl');
}

function timeoutLimit(b: Body, config: I2cConfig): Value<number> {
  const timeout = loadReg(b, config, I2C_TIMEOUTR);
  const enabled = boolBit(b, timeout, TIMEOUTR_TIMOUTEN);
  const count = b.bitAnd(timeout, num(b, 0xfff));
  const limit = b.multiply(
    b.add(count, num(b, 1)),
    b.multiply(num(b, 2048), prescPeriod(b, config)),
  );

  return b.select(
    types.number,
    enabled,
    () => limit,
    (inner) => inner.constant(types.number, 0),
  );
}

function checkStretch(
  b: Body,
  config: I2cConfig,
  elapsedPs: Value<number>,
  carryPs: Value<number>,
): void {
  const high = sclReleasedHigh(b, config);
  const stretch = b.add(totalTime(b, config, I2C_F_STRETCH, I2C_F_STRETCH_FRACTION), elapsedPs);
  const limit = timeoutLimit(b, config);
  const timedOut = boolAnd(b, b.not(high), b.greaterThan(limit, num(b, 0)));

  b.if(
    high,
    (ok) => {
      const body = asBody(ok);

      storeInternal(body, config, I2C_F_STRETCH, num(body, 0));
      storeInternal(body, config, I2C_F_STRETCH_FRACTION, num(body, 0));
      storeInternal(body, config, I2C_F_TIMEOUT, num(body, 0));
      finishBitHigh(body, config, carryPs);
    },
    (stuck) => {
      const body = asBody(stuck);
      const expired = boolAnd(body, timedOut, body.greaterThanOrEqual(stretch, limit));

      body.if(
        expired,
        (timeout) => escapeTimeout(asBody(timeout), config),
        (wait) => {
          const waitBody = asBody(wait);

          splitTime(waitBody, config, I2C_F_STRETCH, I2C_F_STRETCH_FRACTION, stretch);
          splitTime(
            waitBody,
            config,
            I2C_F_REMAINING,
            I2C_F_FRACTION,
            highPeriod(waitBody, config),
          );
        },
      );
    },
  );
}

/** 单个相位的定时推进；时间字段用“周期+余数”，`carry` 是越过相位边界的皮秒余量。 */
function advanceTimed(b: Body, config: I2cConfig, elapsedPs: Value<number>): void {
  const phase = loadInternal(b, config, I2C_F_PHASE);
  const remaining = b.subtract(totalTime(b, config, I2C_F_REMAINING, I2C_F_FRACTION), elapsedPs);

  b.if(
    b.greaterThan(remaining, num(b, 0)),
    (hold) => splitTime(asBody(hold), config, I2C_F_REMAINING, I2C_F_FRACTION, remaining),
    (fire) => {
      const body = asBody(fire);
      const carry = body.max(num(body, 0), body.subtract(num(body, 0), remaining));

      body.if(
        body.equal(types.number, phase, num(body, PHASE_START_SETUP)),
        (start) => {
          const scope = asBody(start);

          storePhase(scope, config, PHASE_START_LOW, lowPeriod(scope, config), carry);
          requestPinSync(scope, config);
        },
        (next) => {
          const body2 = asBody(next);

          body2.if(
            body2.equal(types.number, phase, num(body2, PHASE_START_LOW)),
            (low) => {
              const scope = asBody(low);

              storeInternal(scope, config, I2C_F_BIT, num(scope, 0));
              storeInternal(scope, config, I2C_F_SHIFT, addressByte(scope, config));
              storePhase(scope, config, PHASE_BIT_LOW, lowPeriod(scope, config), carry);
              requestPinSync(scope, config);
            },
            (next2) => {
              const body3 = asBody(next2);

              body3.if(
                body3.equal(types.number, phase, num(body3, PHASE_BIT_FALL)),
                (fall) => {
                  nextDataBit(asBody(fall), config, carry);
                  requestPinSync(asBody(fall), config);
                },
                (next3) => {
                  const body4 = asBody(next3);

                  body4.if(
                    body4.equal(types.number, phase, num(body4, PHASE_BIT_LOW)),
                    (low) => {
                      const scope = asBody(low);

                      storePhase(scope, config, PHASE_BIT_HIGH, highPeriod(scope, config), carry);
                      requestPinSync(scope, config);
                    },
                    (next4) => {
                      const body5 = asBody(next4);

                      body5.if(
                        body5.equal(types.number, phase, num(body5, PHASE_BIT_HIGH)),
                        (high) => {
                          const scope = asBody(high);

                          checkStretch(scope, config, elapsedPs, carry);
                          requestPinSync(scope, config);
                        },
                        (next5) => {
                          const body6 = asBody(next5);

                          body6.if(
                            body6.equal(types.number, phase, num(body6, PHASE_STOP_LOW_SETUP)),
                            (setup) => {
                              const scope = asBody(setup);

                              storePhase(
                                scope,
                                config,
                                PHASE_STOP_LOW,
                                lowPeriod(scope, config),
                                carry,
                              );
                              requestPinSync(scope, config);
                            },
                            (next6) => {
                              const body7 = asBody(next6);

                              body7.if(
                                body7.equal(types.number, phase, num(body7, PHASE_STOP_LOW)),
                                (low) => {
                                  const scope = asBody(low);

                                  storePhase(
                                    scope,
                                    config,
                                    PHASE_STOP_HIGH,
                                    shortDelay(scope, config),
                                    carry,
                                  );
                                  requestPinSync(scope, config);
                                },
                                (next7) => {
                                  const body8 = asBody(next7);

                                  body8.if(
                                    body8.equal(types.number, phase, num(body8, PHASE_STOP_HIGH)),
                                    (high) => {
                                      const scope = asBody(high);

                                      storePhase(
                                        scope,
                                        config,
                                        PHASE_STOP_RELEASE,
                                        lowPeriod(scope, config),
                                        carry,
                                      );
                                      requestPinSync(scope, config);
                                    },
                                    (next8) => {
                                      const body9 = asBody(next8);

                                      body9.if(
                                        body9.equal(
                                          types.number,
                                          phase,
                                          num(body9, PHASE_STOP_RELEASE),
                                        ),
                                        (release) => {
                                          const scope = asBody(release);

                                          setFlag(scope, config, I2C_FLAG_STOP, bool(scope, true));
                                          clearFlag(scope, config, I2C_FLAG_START_PENDING);
                                          clearFlag(scope, config, I2C_FLAG_STOP_PENDING);
                                          clearFlag(scope, config, FLAG_BYTE_DONE);
                                          storePhase(
                                            scope,
                                            config,
                                            PHASE_IDLE,
                                            undefined,
                                            num(scope, 0),
                                          );
                                          requestPinSync(scope, config);
                                          irqDirty(scope);
                                        },
                                        (next9) => {
                                          const body10 = asBody(next9);

                                          body10.if(
                                            body10.equal(
                                              types.number,
                                              phase,
                                              num(body10, PHASE_REP_LOW),
                                            ),
                                            (low) => {
                                              const scope = asBody(low);

                                              storePhase(
                                                scope,
                                                config,
                                                PHASE_REP_RELEASE,
                                                shortDelay(scope, config),
                                                carry,
                                              );
                                              requestPinSync(scope, config);
                                            },
                                            (next10) => {
                                              const body11 = asBody(next10);

                                              body11.if(
                                                body11.equal(
                                                  types.number,
                                                  phase,
                                                  num(body11, PHASE_REP_RELEASE),
                                                ),
                                                (release) => {
                                                  const scope = asBody(release);

                                                  storePhase(
                                                    scope,
                                                    config,
                                                    PHASE_REP_HIGH,
                                                    shortDelay(scope, config),
                                                    carry,
                                                  );
                                                  requestPinSync(scope, config);
                                                },
                                                (next11) => {
                                                  const body12 = asBody(next11);

                                                  body12.if(
                                                    body12.equal(
                                                      types.number,
                                                      phase,
                                                      num(body12, PHASE_REP_HIGH),
                                                    ),
                                                    (high) => {
                                                      const scope = asBody(high);

                                                      storePhase(
                                                        scope,
                                                        config,
                                                        PHASE_REP_START,
                                                        shortDelay(scope, config),
                                                        carry,
                                                      );
                                                      requestPinSync(scope, config);
                                                    },
                                                    (next12) => {
                                                      const body13 = asBody(next12);

                                                      body13.if(
                                                        body13.equal(
                                                          types.number,
                                                          phase,
                                                          num(body13, PHASE_REP_START),
                                                        ),
                                                        (start) => {
                                                          const scope = asBody(start);

                                                          storePhase(
                                                            scope,
                                                            config,
                                                            PHASE_START_LOW,
                                                            lowPeriod(scope, config),
                                                            carry,
                                                          );
                                                          storeInternal(
                                                            scope,
                                                            config,
                                                            I2C_F_BIT,
                                                            num(scope, 0),
                                                          );
                                                          storeInternal(
                                                            scope,
                                                            config,
                                                            I2C_F_SHIFT,
                                                            addressByte(scope, config),
                                                          );
                                                          setStage(scope, config, false);
                                                          requestPinSync(scope, config);
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

/** 等待 TXDR、STOP 或 RELOAD 的相位；没有定时事件。 */
function advanceWait(b: Body, config: I2cConfig): void {
  const phase = loadInternal(b, config, I2C_F_PHASE);
  const flags = loadFlags(b, config);
  const txLoaded = boolBit(b, flags, I2C_FLAG_TX_LOADED);
  const startPending = boolBit(b, flags, I2C_FLAG_START_PENDING);
  const stopPending = boolBit(b, flags, I2C_FLAG_STOP_PENDING);

  b.if(
    b.equal(types.number, phase, num(b, PHASE_WAIT_TX)),
    (wait) => {
      const body = asBody(wait);

      body.if(
        stopPending,
        (stop) => {
          const scope = asBody(stop);

          clearFlag(scope, config, I2C_FLAG_STOP_PENDING);
          storePhase(scope, config, PHASE_STOP_LOW_SETUP, shortDelay(scope, config), num(scope, 0));
          requestPinSync(scope, config);
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            startPending,
            (start) => {
              const startBody = asBody(start);

              clearFlag(startBody, config, I2C_FLAG_START_PENDING);
              storePhase(
                startBody,
                config,
                PHASE_REP_LOW,
                lowPeriod(startBody, config),
                num(startBody, 0),
              );
              requestPinSync(startBody, config);
            },
            (send) => {
              const sendBody = asBody(send);

              sendBody.if(
                boolAnd(
                  sendBody,
                  txLoaded,
                  sendBody.greaterThan(nbytes(sendBody, config), num(sendBody, 0)),
                ),
                (ready) => {
                  const readyBody = asBody(ready);

                  storeInternal(
                    readyBody,
                    config,
                    I2C_F_SHIFT,
                    loadInternal(readyBody, config, I2C_F_TX),
                  );
                  clearFlag(readyBody, config, I2C_FLAG_TX_LOADED);
                  storeInternal(readyBody, config, I2C_F_BIT, num(readyBody, 0));
                  storePhase(
                    readyBody,
                    config,
                    PHASE_BIT_LOW,
                    lowPeriod(readyBody, config),
                    num(readyBody, 0),
                  );
                  requestPinSync(readyBody, config);
                  irqDirty(readyBody);
                },
                (empty) => {
                  storePhase(
                    asBody(empty),
                    config,
                    PHASE_WAIT_TX,
                    undefined,
                    num(asBody(empty), 0),
                  );
                },
              );
            },
          );
        },
      );
    },
    (other) => {
      const body = asBody(other);

      body.if(
        boolOr(
          body,
          body.equal(types.number, phase, num(body, PHASE_WAIT_STOP)),
          body.equal(types.number, phase, num(body, PHASE_WAIT_TCR)),
        ),
        (wait) => {
          const scope = asBody(wait);

          scope.if(
            startPending,
            (start) => {
              const startBody = asBody(start);

              clearFlag(startBody, config, I2C_FLAG_START_PENDING);
              storePhase(
                startBody,
                config,
                PHASE_REP_LOW,
                lowPeriod(startBody, config),
                num(startBody, 0),
              );
              requestPinSync(startBody, config);
            },
            (next) => {
              const scope2 = asBody(next);

              scope2.if(
                stopPending,
                (stop) => {
                  const stopBody = asBody(stop);

                  clearFlag(stopBody, config, I2C_FLAG_STOP_PENDING);
                  storePhase(
                    stopBody,
                    config,
                    PHASE_STOP_LOW_SETUP,
                    shortDelay(stopBody, config),
                    num(stopBody, 0),
                  );
                  requestPinSync(stopBody, config);
                },
                (next2) => {
                  const scope3 = asBody(next2);

                  scope3.if(
                    scope3.greaterThan(nbytes(scope3, config), num(scope3, 0)),
                    (reloadMore) => {
                      const reloadBody = asBody(reloadMore);

                      clearFlag(reloadBody, config, I2C_FLAG_TCR);
                      setFlag(reloadBody, config, FLAG_BYTE_DONE, bool(reloadBody, true));
                      nextDataBit(reloadBody, config, num(reloadBody, 0));
                      requestPinSync(reloadBody, config);
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

/** 每个服务节拍最多推进一路的一个相位。 */
export function advanceI2c(b: Body, elapsedPs: Value<number>): void {
  const wasActive = i2cActive(b);

  for (const config of I2C_CONFIGS) {
    b.if(activeTransfer(b, config), (active) => {
      const scope = asBody(active);
      scope.if(
        scope.notEqual(
          types.number,
          loadInternal(scope, config, I2C_F_CLOCK_EPOCH),
          readClockEpoch(scope),
        ),
        (changed) => updateI2cTiming(asBody(changed), config),
      );
      const phase = loadInternal(scope, config, I2C_F_PHASE);
      const wait = boolOr(
        scope,
        scope.equal(types.number, phase, num(scope, PHASE_WAIT_TX)),
        boolOr(
          scope,
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_STOP)),
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_TCR)),
        ),
      );

      scope.if(
        wait,
        (waiting) => {
          advanceWait(asBody(waiting), config);
        },
        (timed) => {
          const body = asBody(timed);

          body.if(body.notEqual(types.number, phase, num(body, PHASE_IDLE)), (running) =>
            advanceTimed(asBody(running), config, elapsedPs),
          );
        },
      );
    });
  }
  b.if(boolAnd(b, wasActive, b.not(i2cActive(b))), (done) => {
    const body = asBody(done);

    setPeripheralActive(body, I2C_SLOT, false);
    setPeripheralDeadline(body, I2C_SLOT, num(body, 0));
    refreshTick(body);
  });
}

/** 任一路是否在传输（含等待软件写 TXDR/STOP 的状态）。 */
export function i2cActive(b: Body): Value<boolean> {
  let active = bool(b, false);

  for (const config of I2C_CONFIGS) active = boolOr(b, active, activeTransfer(b, config));

  return active;
}

/** 活跃 I2C 的最短相位；0 表示没有活跃 I2C。 */
export function i2cRequestedTickPs(b: Body): Value<number> {
  const result = b.local(types.number, 0);
  const seen = b.local(types.bool, false);

  for (const config of I2C_CONFIGS) {
    b.if(activeTransfer(b, config), (active) => {
      const scope = asBody(active);
      const period = tickPeriod(scope, config);

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

/** 最近一次相位剩余；等待软件或空闲时为 0。 */
export function i2cNextDeadlinePs(b: Body): Value<number> {
  const result = b.local(types.number, 0);
  const seen = b.local(types.bool, false);

  for (const config of I2C_CONFIGS) {
    b.if(activeTransfer(b, config), (active) => {
      const scope = asBody(active);
      const phase = loadInternal(scope, config, I2C_F_PHASE);
      const wait = boolOr(
        scope,
        scope.equal(types.number, phase, num(scope, PHASE_WAIT_TX)),
        boolOr(
          scope,
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_STOP)),
          scope.equal(types.number, phase, num(scope, PHASE_WAIT_TCR)),
        ),
      );

      scope.if(
        wait,
        (waiting) => {
          const body = asBody(waiting);

          body.setLocal(seen, bool(body, true));
          body.setLocal(result, num(body, 0));
        },
        (timed) => {
          const body = asBody(timed);
          const remaining = totalTime(body, config, I2C_F_REMAINING, I2C_F_FRACTION);

          body.if(
            body.getLocal(seen),
            (has) => {
              const scope2 = asBody(has);

              scope2.setLocal(result, scope2.min(scope2.getLocal(result), remaining));
            },
            (first) => {
              const scope2 = asBody(first);

              scope2.setLocal(seen, bool(scope2, true));
              scope2.setLocal(result, remaining);
            },
          );
        },
      );
    });
  }

  return b.getLocal(result);
}

export function readI2c(
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  size: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const valid = b.lessThan(offset, num(b, I2C_REGISTER_SIZE));
  const rxLane = b.equal(types.number, b.bitAnd(offset, num(b, 3)), num(b, 0));
  const result = b.local(types.number, 0);

  b.if(
    boolAnd(b, valid, b.equal(types.number, wordOffset, num(b, I2C_ISR))),
    (isr) => isr.setLocal(result, isrValue(asBody(isr), config)),
    (other) => {
      const body = asBody(other);

      body.if(
        boolAnd(
          body,
          valid,
          boolAnd(body, rxLane, body.equal(types.number, wordOffset, num(body, I2C_RXDR))),
        ),
        (rx) => {
          const scope = asBody(rx);

          scope.setLocal(result, loadInternal(scope, config, I2C_F_RX));
          clearFlag(scope, config, I2C_FLAG_RX_FULL);
          irqDirty(scope);
        },
        (stored) => {
          const scope = asBody(stored);

          scope.if(
            boolAnd(
              scope,
              valid,
              scope.not(
                boolOr(
                  scope,
                  scope.equal(types.number, wordOffset, num(scope, I2C_TXDR)),
                  scope.equal(types.number, wordOffset, num(scope, I2C_ICR)),
                ),
              ),
            ),
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
  config: I2cConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const current = loadReg(b, config, I2C_CR1);
  const merged = merge(b, current, value, offset, size);
  const peBefore = boolBit(b, current, CR1_PE);
  const peAfter = boolBit(b, merged, CR1_PE);

  storeReg(b, config, I2C_CR1, merged);
  b.if(boolAnd(b, peBefore, b.not(peAfter)), (off) => {
    const body = asBody(off);

    resetTransferState(body, config);
    requestPinSync(body, config);
  });
  b.if(boolAnd(b, b.not(peBefore), peAfter), (on) => {
    const body = asBody(on);

    clearFlag(body, config, I2C_FLAG_OVR);
    clearFlag(body, config, I2C_FLAG_TIMEOUT);
    updateI2cTiming(body, config);
  });
  requestPinSync(b, config);
  irqDirty(b);
}

function writeCr2(
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const current = loadReg(b, config, I2C_CR2);
  const merged = merge(b, current, value, offset, size);
  const start = boolBit(b, merged, CR2_START);
  const stop = boolBit(b, merged, CR2_STOP);
  const stored = b.bitAnd(merged, num(b, ~(CR2_START | CR2_STOP) >>> 0));
  const tcr = boolBit(b, loadFlags(b, config), I2C_FLAG_TCR);
  const reloadedBytes = b.greaterThan(nbytes(b, config), num(b, 0));

  storeReg(b, config, I2C_CR2, stored);
  b.if(start, (started) => startRequested(asBody(started), config));
  b.if(stop, (stopped) => stopRequested(asBody(stopped), config));
  b.if(boolAnd(b, tcr, b.not(start)), (continueReload) => {
    const body = asBody(continueReload);

    body.if(boolAnd(body, body.not(stop), reloadedBytes), (more) => {
      const scope = asBody(more);

      clearFlag(scope, config, I2C_FLAG_TCR);
      setFlag(scope, config, FLAG_BYTE_DONE, bool(scope, true));
      nextDataBit(scope, config, num(scope, 0));
      requestPinSync(scope, config);
      irqDirty(scope);
    });
  });
  requestPinSync(b, config);
  irqDirty(b);
}

function writeIcr(
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const clear = place(b, value, offset, size);

  b.if(boolBit(b, clear, ICR_ADDRCF), (hit) => clearFlag(asBody(hit), config, I2C_FLAG_ADDR));
  b.if(boolBit(b, clear, ICR_NACKCF), (hit) => clearFlag(asBody(hit), config, I2C_FLAG_NACK));
  b.if(boolBit(b, clear, ICR_STOPCF), (hit) => clearFlag(asBody(hit), config, I2C_FLAG_STOP));
  b.if(boolBit(b, clear, ICR_OVRCF), (hit) => clearFlag(asBody(hit), config, I2C_FLAG_OVR));
  b.if(boolBit(b, clear, ICR_TIMOUTCF), (hit) => clearFlag(asBody(hit), config, I2C_FLAG_TIMEOUT));
  // BERR/ARLO/PEC/ALERT 本模型不产生；对应 W1C 位接受写入但保持无副作用。
  void ICR_BERRCF;
  void ICR_ARLOCF;
  void ICR_PECCF;
  void ICR_ALERTCF;
  irqDirty(b);
}

function writeTxdr(
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const pe = boolBit(b, loadReg(b, config, I2C_CR1), CR1_PE);
  const txLoaded = boolBit(b, loadFlags(b, config), I2C_FLAG_TX_LOADED);
  const lane = b.equal(types.number, b.bitAnd(offset, num(b, 3)), num(b, 0));
  const data = b.bitAnd(
    b.shiftRightUnsigned(value, b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8))),
    num(b, size === 2 ? 0xffff : 0xff),
  );

  b.if(boolAnd(b, boolAnd(b, pe, b.not(txLoaded)), lane), (ready) => {
    const body = asBody(ready);

    storeInternal(body, config, I2C_F_TX, data);
    setFlag(body, config, I2C_FLAG_TX_LOADED, bool(body, true));
    requestPinSync(body, config);
    irqDirty(body);
  });
}

export function writeI2c(
  b: Body,
  config: I2cConfig,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const valid = b.lessThan(offset, num(b, I2C_REGISTER_SIZE));

  b.if(
    boolAnd(b, valid, b.equal(types.number, wordOffset, num(b, I2C_CR1))),
    (hit) => writeCr1(asBody(hit), config, offset, size, value),
    (other) => {
      const body = asBody(other);

      body.if(
        boolAnd(body, valid, body.equal(types.number, wordOffset, num(body, I2C_CR2))),
        (hit) => writeCr2(asBody(hit), config, offset, size, value),
        (next) => {
          const body2 = asBody(next);

          body2.if(
            boolAnd(body2, valid, body2.equal(types.number, wordOffset, num(body2, I2C_ICR))),
            (hit) => writeIcr(asBody(hit), config, offset, size, value),
            (next2) => {
              const body3 = asBody(next2);

              body3.if(
                boolAnd(body3, valid, body3.equal(types.number, wordOffset, num(body3, I2C_TXDR))),
                (hit) => writeTxdr(asBody(hit), config, offset, size, value),
                (next3) => {
                  const body4 = asBody(next3);

                  body4.if(
                    boolOr(
                      body4,
                      body4.equal(types.number, wordOffset, num(body4, I2C_ISR)),
                      body4.equal(types.number, wordOffset, num(body4, I2C_RXDR)),
                    ),
                    () => {},
                    (register) => {
                      const scope = asBody(register);

                      scope.if(
                        boolAnd(
                          scope,
                          valid,
                          boolOr(
                            scope,
                            scope.equal(types.number, wordOffset, num(scope, I2C_OAR1)),
                            boolOr(
                              scope,
                              scope.equal(types.number, wordOffset, num(scope, I2C_OAR2)),
                              boolOr(
                                scope,
                                scope.equal(types.number, wordOffset, num(scope, I2C_TIMINGR)),
                                scope.equal(types.number, wordOffset, num(scope, I2C_TIMEOUTR)),
                              ),
                            ),
                          ),
                        ),
                        (hit) => {
                          const body5 = asBody(hit);

                          storeRegAt(
                            body5,
                            config,
                            wordOffset,
                            merge(body5, loadRegAt(body5, config, wordOffset), value, offset, size),
                          );
                          body5.if(
                            body5.equal(types.number, wordOffset, num(body5, I2C_TIMINGR)),
                            (timing) => updateI2cTiming(asBody(timing), config),
                          );
                          requestPinSync(body5, config);
                          irqDirty(body5);
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
  updateI2cSlot(b, true);
}

/**
 * I2C 的 DMA 请求条件。TX 只在 TXIS（TXDR 空、数据阶段、NBYTES>0、无 NACK）时
 * 拉请求；RX 只在 RXNE（RXDR 满）时拉请求；都要求 PE 与对应 CR1 DMAEN。
 * 数据仍由 DmaBus 对窄 RXDR/TXDR 端点读写，走现有寄存器副作用。
 */
export function i2cDmaRequestReady(b: Body, config: I2cConfig, tx: boolean): Value<boolean> {
  const cr1 = loadReg(b, config, I2C_CR1);
  const flags = loadFlags(b, config);
  const pe = boolBit(b, cr1, CR1_PE);
  const dma = boolBit(b, cr1, tx ? CR1_TXDMAEN : CR1_RXDMAEN);

  if (!tx) return boolAnd(b, dma, boolAnd(b, pe, boolBit(b, flags, I2C_FLAG_RX_FULL)));

  const stageData = b.notEqual(types.number, loadInternal(b, config, I2C_F_SCRATCH), num(b, 0));
  const txis = boolAnd(
    b,
    boolAnd(b, pe, b.not(boolBit(b, flags, I2C_FLAG_TX_LOADED))),
    boolAnd(
      b,
      stageData,
      boolAnd(
        b,
        b.greaterThan(nbytes(b, config), num(b, 0)),
        boolAnd(b, busNotNack(b, config), b.not(readDirection(b, config))),
      ),
    ),
  );

  return boolAnd(b, dma, txis);
}

export function i2cEventPending(b: Body, config: I2cConfig): Value<boolean> {
  const cr1 = loadReg(b, config, I2C_CR1);
  const isr = isrValue(b, config);

  return boolOr(
    b,
    boolAnd(b, boolBit(b, cr1, CR1_TXIE), boolBit(b, isr, ISR_TXIS)),
    boolOr(
      b,
      boolAnd(b, boolBit(b, cr1, CR1_RXIE), boolBit(b, isr, ISR_RXNE)),
      boolOr(
        b,
        boolAnd(b, boolBit(b, cr1, CR1_ADDRIE), boolBit(b, isr, ISR_ADDR)),
        boolOr(
          b,
          boolAnd(b, boolBit(b, cr1, CR1_STOPIE), boolBit(b, isr, ISR_STOPF)),
          boolAnd(
            b,
            boolBit(b, cr1, CR1_TCIE),
            boolOr(b, boolBit(b, isr, ISR_TC), boolBit(b, isr, ISR_TCR)),
          ),
        ),
      ),
    ),
  );
}

export function i2cErrorPending(b: Body, config: I2cConfig): Value<boolean> {
  const cr1 = loadReg(b, config, I2C_CR1);
  const isr = isrValue(b, config);

  return boolOr(
    b,
    boolAnd(b, boolBit(b, cr1, CR1_NACKIE), boolBit(b, isr, ISR_NACKF)),
    boolAnd(
      b,
      boolBit(b, cr1, CR1_ERRIE),
      boolOr(b, boolBit(b, isr, ISR_OVR), boolBit(b, isr, ISR_TIMEOUT)),
    ),
  );
}

export function i2cPending(b: Body, config: I2cConfig): Value<boolean> {
  return boolOr(b, i2cEventPending(b, config), i2cErrorPending(b, config));
}

/** I2C 开漏 AF 驱动：PE 使能时输出级有效，低电平拉低，高电平释放到上拉。 */
export function i2cDrivers(): readonly AlternateDriver[] {
  const drivers: AlternateDriver[] = [];

  for (const config of I2C_CONFIGS) {
    for (const pin of config.pins) {
      drivers.push({
        port: pin.port,
        pin: pin.pin,
        af: pin.af,
        active: (b) => boolBit(b, loadReg(b, config, I2C_CR1), CR1_PE),
        level: (b) => b.not(lineLow(b, config, pin.role)),
        openDrain: true,
      });
    }
  }

  return drivers;
}

/**
 * 把 I2C 的活动位/下一节拍写入中央 `peripheral.ts` 的槽位。
 *
 * 槽位的 deadline 使用“最短暂相位”而不是每个相位的精确剩余：这样 `tickPs` 一旦
 * 收紧就不会在后续相位变长时抖动；实际相位是否到期仍由 `advanceI2c` 自己的
 * `remaining` 判定。等待软件写 TXDR/STOP 的相位 deadline 仍是短相位，会多产生几次
 * 空服务，但不会越过任何软件可见状态。
 */
function updateI2cSlot(b: Body, refresh: boolean): void {
  const active = i2cActive(b);
  const deadline = i2cRequestedTickPs(b);

  setPeripheralActive(b, I2C_SLOT, active);
  setPeripheralDeadline(
    b,
    I2C_SLOT,
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
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, I2C_RANGE_SIZE));

function readI2cAddress(b: Body, address: Value<number>, size: number): Value<number> {
  const result = b.local(types.number, 0);
  const step = (body: Body, index: number): void => {
    const config = I2C_CONFIGS[index];

    if (config === undefined) return;
    body.if(
      inRange(body, address, config.base),
      (hit) => {
        const scope = asBody(hit);

        scope.setLocal(
          result,
          readI2c(scope, config, scope.subtract(address, num(scope, config.base)), size),
        );
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);

  return b.getLocal(result);
}

function writeI2cAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const step = (body: Body, index: number): void => {
    const config = I2C_CONFIGS[index];

    if (config === undefined) return;
    body.if(
      inRange(body, address, config.base),
      (hit) => {
        const scope = asBody(hit);

        writeI2c(scope, config, scope.subtract(address, num(scope, config.base)), size, value);
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

const i2cInterrupts: readonly InterruptSource[] = I2C_CONFIGS.flatMap((config) => [
  {
    exception: 16 + config.evIrq,
    pending: (b: Body) => i2cEventPending(b, config),
    acknowledge: () => {},
  },
  {
    exception: 16 + config.erIrq,
    pending: (b: Body) => i2cErrorPending(b, config),
    acknowledge: () => {},
  },
]);

export const i2cModule: PeripheralModule = {
  id: 'i2c',
  ranges: I2C_CONFIGS.map((config) => ({ base: config.base, size: I2C_RANGE_SIZE })),
  read: readI2cAddress,
  write: writeI2cAddress,
  slot: I2C_SLOT,
  advance: advanceI2c,
  interrupts: i2cInterrupts,
  alternateDrivers: i2cDrivers(),
};

export {
  I2C1_BASE,
  I2C2_BASE,
  I2C3_BASE,
  I2C_CONFIGS,
  I2C_STATE,
  I2C_STATE_STRIDE,
} from './i2c-layout';
