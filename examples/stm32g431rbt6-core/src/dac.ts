import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { ANALOG, PeripheralSlot } from './layout';
import {
  DAC_STATE,
  driveAnalogVoltage,
  extractAt,
  extract,
  loadStateAt,
  merge,
  readRegister,
  readRegisterAt,
  writeRegisterAt,
} from './analog';
import {
  asBody,
  boolAnd,
  boolBitAt,
  boolOr,
  num,
  u32,
} from './ir';
import type { Body } from './ir';
import { refreshTick } from './tick';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431RBT6 DAC1（两个外部 12 位通道）的基础模型。
 *
 * 地址 0x5000_0800，寄存器布局与 RM0440 第 22 章一致。模型只覆盖外部通道的
 * 常规输出：ENx、TENx/TSELx（软件触发）、DHR12R/L、DHR8R、DOR、MCR.MODEx、
 * 双通道 DHR 与 SR/CCR 保存。噪声/三角波、采样保持、DMA 请求与内部 DAC3
 * 通道不建模；WAVEx 非 0 时输出仍取 DOR，不会伪造波形。
 *
 * 12 位传输函数为 `VOUT = VREFP × DOR / 4096`（4095 满码 = 4095/4096 VREFP）。
 * 输出用固定 10 kΩ Thevenin 电阻的两只正电阻表达，负载/饱和由电气求解处理；
 * VREFP 浮空/欠压时释放输出。只要通道使能就占用独立刷新槽，每 10 µs 跟踪
 * VREFP 与外部负载。PA4/PA5 只在 GPIO MODER=11 时由 DAC 驱动/释放，不抢 GPIO。
 */

export const DAC1_BASE = 0x50000800;
export const DAC1_SIZE = 0x100;

const DAC_CR = 0x00;
const DAC_SWTRIGR = 0x04;
const DAC_DHR12R1 = 0x08;
const DAC_DHR12L1 = 0x0c;
const DAC_DHR8R1 = 0x10;
const DAC_DHR12R2 = 0x14;
const DAC_DHR12L2 = 0x18;
const DAC_DHR8R2 = 0x1c;
const DAC_DHR12RD = 0x20;
const DAC_DHR12LD = 0x24;
const DAC_DHR8RD = 0x28;
const DAC_DOR1 = 0x2c;
const DAC_DOR2 = 0x30;
const DAC_SR = 0x34;
const DAC_CCR = 0x38;
const DAC_MCR = 0x3c;
const DAC_SHSR1 = 0x40;
const DAC_SHSR2 = 0x44;
const DAC_SHHR = 0x48;
const DAC_SHRR = 0x4c;
const DAC_STR1 = 0x58;
const DAC_STR2 = 0x5c;
const DAC_STMODR = 0x60;

const DAC_CR_EN1 = 1 << 0;
const DAC_CR_TEN1 = 1 << 1;
const DAC_CR_EN2 = 1 << 16;
const DAC_CR_TEN2 = 1 << 17;

/** DHR 的保持值放在 DAC 状态区 0xC0 起；DOR 仍是固件可见寄存器。 */
const DAC_HOLD1 = 0xc0;
const DAC_HOLD2 = 0xc4;
const DAC_MIN_REFERENCE = 0.1;
/** 输出跟随 VREFP/负载的刷新周期；只在有通道使能时占用槽位。 */
const DAC_REFRESH_PS = 10_000_000;

interface DacChannel {
  readonly index: 1 | 2;
  readonly resetOffset: number;
  readonly enable: number;
  readonly triggerEnable: number;
  readonly holding: number;
  readonly pin: string;
  readonly port: number;
  readonly bit: number;
}

const CHANNELS: readonly DacChannel[] = [
  {
    index: 1,
    resetOffset: DAC_DOR1,
    enable: DAC_CR_EN1,
    triggerEnable: DAC_CR_TEN1,
    holding: DAC_HOLD1,
    pin: 'PA4',
    port: 0,
    bit: 4,
  },
  {
    index: 2,
    resetOffset: DAC_DOR2,
    enable: DAC_CR_EN2,
    triggerEnable: DAC_CR_TEN2,
    holding: DAC_HOLD2,
    pin: 'PA5',
    port: 0,
    bit: 5,
  },
];

const load = (b: Body, offset: number): Value<number> => loadStateAt(b, DAC_STATE, offset);

const store = (b: Body, offset: number, value: Value<number>): void => {
  writeWordAt(b, ANALOG, DAC_STATE + offset, value);
};

/** 与 ir.writeWordAt 相同，但避免把 ANALOG memory 名暴露给调用方。 */
function writeWordAt(b: Body, memory: string, offset: number, value: Value<number>): void {
  b.store32le(memory, num(b, offset), u32(b, value));
}

