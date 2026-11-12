import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  PERIPH,
  SFR,
  SFR_CCAP0H,
  SFR_CCAP0L,
  SFR_CCAP1H,
  SFR_CCAP1L,
  SFR_CCAP2H,
  SFR_CCAP2L,
  SFR_CCAPM0,
  SFR_CCAPM1,
  SFR_CCAPM2,
  SFR_CCON,
  SFR_CH,
  SFR_CL,
  SFR_CMOD,
  SFR_IE,
  SFR_PCA_PWM0,
  SFR_PCA_PWM1,
  SFR_PCA_PWM2,
  SFR_P_SW1,
  SFR_TCON,
  asBody,
  number,
  periph8,
  periph16,
  readSfr,
  readSfrBit,
  setPeriph8,
  setPeriph16,
  sfrBitIsSet,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import { IRQ_VECTORS, markIrqDirty } from '../kernel/interrupt';
import { PCA_BASE } from './layout';
import {
  DRIVE_RESISTANCE,
  GROUND_PIN,
  SUPPLY_PIN,
  pinName,
  registerAlternateDriver,
  switchBits,
  syncPin,
} from './ports';
import type { Peripheral } from './types';

/**
 * CCP/PCA/PWM（第 11 章）。
 *
 * 16 位 PCA 计数器 CH:CL 是三个模块的公共时间基准，计数源由 `CMOD.CPS2:CPS0` 选择：
 * SYSclk/12、SYSclk/2、T0 溢出、ECI 外部输入、SYSclk、SYSclk/4、SYSclk/6、SYSclk/8。
 * `CR` 启动/停止；计数器回绕时硬件置 `CF`（CCON.7）。
 *
 * 每个模块由 `CCAPMn` 选择模式：
 * - `ECOMn` + `PWMn`：可调制脉冲输出，`PCA_PWMn.EBSn_1:EBSn_0` 选 8/7/6 位，
 *   比较值 `{EPCnL,CCAPnL}`，计数低位回绕时 `{EPCnH,CCAPnH}` 装载到 `{EPCnL,CCAPnL}`；
 * - `ECOMn` + `MATn` + `TOGn`：高速脉冲输出，匹配时翻转 CCPn；
 * - `ECOMn` + `MATn`：16 位软件定时器，匹配置位 CCFn；
 * - `CAPPn`/`CAPNn`：上升/下降沿捕获，把 CH:CL 装入 CCAPnH:CCAPnL。
 *
 * `advance` 会进入每一条指令的 IR，块体积直接决定器件可用性，因此：
 * - 顶层只读一个 periph 控制字节，PCA 停止时整段跳过；
 * - 三个模块用运行期下标循环共享一份代码，模式位在 `CCAPMn` 写入时折算成配置字节；
 * - 输出电平变化时按 `CCP_S1:CCP_S0` 直接写引脚意图，`syncPin` 只在模式寄存器被写时调用。
 *
 * 简化（手册未定义或超出本器件范围的部分）：
 * - `CPS2:CPS0=010`（T0 溢出）用 TCON.TF0 的上升沿近似计数，TF0 被清得比指令边界更快
 *   时会漏计；
 * - PWM 模式下 CAPPn/CAPNn 表示的「输出边沿中断」不实现，CCFn 只在比较匹配与捕获时置位；
 * - 复用引脚为「仅输入/高阻」时 PWM 无效的端口约束由 ports 模块统一处理。
 */

/** 下一个 PCA 时钟沿之前的系统时钟余量（16 位）。 */
const SUBTICK = PCA_BASE;
/** 边沿采样历史：bit0 外部计数电平、bit1 有效。 */
const JOIN = PCA_BASE + 2;
/** 高速输出电平：bit0–2 对应模块 0–2。 */
const TOGGLE = PCA_BASE + 3;
/** CCPn 捕获输入：bit0–2 上次采样电平、bit4–6 采样有效。 */
const CAPTURE = PCA_BASE + 4;
/** 控制摘要：bit0 = CR，bit4 = 计数源是边沿，bit5 = 边沿源是 T0（否则 ECI）。 */
const CONTROL = PCA_BASE + 5;
/** PCA 时钟分频比（1…12）。 */
const DIVISOR = PCA_BASE + 6;
/** 当前复用组的引脚电平：bit0–2 模块 0–2 的 CCPn，bit3 ECI。 */
const LEVELS = PCA_BASE + 7;
/** 每模块配置字节：bit0 比较、bit1 翻转、bit2 PWM、bit3 CAPP、bit4 CAPN、bit5 捕获使能。 */
const CONFIG = PCA_BASE + 8;

