import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import {
  DEFER_READ,
  DEFER_READ_OFFSET,
  DEFER_READ_PORT,
  DEFER_READ_SIGNED,
  DEFER_READ_SIZE,
  DEFER_READ_TARGET,
  GPIO_BASE,
  GPIO_POWERED,
  GPIO_STATE,
  GPIO_STATE_STRIDE,
  PERIPH,
  SERVICE_DEFER_READ,
  gpioAfr0State,
  gpioAfr1State,
  gpioModerState,
  gpioOtyperState,
  gpioPupdrState,
} from './layout';
import { PORTS, machine } from './machine';
import type { AlternateDriver, PortPins } from './machine';
import {
  asBody,
  bool,
  boolAnd,
  boolBit,
  boolOr,
  markService,
  maskWidth,
  num,
  readWord,
  readWordAt,
  signExtendDynamic,
  u32,
  writeWord,
} from './ir';
import type { Body } from './ir';
import type { DeferRead } from './memory';

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

/** 端口同步只看低 16 位引脚变化。 */
const GPIO_PIN_MASK_PINS = 0xffff;

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
 * 刷新一个端口里 `mask` 选中的引脚意图。
 *
 * `mask` 的低 16 位是真正变化的引脚。只有引脚自己的寄存器位、或端口供电状态变化
 * 才会改变它的意图；供电变化时退回整端口完整刷新。
 */
