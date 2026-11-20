import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { ADC_MIN_REFERENCE } from './adc-layout';
import { ANALOG, PeripheralSlot } from './layout';
import {
  OPAMP_STATE,
  driveAnalogVoltage,
  extract,
  extractAt,
  loadStateAt,
  merge,
} from './analog';
import { asBody, bool, boolAnd, boolBitAt, boolOr, num, u32 } from './ir';
import type { Body } from './ir';
import { refreshTick } from './tick';
import { setPeripheralActive, setPeripheralDeadline } from './peripheral';
import type { PeripheralModule } from './peripheral';

/**
 * STM32G431RBT6 OPAMP1–OPAMP3 的可行模拟模型。
 *
 * 每个 OPAMP 的 CSR 在 0x4001_0300 + 4×index，TCMR 在 +0x18。支持：
 * - OPAMPxEN、VPSEL、VMSEL、PGGAIN、USERTRIM/CALON/CALSEL/TRIM 保存；
 * - VMSEL=10（PGA）或 11（follower）时，用正相输入引脚采样电压 × 增益产生输出；
 * - 输出用正电阻分压到 VREFP/VSS1 表达，`VOUT` 被钳制在 0..VREFP；
 * - 输出引脚：OPAMP1=PA2、OPAMP2=PA6、OPAMP3=PB1。
 *
 * 已核对输入引脚（DS12589）：
 * - OPAMP1: VINP0=PA1 / VINP1=PA7；VINM0=PA3 / VINM1=PC5；VOUT=PA2；
 * - OPAMP2: VINP0=PA7 / VINP1=PB0；VINM0=PA5 / VINM1=PC5；VOUT=PA6；
 * - OPAMP3: VINP0=PA1 / VINP1=PB0；VINM0=PB2 / VINM1=PB2；VOUT=PB1。
 *
 * PGA 增益编码 0..5 按 2/4/8/16/32/64；其他值按 1（follower）处理并文档化。
 * 未建模：独立模式（VMSEL=00/01，外部反馈网络）、DAC3 内部输入、TCMR 定时器
 * 切换、校准/失调修调、输出到 ADC 内部通道、带宽/压摆率/噪声。输入浮空或
 * VREFP 无效时释放输出，不伪造电压。
 */

export const OPAMP1_BASE = 0x40010300;
export const OPAMP_COUNT = 3;
const OPAMP_CSR = 0x00;
const OPAMP_TCMR = 0x18;

const OPAMP_CSR_EN = 1 << 0;
const OPAMP_CSR_VPSEL_SHIFT = 2;
const OPAMP_CSR_VMSEL_SHIFT = 5;
const OPAMP_CSR_PGGAIN_SHIFT = 14;

const PGA_GAINS = [2, 4, 8, 16, 32, 64] as const;
const MIN_REFERENCE = ADC_MIN_REFERENCE;
/** follower/PGA 输出跟随输入/供电的刷新周期。 */
const OPAMP_REFRESH_PS = 10_000_000;

interface OpampConfig {
  readonly index: 1 | 2 | 3;
  readonly vinp: readonly [string, string];
  readonly vout: string;
  readonly voutPort: number;
  readonly voutBit: number;
}

const OPAMPS: readonly OpampConfig[] = [
  { index: 1, vinp: ['PA1', 'PA7'], vout: 'PA2', voutPort: 0, voutBit: 2 },
  { index: 2, vinp: ['PA7', 'PB0'], vout: 'PA6', voutPort: 0, voutBit: 6 },
  { index: 3, vinp: ['PA1', 'PB0'], vout: 'PB1', voutPort: 1, voutBit: 1 },
];

const load = (b: Body, index: number, offset: number): Value<number> =>
  loadStateAt(b, OPAMP_STATE, index * 4 + offset);

const store = (b: Body, index: number, offset: number, value: Value<number>): void => {
  b.store32le(
    ANALOG,
    num(b, OPAMP_STATE + index * 4 + offset),
    u32(b, value),
  );
};

interface Sampled {
  readonly valid: Value<boolean>;
  readonly voltage: Value<number>;
}