const CONFIG_COMPARE = 0x01;
const CONFIG_TOGGLE = 0x02;
const CONFIG_PWM = 0x04;
const CONFIG_CAPP = 0x08;
const CONFIG_CAPN = 0x10;
const CONFIG_CAPTURE = 0x20;

const CF = 7;
const CR = 6;
const CCF = [0, 1, 2] as const;

/** CCAPMn / CCAPnL / CCAPnH / PCA_PWMn 在 SFR 里的下标（地址低 7 位）。 */
const LOW_BASE = SFR_CCAP0L & 0x7f;
const HIGH_BASE = SFR_CCAP0H & 0x7f;
const PWM_BASE = SFR_PCA_PWM0 & 0x7f;

const ECOMn = 6;
const PWMn = 1;

interface CcpPin {
  readonly port: number;
  readonly bit: number;
}

interface PcaModule {
  readonly index: number;
  readonly mode: number;
  readonly low: number;
  readonly high: number;
  readonly pwm: number;
  readonly groups: readonly [CcpPin, CcpPin, CcpPin];
  readonly pins: readonly CcpPin[];
}

const moduleOf = (
  index: number,
  mode: number,
  low: number,
  high: number,
  pwm: number,
  groups: readonly [CcpPin, CcpPin, CcpPin],
): PcaModule => {
  const pins: CcpPin[] = [];

  for (const pin of groups)
    if (!pins.some((existing) => existing.port === pin.port && existing.bit === pin.bit))
      pins.push(pin);

  return { index, mode, low, high, pwm, groups, pins };
};

const MODULES: readonly PcaModule[] = [
  moduleOf(0, SFR_CCAPM0, SFR_CCAP0L, SFR_CCAP0H, SFR_PCA_PWM0, [
    { port: 1, bit: 1 },
    { port: 3, bit: 5 },
    { port: 2, bit: 5 },
  ]),
  moduleOf(1, SFR_CCAPM1, SFR_CCAP1L, SFR_CCAP1H, SFR_PCA_PWM1, [
    { port: 1, bit: 0 },
    { port: 3, bit: 6 },
    { port: 2, bit: 6 },
  ]),
  moduleOf(2, SFR_CCAPM2, SFR_CCAP2L, SFR_CCAP2H, SFR_PCA_PWM2, [
    { port: 3, bit: 7 },
    { port: 3, bit: 7 },
    { port: 2, bit: 7 },
  ]),
];

/** 三组复用位置上的 CCP0/1/2 与 ECI（下标 = CCP_S1:CCP_S0）。 */
const GROUP_PINS: readonly (readonly [CcpPin, CcpPin, CcpPin, CcpPin])[] = [
  [
    { port: 1, bit: 1 },
    { port: 1, bit: 0 },
    { port: 3, bit: 7 },
    { port: 1, bit: 2 },
  ],
  [
    { port: 3, bit: 5 },
    { port: 3, bit: 6 },
    { port: 3, bit: 7 },
    { port: 3, bit: 4 },
  ],
  [
    { port: 2, bit: 5 },
    { port: 2, bit: 6 },
    { port: 2, bit: 7 },
    { port: 2, bit: 4 },
  ],
];

/** CPS2:CPS0 → PCA 时钟分频比（010/011 由边沿驱动，分频比取 1）。 */
const DIVISORS = [12, 2, 1, 1, 1, 4, 6, 8] as const;

const nonZero = (b: Body, value: Value<number>): Value<boolean> =>
  b.notEqual(types.number, value, number(b, 0));

const bitOf = (b: Body, condition: Value<boolean>): Value<number> =>
  b.select(
    types.number,
    condition,
    (inner) => number(asBody(inner), 1),
    (inner) => number(asBody(inner), 0),
  );

const bitAt = (b: Body, value: Value<number>, index: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(value, number(b, index)), number(b, 1));

const pinLevel = (b: Body, pin: CcpPin): Value<number> =>
  bitOf(
    b,
    b.equal(
      types.logic,
      b.field(b.readSample(pinName(pin.port, pin.bit)), 'level'),
      b.constant(types.logic, types.logic.members.high),
    ),
  );