/** 把 12 位码写入一个通道：保持寄存器 + 未使能触发时立即更新 DOR + 引脚意图。 */
function updateChannel(b: Body, channel: DacChannel): void {
  const cr = load(b, DAC_CR);
  const enabled = boolBitAt(b, cr, channel.index === 1 ? 0 : 16);
  const trigger = boolBitAt(b, cr, channel.index === 1 ? 1 : 17);
  const holding = load(b, channel.holding);
  const dor = load(b, channel.resetOffset);
  const nextDor = b.select(types.number, trigger, () => dor, () => holding);

  store(b, channel.resetOffset, b.bitAnd(nextDor, num(b, 0xfff)));
  syncOutput(b, channel, b.bitAnd(nextDor, num(b, 0xfff)), enabled);
}

/**
 * 电压输出：12 位 DAC 传输函数为 `Vout = VREFP × DOR / 4096`（4096 个量化台阶，
 * 满码 4095 对应 4095/4096 VREFP）。共享 `driveAnalogVoltage` 提供固定 10 kΩ
 * Thevenin 输出电阻，并在 pins 非模拟模式时让出所有权。
 */
function syncOutput(
  b: Body,
  channel: DacChannel,
  code: Value<number>,
  enabled: Value<boolean>,
): void {
  const sample = b.local(types.sample, b.readSample('VREFP'));
  const status = b.field(b.getLocal(sample), 'status');
  const voltageOptional = b.field(b.getLocal(sample), 'voltage');
  const statusValid = b.equal(
    types.sampleStatus,
    status,
    b.constant(types.sampleStatus, types.sampleStatus.members.valid),
  );
  const reference = b.select(
    types.number,
    b.isNone(voltageOptional),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(voltageOptional),
  );
  const referenceValid = boolAnd(
    b,
    statusValid,
    b.greaterThan(reference, num(b, DAC_MIN_REFERENCE)),
  );
  const clamped = b.min(b.max(code, num(b, 0)), num(b, 4095));
  const voltage = b.multiply(
    reference,
    b.divide(clamped, num(b, 4096)),
  );

  driveAnalogVoltage(
    b,
    channel.pin,
    channel.port,
    channel.bit,
    voltage,
    reference,
    boolAnd(b, enabled, referenceValid),
  );
}

function dhrToCode(b: Body, offset: number, value: Value<number>): Value<number> {
  if (offset === DAC_DHR12L1 || offset === DAC_DHR12L2)
    return b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, 4)), num(b, 0xfff));
  if (offset === DAC_DHR8R1 || offset === DAC_DHR8R2)
    return b.shiftLeft(b.bitAnd(u32(b, value), num(b, 0xff)), num(b, 4));

  return b.bitAnd(u32(b, value), num(b, 0xfff));
}

function writeDhr(b: Body, offset: number, value: Value<number>): void {
  if (offset === DAC_DHR12R1 || offset === DAC_DHR12L1 || offset === DAC_DHR8R1) {
    const code = dhrToCode(b, offset, value);

    store(b, DAC_HOLD1, code);
    updateChannel(b, CHANNELS[0]!);

    return;
  }

  if (offset === DAC_DHR12R2 || offset === DAC_DHR12L2 || offset === DAC_DHR8R2) {
    const code = dhrToCode(b, offset, value);

    store(b, DAC_HOLD2, code);
    updateChannel(b, CHANNELS[1]!);

    return;
  }

  if (offset === DAC_DHR12RD) {
    store(b, DAC_HOLD1, b.bitAnd(u32(b, value), num(b, 0xfff)));
    store(b, DAC_HOLD2, b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, 16)), num(b, 0xfff)));
    updateChannel(b, CHANNELS[0]!);
    updateChannel(b, CHANNELS[1]!);

    return;
  }

  if (offset === DAC_DHR12LD) {
    store(b, DAC_HOLD1, b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, 4)), num(b, 0xfff)));
    store(b, DAC_HOLD2, b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, 20)), num(b, 0xfff)));
    updateChannel(b, CHANNELS[0]!);
    updateChannel(b, CHANNELS[1]!);

    return;
  }

  if (offset === DAC_DHR8RD) {
    store(b, DAC_HOLD1, b.shiftLeft(b.bitAnd(u32(b, value), num(b, 0xff)), num(b, 4)));
    store(b, DAC_HOLD2, b.shiftLeft(b.bitAnd(b.shiftRightUnsigned(u32(b, value), num(b, 8)), num(b, 0xff)), num(b, 4)));
    updateChannel(b, CHANNELS[0]!);
    updateChannel(b, CHANNELS[1]!);
  }
}

