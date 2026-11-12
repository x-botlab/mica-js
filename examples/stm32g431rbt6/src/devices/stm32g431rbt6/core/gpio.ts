import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import {
  GPIO_BASE,
  GPIO_PIN_MASK,
  GPIO_POWERED,
  GPIO_STATE,
  GPIO_STATE_STRIDE,
  GPIO_SYNC,
  PERIPH,
  gpioAfr0State,
  gpioAfr1State,
  gpioModerState,
  gpioOtyperState,
  gpioPupdrState,
} from './layout';
import { PORTS, machine } from './machine';
import type { AlternateDriver, PortPins } from './machine';
import { asBody, boolAnd, boolBit, boolOr, num, readWord, readWordAt, u32, writeWord } from './ir';
import type { Body } from './ir';

/** GPIOA–GPIOF 的寄存器偏移。 */
export const GPIO_MODER = 0x00;
export const GPIO_OTYPER = 0x04;
export const GPIO_OSPEEDR = 0x08;
export const GPIO_PUPDR = 0x0c;
export const GPIO_IDR = 0x10;
export const GPIO_ODR = 0x14;
export const GPIO_BSRR = 0x18;
export const GPIO_LCKR = 0x1c;
export const GPIO_AFR0 = 0x20;
export const GPIO_AFR1 = 0x24;
export const GPIO_BRR = 0x28;

const DRIVE_RESISTANCE = 25;
const PULL_RESISTANCE = 40_000;

const stateBase = (port: number): number => GPIO_STATE + port * GPIO_STATE_STRIDE;

const loadWord = (b: Body, port: number, offset: Value<number>): Value<number> =>
  readWord(b, PERIPH, b.add(num(b, stateBase(port)), offset));

const storeWord = (b: Body, port: number, offset: Value<number>, value: Value<number>): void => {
  writeWord(b, PERIPH, b.add(num(b, stateBase(port)), offset), value);
};

const bits = (b: Body, value: Value<number>, shift: number, width: number): Value<number> =>
  b.bitAnd(b.shiftRightUnsigned(value, num(b, shift)), num(b, (1 << width) - 1));

/** 供电判定：VDD1 有确定电压且高于 1.6 V。 */
export function powered(b: Body): Value<boolean> {
  const voltage = b.field(b.readSample('VDD1'), 'voltage');
  const none = b.isNone(voltage);
  const usable = b.select(
    types.number,
    none,
    (inner) => inner.constant(types.number, 0),
    (inner) => inner.nonNull(voltage),
  );

  return b.greaterThan(usable, num(b, 1.6));
}

function pinHigh(b: Body, pin: string): Value<boolean> {
  const level = b.field(b.readSample(pin), 'level');

  return b.equal(types.logic, level, b.constant(types.logic, types.logic.members.high));
}

/** 读取端口内存在的引脚数字电平，拼成一个 16 位值。 */
function readIdr(b: Body, port: PortPins): Value<number> {
  let result: Value<number> | undefined;

  for (let bit = 0; bit < port.pins.length; bit += 1) {
    const pin = port.pins[bit];

    if (pin === undefined || pin === null) continue;
    const one = b.select(
      types.number,
      pinHigh(b, pin),
      (inner) => inner.constant(types.number, 1 << bit),
      (inner) => inner.constant(types.number, 0),
    );

    result = result === undefined ? one : b.bitOr(result, one);
  }

  return result ?? num(b, 0);
}

function extract(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const mask = size === 2 ? 0xffff : 0xff;

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, mask));
}

/** 一次端口同步共用的寄存器快照：6 个字 + 电源判定。 */
interface PortRegisters {
  readonly moder: Value<number>;
  readonly otyper: Value<number>;
  readonly pupdr: Value<number>;
  readonly odr: Value<number>;
  readonly afr0: Value<number>;
  readonly afr1: Value<number>;
  readonly supplied: Value<boolean>;
}

/** 读一次端口配置；16 根脚复用同一份快照，避免每根脚重读 6 个字。 */
function portRegisters(b: Body, portIndex: number): PortRegisters {
  return {
    moder: b.readState(gpioModerState(portIndex), types.number),
    otyper: b.readState(gpioOtyperState(portIndex), types.number),
    pupdr: b.readState(gpioPupdrState(portIndex), types.number),
    odr: readWordAt(b, PERIPH, stateBase(portIndex) + GPIO_ODR),
    afr0: b.readState(gpioAfr0State(portIndex), types.number),
    afr1: b.readState(gpioAfr1State(portIndex), types.number),
    supplied: powered(b),
  };
}