const storeSfr = (b: Body, address: number, value: Value<number>): void => {
  b.store8(SFR, number(b, address & 0x7f), value);
};

/** 置 CCON 的标志位（裸写锁存器，不触发端口重算）。 */
const setFlag = (b: Body, bit: number): void => {
  storeSfr(b, SFR_CCON, b.bitOr(readSfr(b, SFR_CCON), number(b, 1 << bit)));
  markIrqDirty(b);
};

/** 模块配置字节：把 CCAPMn 的模式位折算成运行期直接可用的位。 */
const configOf = (b: Body, module: PcaModule): Value<number> => {
  const mode = readSfr(b, module.mode);
  const enable = bitAt(b, mode, ECOMn);
  const match = bitAt(b, mode, 3);
  const toggle = bitAt(b, mode, 2);
  const pwm = bitAt(b, mode, PWMn);
  const capp = bitAt(b, mode, 5);
  const capn = bitAt(b, mode, 4);
  const one = number(b, 1);

  return b.bitOr(
    b.bitOr(
      b.multiply(b.bitAnd(enable, match), number(b, CONFIG_COMPARE)),
      b.multiply(b.bitAnd(enable, b.bitAnd(match, toggle)), number(b, CONFIG_TOGGLE)),
    ),
    b.bitOr(
      b.multiply(b.bitAnd(enable, pwm), number(b, CONFIG_PWM)),
      b.bitOr(
        b.multiply(capp, number(b, CONFIG_CAPP)),
        b.bitOr(
          b.multiply(capn, number(b, CONFIG_CAPN)),
          b.multiply(
            b.bitAnd(b.bitOr(capp, capn), b.subtract(one, b.bitAnd(enable, pwm))),
            number(b, CONFIG_CAPTURE),
          ),
        ),
      ),
    ),
  );
};

/** 模块是否把 CCPn 当输出用：ECOMn 与 PWMn，或 ECOMn 与 MATn 与 TOGn。 */
const drivesPin = (b: Body, module: PcaModule): Value<number> => {
  const mode = readSfr(b, module.mode);

  return b.bitAnd(
    bitAt(b, mode, ECOMn),
    b.bitOr(bitAt(b, mode, PWMn), b.bitAnd(bitAt(b, mode, 3), bitAt(b, mode, 2))),
  );
};

/** 模块输出电平（0/1）：PWMn=1 取 PWM 比较结果，否则取高速输出锁存。 */
const outputLevel = (b: Body, module: PcaModule): Value<number> => {
  const control = readSfr(b, module.pwm);
  const width = b.add(b.shiftLeft(bitAt(b, control, 7), number(b, 1)), bitAt(b, control, 6));
  const mask = b.index(
    b.bytes(number(b, 0xff), number(b, 0x7f), number(b, 0x3f), number(b, 0xff)),
    width,
  );
  const compare = b.add(
    b.multiply(bitAt(b, control, 0), b.add(mask, number(b, 1))),
    b.bitAnd(readSfr(b, module.low), mask),
  );
  const pwm = bitAt(b, readSfr(b, module.mode), PWMn);
  const pwmLevel = bitOf(b, b.greaterThanOrEqual(b.bitAnd(readSfr(b, SFR_CL), mask), compare));
  const toggle = bitAt(b, periph8(b, TOGGLE), module.index);

  return b.add(b.multiply(pwm, pwmLevel), b.multiply(b.subtract(number(b, 1), pwm), toggle));
};

/** 模式/复用变化后重算端口意图：把引脚交还给锁存器或交给外设。 */
const syncOutput = (b: Body, module: PcaModule): void => {
  for (const pin of module.pins) syncPin(b, pin.port, pin.bit);
};

for (const pcaModule of MODULES) {
  const byPin = new Map<string, { pin: CcpPin; groups: number[] }>();

  pcaModule.groups.forEach((pin, group) => {
    const key = `${pin.port}:${pin.bit}`;
    const entry = byPin.get(key) ?? { pin, groups: [] };

    entry.groups.push(group);
    byPin.set(key, entry);
  });

  for (const { pin, groups } of byPin.values())
    registerAlternateDriver({
      id: `pca${pcaModule.index}.${pin.port}.${pin.bit}`,
      port: pin.port,
      bit: pin.bit,
      enabled: (b) => {
        const group = switchBits(b, 5, 4);
        let selected = number(b, 0);

        for (const value of groups)
          selected = b.bitOr(selected, bitOf(b, b.equal(types.number, group, number(b, value))));

        return nonZero(b, b.bitAnd(selected, drivesPin(b, pcaModule)));
      },
      level: (b) => nonZero(b, outputLevel(b, pcaModule)),
    });
}