function writeRegisterStatic(b: Body, offset: number, size: number, value: Value<number>): void {
  const wordOffset = offset & 0xfc;

  if (wordOffset === DAC_DOR1 || wordOffset === DAC_DOR2) return;

  if (
    wordOffset === DAC_DHR12R1 ||
    wordOffset === DAC_DHR12L1 ||
    wordOffset === DAC_DHR8R1 ||
    wordOffset === DAC_DHR12R2 ||
    wordOffset === DAC_DHR12L2 ||
    wordOffset === DAC_DHR8R2 ||
    wordOffset === DAC_DHR12RD ||
    wordOffset === DAC_DHR12LD ||
    wordOffset === DAC_DHR8RD
  ) {
    writeDhr(b, wordOffset, value);

    return;
  }

  if (wordOffset === DAC_SWTRIGR) {
    const trigger = u32(b, value);

    b.if(boolBitAt(b, trigger, 0), (one) => {
      const body = asBody(one);

      store(body, DAC_DOR1, load(body, DAC_HOLD1));
      syncOutput(
        body,
        CHANNELS[0]!,
        load(body, DAC_HOLD1),
        boolBitAt(body, load(body, DAC_CR), 0),
      );
    });
    b.if(boolBitAt(b, trigger, 1), (two) => {
      const body = asBody(two);

      store(body, DAC_DOR2, load(body, DAC_HOLD2));
      syncOutput(
        body,
        CHANNELS[1]!,
        load(body, DAC_HOLD2),
        boolBitAt(body, load(body, DAC_CR), 16),
      );
    });

    return;
  }

  if (wordOffset === DAC_CR) {
    const current = load(b, DAC_CR);
    const merged = merge(b, current, value, num(b, offset), size);

    store(b, DAC_CR, merged);
    updateChannel(b, CHANNELS[0]!);
    updateChannel(b, CHANNELS[1]!);

    return;
  }

  writeRegisterAt(b, DAC_STATE, offset, size, value);
}

/** DAC 输出跟随输入/参考变化的活动槽；无通道使能时不占时间。 */
function refreshDacSlot(b: Body): void {
  const cr = load(b, DAC_CR);
  const active = boolOr(b, boolBitAt(b, cr, 0), boolBitAt(b, cr, 16));
  const slot = PeripheralSlot.Reserved;

  setPeripheralActive(b, slot, active);
  setPeripheralDeadline(
    b,
    slot,
    b.select(
      types.number,
      active,
      (on) => on.constant(types.number, DAC_REFRESH_PS),
      (off) => off.constant(types.number, 0),
    ),
  );
  refreshTick(b);
}

/** 周期刷新 DAC 输出：跟踪 VREFP、供电和外部负载变化。 */
export function advanceDac(b: Body): void {
  updateChannel(b, CHANNELS[0]!);
  updateChannel(b, CHANNELS[1]!);
  refreshDacSlot(b);
}

export function readDacAt(b: Body, offset: number, size: number): Value<number> {
  const wordOffset = offset & 0xfc;

  if (wordOffset === DAC_DOR1) return extractAt(b, b.bitAnd(load(b, DAC_DOR1), num(b, 0xfff)), offset, size);
  if (wordOffset === DAC_DOR2) return extractAt(b, b.bitAnd(load(b, DAC_DOR2), num(b, 0xfff)), offset, size);
  if (wordOffset > DAC_STMODR) return num(b, 0);

  return readRegisterAt(b, DAC_STATE, offset, size);
}

export function readDac(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0xfc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, DAC_DOR1)),
    (one) => one.setLocal(result, one.bitAnd(load(asBody(one), DAC_DOR1), one.constant(types.number, 0xfff))),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, DAC_DOR2)),
        (two) => two.setLocal(result, two.bitAnd(load(asBody(two), DAC_DOR2), two.constant(types.number, 0xfff))),
        (rest) => {
          const scope = asBody(rest);

          scope.if(
            scope.lessThanOrEqual(wordOffset, num(scope, DAC_STMODR)),
            (hit) => hit.setLocal(result, readRegister(asBody(hit), DAC_STATE, wordOffset, 4)),
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeDacAt(
  b: Body,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = offset & 0xfc;

  if (wordOffset > DAC_STMODR) return;
  writeRegisterStatic(b, offset, size, value);
}

export function writeDac(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0xfc));

  // 与静态路径逐偏移一致；DAC 寄存器数量很少，展开比维护第二套动态分支简单。
  for (let register = 0; register <= DAC_STMODR; register += 4) {
    b.if(b.equal(types.number, wordOffset, num(b, register)), (hit) => {
      writeDacAt(asBody(hit), register, size, value);
    });
  }
  refreshDacSlot(b);
}

/** 中央注册项：DAC1 没有时间行为，不占用时间槽。 */
export function createDacModule(): PeripheralModule {
  return {
    id: 'dac1',
    ranges: [{ base: DAC1_BASE, size: DAC1_SIZE }],
    read: (b, address, size) =>
      readDac(b, b.subtract(address, num(b, DAC1_BASE)), size),
    write: (b, address, size, value) =>
      writeDac(b, b.subtract(address, num(b, DAC1_BASE)), size, value),
    slot: PeripheralSlot.Reserved,
    advance: advanceDac,
  };
}

export {
  DAC1_BASE as DAC_BASE,
  DAC_CR,
  DAC_SWTRIGR,
  DAC_DHR12R1,
  DAC_DHR12L1,
  DAC_DHR8R1,
  DAC_DHR12R2,
  DAC_DHR12L2,
  DAC_DHR8R2,
  DAC_DHR12RD,
  DAC_DHR12LD,
  DAC_DHR8RD,
  DAC_DOR1,
  DAC_DOR2,
  DAC_SR,
  DAC_CCR,
  DAC_MCR,
  DAC_SHSR1,
  DAC_SHSR2,
  DAC_SHHR,
  DAC_SHRR,
  DAC_STR1,
  DAC_STR2,
  DAC_STMODR,
};