/**
 * 一根脚在给定电阻下的意图。意图只在所在分支真正被选中时才求值：一次 GPIO 输出写只需要
 * 一个电阻意图，不必把上拉/下拉/空意图也解析一遍。
 */
const resistorIntent = (b: Body, high: boolean, resistance: number): Value<IntentValue> =>
  b.resistor(high ? 'VDD1' : 'VSS1', num(b, resistance));

/** 把一根脚的 MODER/OTYPER/PUPDR/ODR/AFR 翻译成引脚意图。 */
function emitPinIntent(b: Body, portIndex: number, bit: number, registers: PortRegisters): void {
  const pin = PORTS[portIndex]?.pins[bit];

  if (pin === undefined || pin === null) return;

  const { moder, otyper, pupdr, odr, afr0, afr1, supplied: poweredPin } = registers;
  const mode = bits(b, moder, bit * 2, 2);
  const openDrain = bits(b, otyper, bit, 1);
  const pull = bits(b, pupdr, bit * 2, 2);
  const output = bits(b, odr, bit, 1);
  const af = b.bitAnd(
    b.shiftRightUnsigned(bit < 8 ? afr0 : afr1, num(b, (bit & 7) * 4)),
    num(b, 0xf),
  );
  const outputHigh = b.equal(types.number, output, num(b, 1));
  const pullIsUp = b.equal(types.number, pull, num(b, 1));
  const pullIsDown = b.equal(types.number, pull, num(b, 2));

  const pullAt = (body: Body): Value<IntentValue> =>
    body.select(
      types.intent,
      pullIsUp,
      (up) => resistorIntent(asBody(up), true, PULL_RESISTANCE),
      (other) =>
        other.select(
          types.intent,
          pullIsDown,
          (down) => resistorIntent(asBody(down), false, PULL_RESISTANCE),
          (none) => asBody(none).combineIntents(),
        ),
    );
  const driveAt = (body: Body): Value<IntentValue> =>
    body.select(
      types.intent,
      outputHigh,
      (high) => resistorIntent(asBody(high), true, DRIVE_RESISTANCE),
      (low) => resistorIntent(asBody(low), false, DRIVE_RESISTANCE),
    );
  const outputAt = (body: Body): Value<IntentValue> =>
    body.select(
      types.intent,
      body.equal(types.number, openDrain, num(body, 1)),
      (open) =>
        asBody(open).select(
          types.intent,
          outputHigh,
          (high) => pullAt(asBody(high)),
          (low) => resistorIntent(asBody(low), false, DRIVE_RESISTANCE),
        ),
      (push) => driveAt(asBody(push)),
    );
  const alternateAt = (body: Body): Value<IntentValue> => {
    let intent = pullAt(body);

    for (const driver of driversFor(portIndex, bit)) {
      const selected = boolAnd(
        body,
        body.equal(types.number, af, num(body, driver.af)),
        driver.active(body),
      );

      intent = body.select(
        types.intent,
        selected,
        (level) => {
          const inner = asBody(level);

          return inner.select(
            types.intent,
            driver.level(inner),
            (high) => resistorIntent(asBody(high), true, DRIVE_RESISTANCE),
            (low) => resistorIntent(asBody(low), false, DRIVE_RESISTANCE),
          );
        },
        () => intent,
      );
    }

    return intent;
  };
  const modeIntent = b.select(
    types.intent,
    b.equal(types.number, mode, num(b, 0)),
    (input) => pullAt(asBody(input)),
    (inner) =>
      inner.select(
        types.intent,
        inner.equal(types.number, mode, inner.constant(types.number, 1)),
        (out) => outputAt(asBody(out)),
        (inner2) =>
          inner2.select(
            types.intent,
            inner2.equal(types.number, mode, inner2.constant(types.number, 2)),
            (alt) => alternateAt(asBody(alt)),
            (none) => asBody(none).combineIntents(),
          ),
      ),
  );
  const intent = b.select(
    types.intent,
    poweredPin,
    () => modeIntent,
    (none) => asBody(none).combineIntents(),
  );

  b.writeIntent(pin, intent);
}

function driversFor(port: number, bit: number): readonly AlternateDriver[] {
  return machine().alternateDrivers.filter((driver) => driver.port === port && driver.pin === bit);
}

