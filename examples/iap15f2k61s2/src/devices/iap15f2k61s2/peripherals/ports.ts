import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import {
  SFR_P0,
  SFR_P0M0,
  SFR_P0M1,
  SFR_P1,
  SFR_P1M0,
  SFR_P1M1,
  SFR_P2,
  SFR_P2M0,
  SFR_P2M1,
  SFR_P3,
  SFR_P3M0,
  SFR_P3M1,
  SFR_P_SW1,
  asBody,
  boolean,
  number,
  readSfrBit,
  readSfrLatch,
  sfrBitIsSet,
} from '../kernel/ir';
import type { Body } from '../kernel/ir';
import type { Peripheral } from './types';

/**
 * P0–P3 的端口结构与复用功能。
 *
 * 引脚意图按「准双向 / 推挽 / 仅输入 / 开漏」四种口模式生成；外设复用输出（UART 的
 * TXD、PCA 的 PWM/高速输出、SPI 的时钟与 MOSI、定时器时钟输出）在启用时覆盖锁存器，
 * 与手册的「复用功能优先」一致。读口返回引脚电平，读-改-写指令读锁存器（由内核区分）。
 */

export interface Port {
  readonly index: number;
  readonly latch: number;
  readonly mode0: number;
  readonly mode1: number;
}

/** P0–P3 的锁存器与口模式寄存器。模式位序是 `PxM1:PxM0`。 */
export const PORTS: readonly Port[] = [
  { index: 0, latch: SFR_P0, mode0: SFR_P0M0, mode1: SFR_P0M1 },
  { index: 1, latch: SFR_P1, mode0: SFR_P1M0, mode1: SFR_P1M1 },
  { index: 2, latch: SFR_P2, mode0: SFR_P2M0, mode1: SFR_P2M1 },
  { index: 3, latch: SFR_P3, mode0: SFR_P3M0, mode1: SFR_P3M1 },
];

const PORT_BY_CONTROL = new Map<number, Port>(
  PORTS.flatMap((port) => [
    [port.latch, port],
    [port.mode0, port],
    [port.mode1, port],
  ]) as [number, Port][],
);

/** 推挽驱动的等效支路电阻：25 Ω 与 100 Ω 负载串在 5 V 上仍能给出接近满量程的电流。 */
export const DRIVE_RESISTANCE = 25;
export const SUPPLY_PIN = 'VCC';
export const GROUND_PIN = 'GND';

export const pinName = (port: number, bit: number): string => `P${port}_${bit}`;

/**
 * 复用功能输出。
 *
 * `enabled` 与 `level` 都在翻译期生成 IR：启用条件通常读 P_SW1/P_SW2 的复用位，
 * 输出电平来自对应外设的状态。同一引脚只应有一个复用功能处于启用状态。
 */
export interface AlternateDriver {
  readonly id: string;
  readonly port: number;
  readonly bit: number;
  readonly enabled: (b: Body) => Value<boolean>;
  readonly level: (b: Body) => Value<boolean>;
}

const drivers: AlternateDriver[] = [];

export function registerAlternateDriver(driver: AlternateDriver): void {
  drivers.push(driver);
}

function driversFor(port: number, bit: number): readonly AlternateDriver[] {
  return drivers.filter((driver) => driver.port === port && driver.bit === bit);
}

/** 一根口线的逻辑电平：阈值判定为 high 记 1，其余（含浮空）记 0。 */
function readPinBit(b: Body, port: number, bit: number): Value<number> {
  const level = b.field(b.readSample(pinName(port, bit)), 'level');
  const high = b.equal(types.logic, level, b.constant(types.logic, types.logic.members.high));
  const one = b.constant(types.number, 1);
  const zero = b.constant(types.number, 0);

  return b.shiftLeft(
    b.select(
      types.number,
      high,
      () => one,
      () => zero,
    ),
    number(b, bit),
  );
}

/** 读口：8 根引脚电平拼成一个字节（P0 → bit0…bit7）。 */
export function readPort(b: Body, port: number): Value<number> {
  let value = readPinBit(b, port, 0);

  for (let bit = 1; bit < 8; bit += 1) value = b.bitOr(value, readPinBit(b, port, bit));

  return value;
}

/** 位测试只采一根脚：`JNB P3.2,$` 这类轮询不必读整个口。 */
export function readPin(b: Body, port: number, bit: number): Value<number> {
  const level = b.field(b.readSample(pinName(port, bit)), 'level');
  const high = b.equal(types.logic, level, b.constant(types.logic, types.logic.members.high));

  return b.select(
    types.number,
    high,
    (inner) => inner.constant(types.number, 1),
    (inner) => inner.constant(types.number, 0),
  );
}

/** 一次端口写入里所有引脚共用的取值与常量。 */
interface PinContext {
  readonly latch: Value<number>;
  readonly mode0: Value<number>;
  readonly mode1: Value<number>;
  readonly high: Value<IntentValue>;
  readonly low: Value<IntentValue>;
  readonly idle: Value<IntentValue>;
  readonly zero: Value<number>;
  readonly masks: (Value<number> | undefined)[];
}