export function createPca(): Peripheral {
  return {
    id: 'pca',
    writes: [
      SFR_CMOD,
      SFR_CCON,
      SFR_CCAPM0,
      SFR_CCAPM1,
      SFR_CCAPM2,
      SFR_CCAP0L,
      SFR_CCAP0H,
      SFR_CCAP1L,
      SFR_CCAP1H,
      SFR_CCAP2L,
      SFR_CCAP2H,
      SFR_PCA_PWM0,
      SFR_PCA_PWM1,
      SFR_PCA_PWM2,
      SFR_P_SW1,
    ],
    onWrite(b, address) {
      if (address === SFR_CMOD) {
        const cps = b.bitOr(
          b.shiftLeft(readSfrBit(b, SFR_CMOD, 3), number(b, 2)),
          b.bitOr(
            b.shiftLeft(readSfrBit(b, SFR_CMOD, 2), number(b, 1)),
            readSfrBit(b, SFR_CMOD, 1),
          ),
        );

        setPeriph8(b, DIVISOR, b.index(b.bytes(...DIVISORS.map((value) => number(b, value))), cps));
        setPeriph16(b, SUBTICK, number(b, 0));
        setPeriph8(b, JOIN, 0);
        setPeriph8(
          b,
          CONTROL,
          b.bitOr(
            readSfrBit(b, SFR_CCON, CR),
            b.bitOr(
              b.shiftLeft(
                b.bitOr(
                  bitOf(b, b.equal(types.number, cps, number(b, 2))),
                  bitOf(b, b.equal(types.number, cps, number(b, 3))),
                ),
                number(b, 4),
              ),
              b.shiftLeft(bitOf(b, b.equal(types.number, cps, number(b, 2))), number(b, 5)),
            ),
          ),
        );
        markIrqDirty(b);

        return;
      }

      if (address === SFR_P_SW1) {
        setPeriph8(b, JOIN, 0);
        setPeriph8(b, CAPTURE, 0);
        for (const pcaModule of MODULES) syncOutput(b, pcaModule);

        return;
      }

      if (address === SFR_CCON) {
        setPeriph8(
          b,
          CONTROL,
          b.bitOr(b.bitAnd(periph8(b, CONTROL), number(b, 0xfe)), readSfrBit(b, SFR_CCON, CR)),
        );
        markIrqDirty(b);
        b.if(b.equal(types.number, readSfrBit(b, SFR_CCON, CR), number(b, 0)), (stopped) => {
          setPeriph8(asBody(stopped), CAPTURE, 0);
        });
        for (const pcaModule of MODULES) syncOutput(b, pcaModule);

        return;
      }

      for (const pcaModule of MODULES) {
        if (address === pcaModule.mode) {
          markIrqDirty(b);
          setPeriph8(b, CONFIG + pcaModule.index, configOf(b, pcaModule));
          setPeriph8(
            b,
            CAPTURE,
            b.bitAnd(periph8(b, CAPTURE), number(b, 0xff & ~(1 << (4 + pcaModule.index)))),
          );
          syncOutput(b, pcaModule);

          return;
        }

        if (address === pcaModule.low || address === pcaModule.high || address === pcaModule.pwm) {
          syncOutput(b, pcaModule);

          return;
        }
      }
    },
    /** PCA 计数器只在 CCON 有任一运行/标志位时推进。 */
    active(b) {
      return b.notEqual(types.number, periph8(b, CONTROL), number(b, 0));
    },
    advance(b, advance) {
      const control = periph8(b, CONTROL);

      b.if(nonZero(b, control), (step) => {
        const body = asBody(step);
        const one = number(body, 1);
        const zero = number(body, 0);
        const group = switchBits(body, 5, 4);

        // 采样当前复用组的三根 CCPn 与 ECI，压成一个字节供模块循环使用。
        for (const [index, pins] of GROUP_PINS.entries()) {
          body.if(body.equal(types.number, group, number(body, index)), (branch) => {
            const target = asBody(branch);
            let levels = pinLevel(target, pins[0]);

            for (let module = 1; module < 4; module += 1)
              levels = target.bitOr(
                levels,
                target.shiftLeft(pinLevel(target, pins[module]!), number(target, module)),
              );

            target.store8(PERIPH, number(target, LEVELS), levels);
          });
        }

        const total = body.add(periph16(body, SUBTICK), advance.cycles);
        const divisor = periph8(body, DIVISOR);
        const clocked = body.floor(body.divide(total, divisor));
        const edge = bitAt(body, control, 4);
        const state = periph8(body, JOIN);
        const sampled = body.select(
          types.number,
          nonZero(body, bitAt(body, control, 5)),
          (inner) => bitOf(asBody(inner), sfrBitIsSet(asBody(inner), SFR_TCON, 5)),
          (inner) =>
            bitOf(
              asBody(inner),
              asBody(inner).notEqual(
                types.number,
                asBody(inner).bitAnd(periph8(asBody(inner), LEVELS), number(asBody(inner), 0x08)),
                number(asBody(inner), 0),
              ),
            ),
        );
        const pulses = body.multiply(
          bitAt(body, state, 1),
          body.bitAnd(body.subtract(one, bitAt(body, state, 0)), sampled),
        );
        const ticks = body.add(
          body.multiply(edge, pulses),
          body.multiply(body.subtract(one, edge), clocked),
        );

        body.store16le(
          PERIPH,
          number(body, SUBTICK),
          body.subtract(total, body.multiply(clocked, divisor)),
        );
        body.store8(
          PERIPH,
          number(body, JOIN),
          body.bitOr(body.bitAnd(state, number(body, 0xfc)), body.bitOr(sampled, number(body, 2))),
        );

        body.if(nonZero(body, ticks), (stepping) => {
          const run = asBody(stepping);
          const previous = run.bitOr(
            run.shiftLeft(readSfr(run, SFR_CH), number(run, 8)),
            readSfr(run, SFR_CL),
          );
          const next = run.add(previous, ticks);
          const index = run.local(types.number, zero);
          const changed = run.local(types.number, zero);

          storeSfr(run, SFR_CL, run.bitAnd(next, number(run, 0xff)));
          storeSfr(
            run,
            SFR_CH,
            run.bitAnd(run.shiftRightUnsigned(next, number(run, 8)), number(run, 0xff)),
          );

          run.if(run.greaterThan(next, number(run, 0xffff)), (overflow) =>
            setFlag(asBody(overflow), CF),
          );

          run.while(
            (test) => test.lessThan(test.getLocal(index), number(asBody(test), 3)),
            (loop) => {
              const n = loop.getLocal(index);
              const mask = loop.shiftLeft(one, n);
              const config = loop.load8(PERIPH, loop.add(number(loop, CONFIG), n));
              const lowOffset = loop.add(number(loop, LOW_BASE), n);
              const highOffset = loop.add(number(loop, HIGH_BASE), n);
              const compare = loop.bitOr(
                loop.shiftLeft(loop.load8(SFR, highOffset), number(loop, 8)),
                loop.load8(SFR, lowOffset),
              );
              const matched = bitOf(
                loop,
                loop.lessThan(
                  loop.bitAnd(
                    loop.subtract(compare, loop.add(previous, one)),
                    number(loop, 0xffff),
                  ),
                  ticks,
                ),
              );

              loop.setLocal(index, loop.add(n, one));

              // 比较匹配 → CCFn
              loop.if(
                nonZero(
                  loop,
                  loop.multiply(matched, loop.bitAnd(config, number(loop, CONFIG_COMPARE))),
                ),
                (flagged) => {
                  const target = asBody(flagged);

                  storeSfr(target, SFR_CCON, target.bitOr(readSfr(target, SFR_CCON), mask));
                  markIrqDirty(target);
                },
              );
              // 高速输出翻转
              loop.if(
                nonZero(
                  loop,
                  loop.multiply(matched, loop.bitAnd(config, number(loop, CONFIG_TOGGLE))),
                ),
                (toggled) => {
                  const target = asBody(toggled);

                  target.store8(
                    PERIPH,
                    number(target, TOGGLE),
                    target.bitXor(periph8(target, TOGGLE), mask),
                  );
                  target.setLocal(changed, one);
                },
              );
              // PWM 相位与输出电平
              const pwmOffset = loop.add(number(loop, PWM_BASE), n);

              loop.if(
                nonZero(loop, loop.bitAnd(config, number(loop, CONFIG_PWM))),
                (modulation) => {
                  const shape = asBody(modulation);
                  const controlValue = shape.load8(SFR, pwmOffset);
                  const width = shape.add(
                    shape.shiftLeft(bitAt(shape, controlValue, 7), one),
                    bitAt(shape, controlValue, 6),
                  );
                  const pwmMask = shape.index(
                    shape.bytes(
                      number(shape, 0xff),
                      number(shape, 0x7f),
                      number(shape, 0x3f),
                      number(shape, 0xff),
                    ),
                    width,
                  );
                  const period = shape.add(pwmMask, one);
                  const phase = shape.bitAnd(previous, pwmMask);
                  const wrapped = bitOf(
                    shape,
                    shape.greaterThanOrEqual(shape.add(phase, ticks), period),
                  );
                  const compareValue = shape.add(
                    shape.multiply(bitAt(shape, controlValue, 0), period),
                    shape.bitAnd(shape.load8(SFR, lowOffset), pwmMask),
                  );
                  const rise = shape.multiply(
                    bitOf(
                      shape,
                      shape.lessThan(
                        shape.bitAnd(shape.subtract(compareValue, shape.add(phase, one)), pwmMask),
                        ticks,
                      ),
                    ),
                    bitOf(shape, shape.lessThanOrEqual(compareValue, pwmMask)),
                  );

                  shape.if(nonZero(shape, wrapped), (boundary) => {
                    const reloaded = asBody(boundary);
                    const value = reloaded.load8(SFR, pwmOffset);

                    reloaded.store8(SFR, lowOffset, reloaded.load8(SFR, highOffset));
                    reloaded.store8(
                      SFR,
                      pwmOffset,
                      reloaded.bitOr(
                        reloaded.bitAnd(value, number(reloaded, 0xfe)),
                        bitAt(reloaded, value, 1),
                      ),
                    );
                  });
                  shape.if(nonZero(shape, shape.bitOr(wrapped, rise)), (moved) => {
                    asBody(moved).setLocal(changed, one);
                  });
                },
              );
              // 捕获
              loop.if(nonZero(loop, loop.bitAnd(config, number(loop, CONFIG_CAPTURE))), (armed) => {
                const shape = asBody(armed);
                const captureState = shape.load8(PERIPH, number(shape, CAPTURE));
                const previousLevel = shape.bitAnd(shape.shiftRightUnsigned(captureState, n), one);
                const valid = shape.bitAnd(
                  shape.shiftRightUnsigned(captureState, shape.add(n, number(shape, 4))),
                  one,
                );
                const level = shape.bitAnd(
                  shape.shiftRightUnsigned(shape.load8(PERIPH, number(shape, LEVELS)), n),
                  one,
                );
                const edgeFlag = shape.add(
                  shape.multiply(
                    shape.bitAnd(shape.subtract(one, previousLevel), level),
                    bitOf(shape, nonZero(shape, shape.bitAnd(config, number(shape, CONFIG_CAPP)))),
                  ),
                  shape.multiply(
                    shape.bitAnd(previousLevel, shape.subtract(one, level)),
                    bitOf(shape, nonZero(shape, shape.bitAnd(config, number(shape, CONFIG_CAPN)))),
                  ),
                );

                shape.store8(
                  PERIPH,
                  number(shape, CAPTURE),
                  shape.bitOr(
                    shape.bitOr(
                      shape.bitAnd(
                        captureState,
                        shape.subtract(
                          number(shape, 0xff),
                          shape.bitOr(mask, shape.shiftLeft(mask, number(shape, 4))),
                        ),
                      ),
                      shape.shiftLeft(level, n),
                    ),
                    shape.shiftLeft(one, shape.add(n, number(shape, 4))),
                  ),
                );
                shape.if(nonZero(shape, shape.bitAnd(valid, edgeFlag)), (captured) => {
                  const target = asBody(captured);

                  target.store8(SFR, lowOffset, readSfr(target, SFR_CL));
                  target.store8(SFR, highOffset, readSfr(target, SFR_CH));
                  storeSfr(target, SFR_CCON, target.bitOr(readSfr(target, SFR_CCON), mask));
                  markIrqDirty(target);
                });
              });
              // 输出变化 → 直接写当前复用组的引脚意图
              loop.if(nonZero(loop, loop.getLocal(changed)), (moved) => {
                drivePins(asBody(moved), n, group);
              });
            },
          );
        });
      });
    },
    interrupts: [
      {
        id: 'pca',
        vector: IRQ_VECTORS.pca,
        query: 7,
        priority: { register: 'IP', bit: 7 },
        enabled: (b) => {
          const gated = b.bitOr(
            b.bitAnd(readSfrBit(b, SFR_CMOD, 0), readSfrBit(b, SFR_CCON, CF)),
            b.bitOr(
              b.bitAnd(readSfrBit(b, SFR_CCAPM0, 0), readSfrBit(b, SFR_CCON, CCF[0])),
              b.bitOr(
                b.bitAnd(readSfrBit(b, SFR_CCAPM1, 0), readSfrBit(b, SFR_CCON, CCF[1])),
                b.bitAnd(readSfrBit(b, SFR_CCAPM2, 0), readSfrBit(b, SFR_CCON, CCF[2])),
              ),
            ),
          );

          return nonZero(b, b.bitAnd(readSfrBit(b, SFR_IE, 7), gated));
        },
        pending: (b) =>
          nonZero(
            b,
            b.bitOr(
              b.bitOr(readSfrBit(b, SFR_CCON, CF), readSfrBit(b, SFR_CCON, CCF[1])),
              b.bitOr(readSfrBit(b, SFR_CCON, CCF[0]), readSfrBit(b, SFR_CCON, CCF[2])),
            ),
          ),
        acknowledge: (b) => {
          storeSfr(b, SFR_CCON, b.bitAnd(readSfr(b, SFR_CCON), number(b, 0x78)));
          markIrqDirty(b);
        },
      },
    ],
  };
}