/**
 * 刷新一个端口里 `mask` 选中的引脚意图：配置寄存器只读一次。
 *
 * 只有引脚自己的寄存器位、或端口供电状态变化才会改变它的意图，因此按位刷新与整端口
 * 刷新等价；供电状态变化时退回整端口。
 */
export function syncPort(b: Body, portIndex: number, mask: Value<number>): void {
  const port = PORTS[portIndex];

  if (port === undefined) return;

  const registers = portRegisters(b, portIndex);
  const poweredBefore = b.readState(GPIO_POWERED, types.bool);
  const refresh = b.select(
    types.number,
    b.notEqual(types.bool, poweredBefore, registers.supplied),
    (inner) => num(asBody(inner), 0xffff),
    () => mask,
  );

  b.writeState(GPIO_POWERED, registers.supplied);

  for (let bit = 0; bit < port.pins.length; bit += 1) {
    if (port.pins[bit] === null) continue;
    b.if(boolBit(b, refresh, 1 << bit), (pin) => {
      emitPinIntent(asBody(pin), portIndex, bit, registers);
    });
  }
}

/** 翻译单根引脚的意图；外设输出变化时只刷新相关引脚。 */
export function syncPin(b: Body, portIndex: number, bit: number): void {
  const pin = PORTS[portIndex]?.pins[bit];

  if (pin === undefined || pin === null) return;

  emitPinIntent(b, portIndex, bit, portRegisters(b, portIndex));
}

function isWriteOnly(b: Body, wordOffset: Value<number>): Value<boolean> {
  return boolOr(
    b,
    b.equal(types.number, wordOffset, num(b, GPIO_BSRR)),
    b.equal(types.number, wordOffset, num(b, GPIO_BRR)),
  );
}

function readRegister(
  b: Body,
  portIndex: number,
  offset: Value<number>,
  size: number,
): Value<number> {
  const port = PORTS[portIndex];

  if (port === undefined) return num(b, 0);

  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, GPIO_IDR)),
    (idr) => {
      idr.setLocal(result, readIdr(asBody(idr), port));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        isWriteOnly(body, wordOffset),
        (zero) => zero.setLocal(result, num(zero, 0)),
        (stored) => stored.setLocal(result, loadWord(asBody(stored), portIndex, wordOffset)),
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

function mergeWord(
  b: Body,
  current: Value<number>,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return u32(b, value);

  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));
  const placed = b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}

function writeRegister(
  b: Body,
  portIndex: number,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  if (PORTS[portIndex] === undefined) return;

  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const output = isOutputWrite(b, wordOffset);
  /** 需要重算意图的引脚；配置写默认整端口，输出写按位算出。 */
  const changed = b.local(types.number, num(b, 0xffff));

  // ODR / BSRR / BRR 都只改 ODR。
  b.if(
    output,
    (hit) => {
      const body = asBody(hit);

      body.if(
        body.equal(types.number, wordOffset, num(body, GPIO_BSRR)),
        (bsrr) => {
          const scope = asBody(bsrr);
          const current = loadWord(scope, portIndex, num(scope, GPIO_ODR));
          const setBits = scope.bitAnd(u32(scope, value), num(scope, 0xffff));
          const clearBits = scope.shiftRightUnsigned(u32(scope, value), num(scope, 16));

          scope.setLocal(changed, scope.bitOr(setBits, clearBits));
          storeWord(
            scope,
            portIndex,
            num(scope, GPIO_ODR),
            scope.bitOr(scope.bitAnd(current, scope.bitNot(clearBits)), setBits),
          );
        },
        (other) => {
          const scope = asBody(other);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, GPIO_BRR)),
            (brr) => {
              const last = asBody(brr);
              const current = loadWord(last, portIndex, num(last, GPIO_ODR));
              const clearBits = last.bitAnd(u32(last, value), num(last, 0xffff));

              last.setLocal(changed, clearBits);
              storeWord(
                last,
                portIndex,
                num(last, GPIO_ODR),
                last.bitAnd(current, last.bitNot(clearBits)),
              );
            },
            (plain) => {
              const last = asBody(plain);
              const current = loadWord(last, portIndex, num(last, GPIO_ODR));
              const next = mergeWord(last, current, value, offset, size);

              last.setLocal(changed, last.bitAnd(last.bitXor(current, next), num(last, 0xffff)));
              storeWord(last, portIndex, num(last, GPIO_ODR), next);
            },
          );
        },
      );
    },
    (rest) => {
      const body = asBody(rest);

      body.if(
        body.equal(types.number, wordOffset, num(body, GPIO_IDR)),
        () => {},
        (stored) => {
          const body2 = asBody(stored);
          const merged = mergeWord(
            body2,
            loadWord(body2, portIndex, wordOffset),
            value,
            offset,
            size,
          );

          storeWord(body2, portIndex, wordOffset, merged);
          // 引脚意图读的是影子 state，这里写穿：存储器仍是固件可见的寄存器映像。
          for (const [offsetOf, stateOf] of [
            [GPIO_MODER, gpioModerState],
            [GPIO_OTYPER, gpioOtyperState],
            [GPIO_PUPDR, gpioPupdrState],
            [GPIO_AFR0, gpioAfr0State],
            [GPIO_AFR1, gpioAfr1State],
          ] as const)
            body2.if(body2.equal(types.number, wordOffset, num(body2, offsetOf)), (hit) =>
              asBody(hit).writeState(stateOf(portIndex), merged),
            );
        },
      );
    },
  );

  // 输出寄存器与模式/上下拉/复用功能寄存器会改变引脚意图。引脚同步（16 根脚的
  // intent 树）体积很大，会让整段直接程序超出 V8 的优化范围，因此这里只登记待同步的
  // 端口与引脚位，由服务块在这个块结束时统一刷新。
  b.if(boolOr(b, output, isConfigWrite(b, wordOffset)), (sync) => {
    const scope = asBody(sync);

    scope.writeState(
      GPIO_SYNC,
      scope.bitOr(scope.readState(GPIO_SYNC, types.number), num(scope, 1 << portIndex)),
    );
    scope.writeState(GPIO_PIN_MASK, scope.getLocal(changed));
  });
}