function pinContext(b: Body, descriptor: Port): PinContext {
  return {
    latch: readSfrLatch(b, descriptor.latch),
    mode0: readSfrLatch(b, descriptor.mode0),
    mode1: readSfrLatch(b, descriptor.mode1),
    high: b.resistor(SUPPLY_PIN, number(b, DRIVE_RESISTANCE)),
    low: b.resistor(GROUND_PIN, number(b, DRIVE_RESISTANCE)),
    idle: b.combineIntents(),
    zero: number(b, 0),
    masks: [],
  };
}

function maskOf(b: Body, context: PinContext, bit: number): Value<number> {
  let mask = context.masks[bit];

  if (mask === undefined) {
    mask = number(b, 1 << bit);
    context.masks[bit] = mask;
  }

  return mask;
}

/**
 * 把口锁存器、口模式与复用功能翻译成引脚意图。
 *
 * - 准双向（00）：锁存 0 强下拉，锁存 1 释放（不建模弱上拉）；
 * - 推挽（01）：按锁存位推挽到 VCC 或 GND；
 * - 仅输入（10）：始终释放；
 * - 开漏（11）：锁存 0 下拉，锁存 1 释放。
 *
 * 复用功能启用时由外设推挽驱动该脚，锁存器与口模式不再影响输出。
 *
 * 每个引脚只做位掩码运算：`highCode`/`lowCode` 为 0 表示该脚不驱动。这样同一口写块
 * 里 8 个引脚共用锁存/模式读取、两个电阻意图与空意图，常量也由内核按执行体去重。
 */
function syncPinWith(b: Body, port: number, bit: number, context: PinContext): void {
  const mask = maskOf(b, context, bit);
  const latchBit = b.bitAnd(context.latch, mask);
  const mode0Bit = b.bitAnd(context.mode0, mask);
  const mode1Bit = b.bitAnd(context.mode1, mask);
  const highCode = b.bitAnd(b.bitAnd(latchBit, mode0Bit), b.bitXor(mode1Bit, mask));
  const lowCode = b.bitAnd(b.bitXor(latchBit, mask), b.bitOr(b.bitXor(mode1Bit, mask), mode0Bit));
  const pin = pinName(port, bit);
  const drivesHigh = b.notEqual(types.number, highCode, context.zero);
  const drivesLow = b.notEqual(types.number, lowCode, context.zero);
  let intent = b.select(
    types.intent,
    drivesHigh,
    () => context.high,
    (rest) =>
      rest.select(
        types.intent,
        drivesLow,
        () => context.low,
        () => context.idle,
      ),
  );

  const drivers = driversFor(port, bit);

  if (drivers.length > 0) {
    const notInputOnly = b.not(
      b.notEqual(types.number, b.bitAnd(mode1Bit, b.bitXor(mode0Bit, mask)), context.zero),
    );

    for (const driver of drivers) {
      const active = b.and(driver.enabled(b), () => notInputOnly);

      intent = b.select(
        types.intent,
        active,
        (on) => {
          const body = asBody(on);

          return body.select(
            types.intent,
            driver.level(body),
            () => context.high,
            () => context.low,
          );
        },
        () => intent,
      );
    }
  }

  b.writeIntent(pin, intent);
}

export function syncPin(b: Body, port: number, bit: number): void {
  const descriptor = PORTS[port];

  if (descriptor === undefined) return;

  syncPinWith(b, port, bit, pinContext(b, descriptor));
}

export function syncPort(b: Body, port: number): void {
  const descriptor = PORTS[port];

  if (descriptor === undefined) return;

  const context = pinContext(b, descriptor);

  for (let bit = 0; bit < 8; bit += 1) syncPinWith(b, port, bit, context);
}

export const ports: Peripheral = {
  id: 'ports',
  writes: PORTS.flatMap((port) => [port.latch, port.mode0, port.mode1]),
  onWrite(b, address) {
    const port = PORT_BY_CONTROL.get(address);

    if (port !== undefined) syncPort(b, port.index);
  },
  advance() {
    // 端口本身没有内部时钟；电平变化由外设输出与锁存器写入触发。
  },
};

/** P_SW1 的复用位；供外设判断功能映射位置。 */
export function switchBits(b: Body, highBit: number, lowBit: number): Value<number> {
  const high = readSfrBit(b, SFR_P_SW1, highBit);
  const low = readSfrBit(b, SFR_P_SW1, lowBit);

  return b.bitOr(b.shiftLeft(high, number(b, 1)), low);
}

export const always = (b: Body): Value<boolean> => boolean(b, true);
export const latchIsHigh = (b: Body, address: number, bit: number): Value<boolean> =>
  sfrBitIsSet(b, address, bit);
export const latchValue = (b: Body, address: number): Value<number> => readSfrLatch(b, address);