function samplePin(b: Body, pin: string): Sampled {
  const sample = b.local(types.sample, b.readSample(pin));
  const status = b.field(b.getLocal(sample), 'status');
  const optional = b.field(b.getLocal(sample), 'voltage');
  const statusValid = b.equal(
    types.sampleStatus,
    status,
    b.constant(types.sampleStatus, types.sampleStatus.members.valid),
  );
  const valid = b.select(
    types.bool,
    statusValid,
    (inner) => inner.not(inner.isNone(optional)),
    (inner) => inner.constant(types.bool, false),
  );
  const voltage = b.select(
    types.number,
    b.isNone(optional),
    (none) => none.constant(types.number, 0),
    (present) => present.nonNull(optional),
  );

  return { valid, voltage };
}

/** 依据 CSR 的 VPSEL/VMSEL/PGGAIN 计算输出。 */
function updateOutput(b: Body, config: OpampConfig, csr: Value<number>): void {
  const enabled = boolBitAt(b, csr, 0);
  const vpsel = b.bitAnd(b.shiftRightUnsigned(csr, num(b, OPAMP_CSR_VPSEL_SHIFT)), num(b, 3));
  const vmsel = b.bitAnd(b.shiftRightUnsigned(csr, num(b, OPAMP_CSR_VMSEL_SHIFT)), num(b, 3));
  const pga = b.bitAnd(b.shiftRightUnsigned(csr, num(b, OPAMP_CSR_PGGAIN_SHIFT)), num(b, 0x1f));
  const input = b.local(types.number, num(b, 0));
  const inputValid = b.local(types.bool, false);

  for (let selection = 0; selection < 2; selection += 1)
    b.if(b.equal(types.number, vpsel, num(b, selection)), (inner) => {
      const body = asBody(inner);
      const sampled = samplePin(body, config.vinp[selection]!);

      body.setLocal(input, sampled.voltage);
      body.setLocal(inputValid, sampled.valid);
    });

  // VMSEL=2 (PGA) 或 3 (follower) 才由内部反馈定义输出；00/01 需要外部网络。
  const internalFeedback = boolAnd(
    b,
    b.notEqual(types.number, vmsel, num(b, 0)),
    b.notEqual(types.number, vmsel, num(b, 1)),
  );
  const follower = b.equal(types.number, vmsel, num(b, 3));
  const gain = b.select(
    types.number,
    follower,
    (inner) => inner.constant(types.number, 1),
    (inner) => {
      let result = inner.constant(types.number, 1);

      for (let code = PGA_GAINS.length - 1; code >= 0; code -= 1) {
        const fallback = result;

        result = inner.select(
          types.number,
          inner.equal(types.number, pga, inner.constant(types.number, code)),
          (hit) => hit.constant(types.number, PGA_GAINS[code]!),
          () => fallback,
        );
      }

      return result;
    },
  );
  const reference = samplePin(b, 'VREFP');
  const referenceValid = boolAnd(
    b,
    reference.valid,
    b.greaterThan(reference.voltage, num(b, MIN_REFERENCE)),
  );
  const raw = b.multiply(b.getLocal(input), gain);
  const clamped = b.min(b.max(raw, num(b, 0)), reference.voltage);
  const valid = boolAnd(
    b,
    boolAnd(b, enabled, internalFeedback),
    boolAnd(b, b.getLocal(inputValid), referenceValid),
  );
  const output = b.select(
    types.number,
    valid,
    () => clamped,
    (inner) => inner.constant(types.number, 0),
  );

  driveAnalogVoltage(
    b,
    config.vout,
    config.voutPort,
    config.voutBit,
    output,
    reference.voltage,
    valid,
  );
}

/** OPAMP 输出跟随输入/供电的活动槽；全部关闭时不占时间。 */
function refreshOpampSlot(
  b: Body,
  changedIndex?: number,
  changedCsr?: Value<number>,
): void {
  let active: Value<boolean> = bool(b, false);

  for (let each = 0; each < OPAMPS.length; each += 1) {
    const csr =
      each === changedIndex && changedCsr !== undefined
        ? changedCsr
        : load(b, each, OPAMP_CSR);

    active = boolOr(b, active, boolBitAt(b, csr, 0));
  }

  const slot = PeripheralSlot.Misc;

  setPeripheralActive(b, slot, active);
  setPeripheralDeadline(
    b,
    slot,
    b.select(
      types.number,
      active,
      (on) => on.constant(types.number, OPAMP_REFRESH_PS),
      (off) => off.constant(types.number, 0),
    ),
  );
  refreshTick(b);
}