/**
 * 输出变化后按 `CCP_S1:CCP_S0` 把当前模块的引脚驱动到 PWM/翻转电平。
 *
 * 这里不调用 `syncPin`：`advance` 会进入每条指令的 IR，端口模式与全部复用驱动的重算
 * 太贵；PWM/高速输出的语义就是「复用功能覆盖锁存器」，与 `registerAlternateDriver`
 * 在端口写入时给出的意图一致。
 */
function drivePins(b: Body, n: Value<number>, group: Value<number>): void {
  const controlValue = b.load8(SFR, b.add(number(b, PWM_BASE), n));
  const width = b.add(
    b.shiftLeft(bitAt(b, controlValue, 7), number(b, 1)),
    bitAt(b, controlValue, 6),
  );
  const mask = b.index(
    b.bytes(number(b, 0xff), number(b, 0x7f), number(b, 0x3f), number(b, 0xff)),
    width,
  );
  const compare = b.add(
    b.multiply(bitAt(b, controlValue, 0), b.add(mask, number(b, 1))),
    b.bitAnd(b.load8(SFR, b.add(number(b, LOW_BASE), n)), mask),
  );
  const pwmLevel = bitOf(b, b.greaterThanOrEqual(b.bitAnd(readSfr(b, SFR_CL), mask), compare));
  const config = b.load8(PERIPH, b.add(number(b, CONFIG), n));
  const pwmFlag = b.bitAnd(b.shiftRightUnsigned(config, number(b, 2)), number(b, 1));
  const toggle = b.bitAnd(b.shiftRightUnsigned(periph8(b, TOGGLE), n), number(b, 1));
  const level = b.add(
    b.multiply(pwmFlag, pwmLevel),
    b.multiply(b.subtract(number(b, 1), pwmFlag), toggle),
  );
  const intent = b.select(
    types.intent,
    nonZero(b, b.bitAnd(level, number(b, 1))),
    (inner) => inner.resistor(SUPPLY_PIN, number(asBody(inner), DRIVE_RESISTANCE)),
    (inner) => inner.resistor(GROUND_PIN, number(asBody(inner), DRIVE_RESISTANCE)),
  );

  for (let module = 0; module < 3; module += 1)
    for (let option = 0; option < 3; option += 1) {
      const pin = MODULES[module]!.groups[option]!;
      const selected = b.bitAnd(
        bitOf(b, b.equal(types.number, n, number(b, module))),
        bitOf(b, b.equal(types.number, group, number(b, option))),
      );

      b.if(nonZero(b, selected), (target) => {
        asBody(target).writeIntent(pinName(pin.port, pin.bit), intent);
      });
    }
}