export function syncPort(b: Body, portIndex: number, mask: Value<number>): void {
  const port = PORTS[portIndex];

  if (port === undefined) return;

  const registers = portRegisters(b, portIndex);
  const poweredBefore = b.readState(GPIO_POWERED, types.bool);
  const powerChanged = b.notEqual(types.bool, poweredBefore, registers.supplied);
  const refresh = b.select(
    types.number,
    powerChanged,
    (inner) => num(asBody(inner), GPIO_PIN_MASK_PINS),
    (inner) => inner.bitAnd(mask, num(asBody(inner), GPIO_PIN_MASK_PINS)),
  );

  // 电源状态只在变化时写回。稳态的每次输出写都重复写同一个 true 会额外触发状态
  // 写屏障和依赖失效；读取保留，外部掉电仍会在下一次 GPIO 同步被观察到。
  b.if(powerChanged, (changed) => {
    asBody(changed).writeState(GPIO_POWERED, registers.supplied);
  });

  // 四位一组先筛掉整组，组内再逐位判断。常见的单引脚输出写在 4 次组判断加至多
  // 4 次位判断内完成，且每根引脚的意图树仍只发射一次。
  for (let group = 0; group < port.pins.length; group += 4) {
    const groupMask = 0xf << group;

    b.if(boolBit(b, refresh, groupMask), (selected) => {
      const scope = asBody(selected);

      for (let bit = group; bit < group + 4; bit += 1) {
        if (port.pins[bit] === null) continue;
        scope.if(boolBit(scope, refresh, 1 << bit), (pin) => {
          emitPinIntent(asBody(pin), portIndex, bit, registers);
        });
      }
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
  defer?: DeferRead,
): Value<number> {
  const port = PORTS[portIndex];

  if (port === undefined) return num(b, 0);

  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, GPIO_IDR)),
    (idr) => {
      if (defer === undefined) {
        idr.setLocal(result, readIdr(asBody(idr), port));

        return;
      }

      // 逐脚组包树只属于服务块：指令块只记下目标寄存器与访问形状，值稍后写回。
      const scope = asBody(idr);

      scope.writeState(DEFER_READ, bool(scope, true));
      scope.writeState(DEFER_READ_PORT, num(scope, portIndex));
      scope.writeState(DEFER_READ_OFFSET, offset);
      scope.writeState(DEFER_READ_TARGET, num(scope, defer.target));
      scope.writeState(DEFER_READ_SIZE, num(scope, size));
      scope.writeState(DEFER_READ_SIGNED, bool(scope, defer.signed));
      markService(scope, SERVICE_DEFER_READ);
      idr.setLocal(result, num(scope, 0));
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

/** 将窄写放在目标寄存器内的正确字节位置；配置映射与 BSRR/BRR 共用。 */
function placeWord(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return u32(b, value);

  const width = size === 2 ? 0xffff : 0xff;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.shiftLeft(b.bitAnd(u32(b, value), num(b, width)), shift);
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
  const placed = placeWord(b, value, offset, size);
  const mask = b.shiftLeft(num(b, width), shift);

  return u32(b, b.bitOr(b.bitAnd(current, b.bitNot(mask)), placed));
}

/**
 * MODER/PUPDR 的差值是每脚 2 位。先算“字段内至少一位变化”，再用并行移位把 16 个
 * even-bit 标志压到低 16 位，避免逐脚生成比较与 select。
 */
function changedPairPins(b: Body, diff: Value<number>): Value<number> {
  const paired = b.bitAnd(b.bitOr(diff, b.shiftRightUnsigned(diff, num(b, 1))), num(b, 0x55555555));
  const twoPerNibble = b.bitOr(
    b.bitAnd(paired, num(b, 0x11111111)),
    b.bitAnd(b.shiftRightUnsigned(paired, num(b, 1)), num(b, 0x22222222)),
  );
  const fourPerByte = b.bitOr(
    b.bitAnd(twoPerNibble, num(b, 0x03030303)),
    b.bitAnd(b.shiftRightUnsigned(twoPerNibble, num(b, 2)), num(b, 0x0c0c0c0c)),
  );
  const eightPerHalf = b.bitOr(
    b.bitAnd(fourPerByte, num(b, 0x000f000f)),
    b.bitAnd(b.shiftRightUnsigned(fourPerByte, num(b, 4)), num(b, 0x00f000f0)),
  );

  return b.bitAnd(
    b.bitOr(
      b.bitAnd(eightPerHalf, num(b, 0xffff)),
      b.bitAnd(b.shiftRightUnsigned(eightPerHalf, num(b, 8)), num(b, 0xff00)),
    ),
    num(b, 0xffff),
  );
}

/** AFR0/AFR1 每脚 4 位；把 8 个 nibble 标志压到低 8 位，再放到对应端口位。 */
function changedNibblePins(b: Body, diff: Value<number>, firstPin: number): Value<number> {
  const any = b.bitOr(
    diff,
    b.bitOr(
      b.shiftRightUnsigned(diff, num(b, 1)),
      b.bitOr(b.shiftRightUnsigned(diff, num(b, 2)), b.shiftRightUnsigned(diff, num(b, 3))),
    ),
  );
  const nibbleLsb = b.bitAnd(any, num(b, 0x11111111));
  const twoPerByte = b.bitOr(
    b.bitAnd(nibbleLsb, num(b, 0x11111111)),
    b.bitAnd(b.shiftRightUnsigned(nibbleLsb, num(b, 3)), num(b, 0x22222222)),
  );
  const fourPerHalf = b.bitOr(
    b.bitAnd(twoPerByte, num(b, 0x00030003)),
    b.bitAnd(b.shiftRightUnsigned(twoPerByte, num(b, 6)), num(b, 0x000c000c)),
  );
  const packed = b.bitAnd(
    b.bitOr(
      b.bitAnd(fourPerHalf, num(b, 0x0000000f)),
      b.bitAnd(b.shiftRightUnsigned(fourPerHalf, num(b, 12)), num(b, 0x000000f0)),
    ),
    num(b, 0xff),
  );

  return firstPin === 0 ? packed : b.shiftLeft(packed, num(b, firstPin));
}

function writeRegister(
  b: Body,
  portIndex: number,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): Value<number> {
  if (PORTS[portIndex] === undefined) return num(b, 0);

  const wordOffset = b.bitAnd(offset, num(b, 0x3c));
  const output = isOutputWrite(b, wordOffset);
  /** 真正需要重算意图的引脚；输出写按 ODR 前后差值，配置写按字段差值计算。 */
  const changed = b.local(types.number, num(b, 0));

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
          const placed = placeWord(scope, value, offset, size);
          const setBits = scope.bitAnd(placed, num(scope, 0xffff));
          const clearBits = scope.bitAnd(
            scope.shiftRightUnsigned(placed, num(scope, 16)),
            num(scope, 0xffff),
          );
          // 同一位同时 set/reset 时 set 优先，与 STM32 BSRR 的约定一致。
          const next = scope.bitOr(scope.bitAnd(current, scope.bitNot(clearBits)), setBits);

          scope.setLocal(changed, scope.bitAnd(scope.bitXor(current, next), num(scope, 0xffff)));
          storeWord(scope, portIndex, num(scope, GPIO_ODR), next);
        },
        (other) => {
          const scope = asBody(other);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, GPIO_BRR)),
            (brr) => {
              const last = asBody(brr);
              const current = loadWord(last, portIndex, num(last, GPIO_ODR));
              const clearBits = last.bitAnd(
                placeWord(last, value, offset, size),
                num(last, 0xffff),
              );
              const next = last.bitAnd(current, last.bitNot(clearBits));

              last.setLocal(changed, last.bitAnd(last.bitXor(current, next), num(last, 0xffff)));
              storeWord(last, portIndex, num(last, GPIO_ODR), next);
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
          const current = loadWord(body2, portIndex, wordOffset);
          const merged = mergeWord(body2, current, value, offset, size);
          const diff = body2.bitXor(current, merged);

          storeWord(body2, portIndex, wordOffset, merged);
          // 引脚意图读的是影子 state，这里写穿：存储器仍是固件可见的寄存器映像。
          for (const [offsetOf, stateOf] of [
            [GPIO_MODER, gpioModerState],
            [GPIO_OTYPER, gpioOtyperState],
            [GPIO_PUPDR, gpioPupdrState],
            [GPIO_AFR0, gpioAfr0State],
            [GPIO_AFR1, gpioAfr1State],
          ] as const)
            body2.if(body2.equal(types.number, wordOffset, num(body2, offsetOf)), (hit) => {
              const scope = asBody(hit);

              scope.writeState(stateOf(portIndex), merged);

              if (offsetOf === GPIO_OTYPER)
                scope.setLocal(changed, scope.bitAnd(diff, num(scope, 0xffff)));
              else if (offsetOf === GPIO_MODER || offsetOf === GPIO_PUPDR)
                scope.setLocal(changed, changedPairPins(scope, diff));
              else if (offsetOf === GPIO_AFR0)
                scope.setLocal(changed, changedNibblePins(scope, diff, 0));
              else scope.setLocal(changed, changedNibblePins(scope, diff, 8));
            });
        },
      );
    },
  );

  // 服务块立即消费这个精确掩码，不再经过 GPIO_SYNC/GPIO_PIN_MASK 的写回与读回。
  return b.getLocal(changed);
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