/** 周期重算 follower/PGA 输出；输入、参考或供电变化会在一个刷新周期内跟随。 */
export function advanceOpamp(b: Body): void {
  for (let each = 0; each < OPAMPS.length; each += 1)
    updateOutput(b, OPAMPS[each]!, load(b, each, OPAMP_CSR));

  refreshOpampSlot(b);
}

function readAt(b: Body, index: number, offset: number, size: number): Value<number> {
  const wordOffset = offset & 0xfc;

  if (wordOffset !== OPAMP_CSR && wordOffset !== OPAMP_TCMR) return num(b, 0);

  return extractAt(b, load(b, index, wordOffset), offset, size);
}

function writeAt(
  b: Body,
  index: number,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = offset & 0xfc;

  if (wordOffset !== OPAMP_CSR && wordOffset !== OPAMP_TCMR) return;

  const current = load(b, index, wordOffset);
  const merged = merge(b, current, value, num(b, offset), size);

  store(b, index, wordOffset, merged);

  if (wordOffset === OPAMP_CSR) {
    updateOutput(b, OPAMPS[index]!, merged);
    refreshOpampSlot(b, index, merged);
  }
}

export function readOpampAt(b: Body, index: number, offset: number, size: number): Value<number> {
  if (OPAMPS[index] === undefined) return num(b, 0);

  return readAt(b, index, offset, size);
}

export function writeOpampAt(
  b: Body,
  index: number,
  offset: number,
  size: number,
  value: Value<number>,
): void {
  if (OPAMPS[index] === undefined) return;
  writeAt(b, index, offset, size, value);
}

export function readOpamp(b: Body, address: Value<number>, size: number): Value<number> {
  const wordAddress = b.bitAnd(address, num(b, 0xfffffffc));
  const offset = b.bitAnd(address, num(b, 3));
  const result = b.local(types.number, 0);

  for (let each = 0; each < OPAMPS.length; each += 1) {
    for (const register of [OPAMP_CSR, OPAMP_TCMR]) {
      const absolute = OPAMP1_BASE + each * 4 + register;

      b.if(b.equal(types.number, wordAddress, num(b, absolute)), (inner) => {
        inner.setLocal(result, readAt(asBody(inner), each, register, 4));
      });
    }
  }

  return extract(b, b.getLocal(result), offset, size);
}

export function writeOpamp(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordAddress = b.bitAnd(address, num(b, 0xfffffffc));
  const offset = b.bitAnd(address, num(b, 3));

  for (let each = 0; each < OPAMPS.length; each += 1) {
    for (const register of [OPAMP_CSR, OPAMP_TCMR]) {
      const absolute = OPAMP1_BASE + each * 4 + register;

      b.if(b.equal(types.number, wordAddress, num(b, absolute)), (inner) => {
        const body = asBody(inner);
        const current = load(body, each, register);
        const merged = merge(body, current, value, offset, size);

        store(body, each, register, merged);
        if (register === OPAMP_CSR) {
          updateOutput(body, OPAMPS[each]!, merged);
          refreshOpampSlot(body, each, merged);
        }
      });
    }
  }
}

/** 中央注册项：OPAMP 无时间行为。 */
export function createOpampModule(): PeripheralModule {
  return {
    id: 'opamp',
    ranges: [{ base: OPAMP1_BASE, size: 0x24 }],
    read: readOpamp,
    write: writeOpamp,
    slot: PeripheralSlot.Misc,
    advance: advanceOpamp,
  };
}

export {
  OPAMP_CSR,
  OPAMP_TCMR,
  OPAMP_CSR_EN,
  OPAMP_CSR_VPSEL_SHIFT,
  OPAMP_CSR_VMSEL_SHIFT,
  OPAMP_CSR_PGGAIN_SHIFT,
  OPAMPS,
};
