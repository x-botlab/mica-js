import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
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

/**
 * 把口锁存器、口模式与复用功能翻译成引脚意图。
 *
 * - 准双向（00）：锁存 0 强下拉，锁存 1 释放（不建模弱上拉）；
 * - 推挽（01）：按锁存位推挽到 VCC 或 GND；
 * - 仅输入（10）：始终释放；
 * - 开漏（11）：锁存 0 下拉，锁存 1 释放。
 *
 * 复用功能启用时由外设推挽驱动该脚，锁存器与口模式不再影响输出。
 */
export function syncPin(b: Body, port: number, bit: number): void {
  const descriptor = PORTS[port];

  if (descriptor === undefined) return;

  const latchBit = b.equal(types.number, readSfrBit(b, descriptor.latch, bit), number(b, 1));
  const mode = b.bitOr(
    b.shiftLeft(readSfrBit(b, descriptor.mode1, bit), number(b, 1)),
    readSfrBit(b, descriptor.mode0, bit),
  );
  const pushPull = b.equal(types.number, mode, number(b, 1));
  const inputOnly = b.equal(types.number, mode, number(b, 2));
  const released = b.not(latchBit);
  const driveHigh = b.and(pushPull, () => latchBit);
  const driveLow = b.and(b.not(inputOnly), () => released);
  const high = b.resistor(SUPPLY_PIN, number(b, DRIVE_RESISTANCE));
  const low = b.resistor(GROUND_PIN, number(b, DRIVE_RESISTANCE));
  const idle = b.combineIntents();
  const lowOrIdle = b.select(
    types.intent,
    driveLow,
    () => low,
    () => idle,
  );
  const portIntent = b.select(
    types.intent,
    driveHigh,
    () => high,
    () => lowOrIdle,
  );

  let intent = portIntent;

  for (const driver of driversFor(port, bit)) {
    const active = b.and(driver.enabled(b), (inner) => asBody(inner).not(inputOnly));

    intent = b.select(
      types.intent,
      active,
      (inner) =>
        inner.select(
          types.intent,
          driver.level(asBody(inner)),
          () => high,
          () => low,
        ),
      () => intent,
    );
  }

  b.writeIntent(pinName(port, bit), intent);
}

export function syncPort(b: Body, port: number): void {
  for (let bit = 0; bit < 8; bit += 1) syncPin(b, port, bit);
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