function isOutputWrite(b: Body, wordOffset: Value<number>): Value<boolean> {
  return boolOr(
    b,
    b.equal(types.number, wordOffset, num(b, GPIO_ODR)),
    boolOr(
      b,
      b.equal(types.number, wordOffset, num(b, GPIO_BSRR)),
      b.equal(types.number, wordOffset, num(b, GPIO_BRR)),
    ),
  );
}

function isConfigWrite(b: Body, wordOffset: Value<number>): Value<boolean> {
  let matched: Value<boolean> | undefined;

  for (const offset of [GPIO_MODER, GPIO_OTYPER, GPIO_PUPDR, GPIO_AFR0, GPIO_AFR1]) {
    const check = b.equal(types.number, wordOffset, num(b, offset));

    matched = matched === undefined ? check : boolOr(b, matched, check);
  }

  return matched!;
}

/** 地址落在 GPIO 区间时取端口号（0–4）。 */
function gpioPortIndex(b: Body, address: Value<number>): Value<number> {
  return b.shiftRightUnsigned(b.subtract(address, num(b, GPIO_BASE)), num(b, 10));
}

function selectPort(
  b: Body,
  portValue: Value<number>,
  index: number,
  emit: (body: Body, port: number) => void,
): void {
  const port = PORTS[index];

  if (port === undefined) return;

  b.if(
    b.equal(types.number, portValue, num(b, index)),
    (inner) => emit(asBody(inner), index),
    (next) => selectPort(asBody(next), portValue, index + 1, emit),
  );
}

export function readGpio(b: Body, address: Value<number>, size: number): Value<number> {
  const portValue = gpioPortIndex(b, address);
  const offset = b.bitAnd(b.subtract(address, num(b, GPIO_BASE)), num(b, 0x3ff));
  const result = b.local(types.number, 0);

  selectPort(b, portValue, 0, (body, port) => {
    body.setLocal(result, readRegister(body, port, offset, size));
  });

  return b.getLocal(result);
}

/** 端口号：地址落在 GPIO 区间时取 `(address - GPIO_BASE) >> 10`。 */
export const gpioPortOf = (b: Body, address: Value<number>): Value<number> =>
  gpioPortIndex(b, address);

/** 端口内偏移：`(address - GPIO_BASE) & 0x3FF`。 */
export const gpioOffsetOf = (b: Body, address: Value<number>): Value<number> =>
  b.bitAnd(b.subtract(address, num(b, GPIO_BASE)), num(b, 0x3ff));

/** 写单个端口：服务块按端口分别生成时使用（端口是编译期常量）。 */
export function writeGpioPort(
  b: Body,
  port: number,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRegister(b, port, offset, size, value);
}

export { DRIVE_RESISTANCE, PULL_RESISTANCE };