export function readGpio(
  b: Body,
  address: Value<number>,
  size: number,
  defer?: DeferRead,
): Value<number> {
  const portValue = gpioPortIndex(b, address);
  const offset = b.bitAnd(b.subtract(address, num(b, GPIO_BASE)), num(b, 0x3ff));
  const result = b.local(types.number, 0);

  selectPort(b, portValue, 0, (body, port) => {
    body.setLocal(result, readRegister(body, port, offset, size, defer));
  });

  return b.getLocal(result);
}

/**
 * 服务块用：按延迟读记录拼出一次 IDR 访问。`port`、`offset`、`size` 与 `signed` 都是
 * 运行期值，因此端口选择与宽度掩码在服务块里求值一次即可，与指令块数量无关。
 */
export function readIdrDeferred(
  b: Body,
  port: Value<number>,
  offset: Value<number>,
  size: Value<number>,
  signed: Value<boolean>,
): Value<number> {
  const packed = b.local(types.number, 0);

  selectPort(b, port, 0, (body, index) => {
    const portPins = PORTS[index];

    if (portPins !== undefined) body.setLocal(packed, readIdr(body, portPins));
  });

  // 与内联路径的 `extract` 一致：字访问忽略字节偏移，字节/半字按偏移右移。
  const shift = b.select(
    types.number,
    b.equal(types.number, size, num(b, 4)),
    (word) => num(asBody(word), 0),
    (narrow) => {
      const scope = asBody(narrow);

      return scope.multiply(scope.bitAnd(offset, num(scope, 3)), num(scope, 8));
    },
  );
  const width = b.multiply(size, num(b, 8));
  const value = b.bitAnd(b.shiftRightUnsigned(b.getLocal(packed), shift), maskWidth(b, width));

  return b.select(
    types.number,
    signed,
    (inner) => signExtendDynamic(asBody(inner), value, width),
    () => value,
  );
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
): Value<number> {
  return writeRegister(b, port, offset, size, value);
}

export { DRIVE_RESISTANCE, PULL_RESISTANCE };
