import { types } from '@mica-js/sdk/model';
import type { IntentValue, Value } from '@mica-js/sdk/model';
import {
  DEFER_READ,
  DEFER_READ_OFFSET,
  DEFER_READ_PORT,
  DEFER_READ_SIGNED,
  DEFER_READ_SIZE,
  DEFER_READ_MODULE,
  DEFER_READ_TARGET,
  GPIO_BASE,
  GPIO_PIN_MASK,
  GPIO_POWERED,
  GPIO_STATE,
  GPIO_STATE_STRIDE,
  GPIO_SYNC,
  GPIO_WRITE,
  GPIO_WRITE_ADDR,
  GPIO_WRITE_SIZE,
  GPIO_WRITE_VALUE,
  PERIPH,
  SERVICE_DEFER_READ,
  SERVICE_GPIO_WRITE,
  SERVICE_PIN_SYNC,
  gpioAfr0State,
  gpioAfr1State,
  gpioLockState,
  gpioLockStepState,
  gpioModerState,
  gpioOdrState,
  gpioOtyperState,
  gpioPupdrState,
} from './layout';
import type { AccessSize } from './layout';
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
/** `0x20020` 同时承担引脚刷新；全端口请求用于极罕见的 GPIO 供电跳变。 */
const SERVICE_GPIO_SYNC = SERVICE_PIN_SYNC;
const GPIO_ALL_PORT_MASK = (1 << PORTS.length) - 1;

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

/** 静态偏移版本的字节/半字截取；偏移在翻译期已知。 */
function extractAt(b: Body, value: Value<number>, offset: number, size: number): Value<number> {
  if (size === 4) return value;
  const shift = (offset & 3) * 8;
  const shifted = shift === 0 ? value : b.shiftRightUnsigned(value, num(b, shift));

  return b.bitAnd(shifted, num(b, size === 2 ? 0xffff : 0xff));
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
    odr: b.readState(gpioOdrState(portIndex), types.number),
    afr0: b.readState(gpioAfr0State(portIndex), types.number),
    afr1: b.readState(gpioAfr1State(portIndex), types.number),
    supplied: powered(b),
  };
}

/**
 * 单个候选脚只读取 intent 实际会用到的寄存器。候选位跨 7/8 边界时两侧 AFR 都要读，
 * 否则未涉及的一半保持常量 0，避免每次稳态翻转都多读一个 state。
 */
function candidateRegisters(
  b: Body,
  portIndex: number,
  candidateMask: number,
  odr: Value<number>,
  supplied: Value<boolean>,
): PortRegisters {
  return {
    moder: b.readState(gpioModerState(portIndex), types.number),
    otyper: b.readState(gpioOtyperState(portIndex), types.number),
    pupdr: b.readState(gpioPupdrState(portIndex), types.number),
    odr,
    afr0:
      (candidateMask & 0xff) === 0
        ? num(b, 0)
        : b.readState(gpioAfr0State(portIndex), types.number),
    afr1:
      (candidateMask & 0xff00) === 0
        ? num(b, 0)
        : b.readState(gpioAfr1State(portIndex), types.number),
    supplied,
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
          // 开漏输出的高电平不是推挽驱动，而是释放到 PUPDR 定义的上/下拉。
          const openDrainOutput = boolOr(
            inner,
            inner.notEqual(types.number, openDrain, num(inner, 0)),
            bool(inner, driver.openDrain === true),
          );

          return inner.select(
            types.intent,
            openDrainOutput,
            (open) =>
              asBody(open).select(
                types.intent,
                driver.level(asBody(open)),
                (high) => pullAt(asBody(high)),
                (low) => resistorIntent(asBody(low), false, DRIVE_RESISTANCE),
              ),
            (pushPull) =>
              asBody(pushPull).select(
                types.intent,
                driver.level(asBody(pushPull)),
                (high) => resistorIntent(asBody(high), true, DRIVE_RESISTANCE),
                (low) => resistorIntent(asBody(low), false, DRIVE_RESISTANCE),
              ),
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
      scope.writeState(DEFER_READ_MODULE, num(scope, -1));
      markService(scope, SERVICE_DEFER_READ);
      idr.setLocal(result, num(scope, 0));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        isWriteOnly(body, wordOffset),
        (zero) => zero.setLocal(result, num(zero, 0)),
        (stored) => {
          const scope = asBody(stored);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, GPIO_LCKR)),
            (lckr) => lckr.setLocal(result, readLckr(asBody(lckr), portIndex, offset, size)),
            (register) => {
              const body2 = asBody(register);

              body2.if(
                body2.equal(types.number, wordOffset, num(body2, GPIO_ODR)),
                (odr) =>
                  odr.setLocal(result, odr.readState(gpioOdrState(portIndex), types.number)),
                (plain) => plain.setLocal(result, loadWord(asBody(plain), portIndex, wordOffset)),
              );
            },
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

/** 静态端口/偏移版本的寄存器读；不生成端口或寄存器偏移的运行时判定。 */
function readRegisterStatic(
  b: Body,
  portIndex: number,
  offset: number,
  size: number,
  defer?: DeferRead,
): Value<number> {
  const port = PORTS[portIndex];

  if (port === undefined) return num(b, 0);

  const wordOffset = offset & 0x3c;

  if (wordOffset === GPIO_IDR) {
    if (defer === undefined) return extractAt(b, readIdr(b, port), offset, size);

    b.writeState(DEFER_READ, bool(b, true));
    b.writeState(DEFER_READ_PORT, num(b, portIndex));
    b.writeState(DEFER_READ_OFFSET, num(b, offset));
    b.writeState(DEFER_READ_TARGET, num(b, defer.target));
    b.writeState(DEFER_READ_SIZE, num(b, size));
    b.writeState(DEFER_READ_SIGNED, bool(b, defer.signed));
    b.writeState(DEFER_READ_MODULE, num(b, -1));
    markService(b, SERVICE_DEFER_READ);

    return num(b, 0);
  }

  if (wordOffset === GPIO_BSRR || wordOffset === GPIO_BRR) return num(b, 0);
  if (wordOffset === GPIO_LCKR) return readLckr(b, portIndex, num(b, offset), size);

  const stored =
    wordOffset === GPIO_ODR
      ? b.readState(gpioOdrState(portIndex), types.number)
      : readWordAt(b, PERIPH, stateBase(portIndex) + wordOffset);

  return extractAt(b, stored, offset, size);
}

/** 静态 GPIO 读入口；BSRR/BRR 恒为零，ODR 直接读影子 state。 */
export function readGpioPort(
  b: Body,
  port: number,
  offset: number,
  size: number,
  defer?: DeferRead,
): Value<number> {
  return readRegisterStatic(b, port, offset, size, defer);
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

/** 编译期按访问宽度把写入值放到目标寄存器字的位置；语义与 `placeWord` 一致。 */
export function placeStaticWord(value: number, offset: number, size: AccessSize): number {
  if (size === 4) return value >>> 0;

  const width = size === 2 ? 0xffff : 0xff;
  const shift = (size === 2 ? offset & 2 : offset & 3) * 8;

  return ((value & width) << shift) >>> 0;
}

function countSetBits(value: number): number {
  let count = 0;

  for (let rest = value >>> 0; rest !== 0; rest &= rest - 1) count += 1;

  return count;
}

interface StaticPinMasks {
  readonly setMask: number;
  readonly effectiveClearMask: number;
  readonly candidateMask: number;
}

/** 编译期推导一次静态 BSRR/BRR 写可能改变哪些引脚。 */
function staticPinMasks(
  wordOffset: number,
  offset: number,
  size: AccessSize,
  staticValue: number,
): StaticPinMasks | undefined {
  const placed = placeStaticWord(staticValue, offset, size);

  if (wordOffset === GPIO_BSRR) {
    const setMask = placed & 0xffff;
    const clearMask = (placed >>> 16) & 0xffff;
    // STM32 规定同一位同时 set/reset 时 set 优先。
    const effectiveClearMask = clearMask & ~setMask & 0xffff;

    return { setMask, effectiveClearMask, candidateMask: setMask | effectiveClearMask };
  }

  if (wordOffset === GPIO_BRR) {
    const effectiveClearMask = placed & 0xffff;

    return { setMask: 0, effectiveClearMask, candidateMask: effectiveClearMask };
  }

  return undefined;
}

interface StaticGpioLocation {
  readonly portIndex: number;
  readonly offset: number;
  readonly wordOffset: number;
}

function staticGpioLocation(staticAddress: number | undefined): StaticGpioLocation | undefined {
  if (staticAddress === undefined) return undefined;

  const relative = staticAddress - GPIO_BASE;

  if (relative < 0 || relative >= 0x2000) return undefined;

  const portIndex = relative >>> 10;

  if (portIndex >= PORTS.length) return undefined;

  const offset = relative & 0x3ff;

  return { portIndex, offset, wordOffset: offset & 0x3c };
}

/**
 * 判断一个静态 GPIO 访问是否能完全在 Guest 块内处理：IDR 是只读访问；BSRR/BRR
 * 只有在值已知且候选引脚不超过两根时才能内联。
 */
export function canInlineStaticGpioWrite(
  staticAddress?: number,
  size: AccessSize = 4,
  staticValue?: number,
): boolean {
  const location = staticGpioLocation(staticAddress);

  if (location === undefined) return false;
  if (location.wordOffset === GPIO_IDR) return true;
  if (staticValue === undefined) return false;
  if (location.wordOffset !== GPIO_BSRR && location.wordOffset !== GPIO_BRR) return false;

  const masks = staticPinMasks(location.wordOffset, location.offset, size, staticValue);

  return masks !== undefined && countSetBits(masks.candidateMask) <= 2;
}

/**
 * 静态 BSRR/BRR 内联后是否可能改变引脚电平。宿主的电气求解只在块边界运行，
 * 因此这类写之后必须收块，否则同一块内的多个脉冲（例如 LCD WR 低→高）会被合并。
 */
export function inlineStaticGpioWriteChangesPin(
  staticAddress?: number,
  size: AccessSize = 4,
  staticValue?: number,
): boolean {
  const location = staticGpioLocation(staticAddress);

  if (location === undefined || staticValue === undefined) return false;
  if (location.wordOffset !== GPIO_BSRR && location.wordOffset !== GPIO_BRR) return false;

  const masks = staticPinMasks(location.wordOffset, location.offset, size, staticValue);

  if (masks === undefined) return false;
  const candidates = countSetBits(masks.candidateMask);

  return candidates > 0 && candidates <= 2;
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

/** 把 16 位引脚掩码的每一位展开到 2 位字段的起始位（bit i → bit 2i）。 */
function spreadPairs(b: Body, mask: Value<number>): Value<number> {
  let spread = b.bitAnd(mask, num(b, 0xffff));

  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 8))),
    num(b, 0x00ff00ff),
  );
  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 4))),
    num(b, 0x0f0f0f0f),
  );
  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 2))),
    num(b, 0x33333333),
  );

  return b.bitAnd(b.bitOr(spread, b.shiftLeft(spread, num(b, 1))), num(b, 0x55555555));
}

/** 把 8 位引脚掩码的每一位展开到 4 位字段（bit i → bit 4i）。 */
function spreadNibbles(b: Body, mask: Value<number>): Value<number> {
  let spread = b.bitAnd(mask, num(b, 0xff));

  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 12))),
    num(b, 0x000f000f),
  );
  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 6))),
    num(b, 0x03030303),
  );
  spread = b.bitAnd(
    b.bitOr(spread, b.shiftLeft(spread, num(b, 3))),
    num(b, 0x11111111),
  );

  return b.multiply(spread, num(b, 0xf));
}

function lockedFieldMask(
  b: Body,
  portIndex: number,
  wordOffset: number,
): Value<number> {
  const locked = b.readState(gpioLockState(portIndex), types.number);

  if (wordOffset === GPIO_OTYPER) return b.bitAnd(locked, num(b, 0xffff));

  if (wordOffset === GPIO_MODER || wordOffset === GPIO_PUPDR) {
    const starts = spreadPairs(b, locked);

    return b.bitOr(starts, b.shiftLeft(starts, num(b, 1)));
  }

  if (wordOffset === GPIO_AFR0) return spreadNibbles(b, b.bitAnd(locked, num(b, 0xff)));
  if (wordOffset === GPIO_AFR1)
    return spreadNibbles(b, b.shiftRightUnsigned(locked, num(b, 8)));

  return num(b, 0);
}

/** 锁定的引脚字段不可改；ODR/BSRR/BRR 不走这里。 */
function lockedFieldMaskDynamic(
  b: Body,
  portIndex: number,
  wordOffset: Value<number>,
): Value<number> {
  let mask = num(b, 0);

  for (const offsetOf of [GPIO_OTYPER, GPIO_MODER, GPIO_PUPDR, GPIO_AFR0, GPIO_AFR1]) {
    const candidate = lockedFieldMask(b, portIndex, offsetOf);

    mask = b.select(
      types.number,
      b.equal(types.number, wordOffset, num(b, offsetOf)),
      () => candidate,
      () => mask,
    );
  }

  return mask;
}

function writeLockState(
  b: Body,
  portIndex: number,
  step: number,
  candidate: Value<number>,
): void {
  b.writeState(
    gpioLockStepState(portIndex),
    b.bitOr(num(b, step), b.shiftLeft(candidate, num(b, 4))),
  );
}

/** LCKK 三步写序列：1 → 0 → 1，全部携带同一引脚掩码；随后读 LCKR 完成锁定。 */
function writeLckr(
  b: Body,
  portIndex: number,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const placed = placeWord(b, value, offset, size);
  const raw = b.bitAnd(placed, num(b, 0x1ffff));
  const lckk = boolBit(b, raw, 1 << 16);
  const pins = b.bitAnd(raw, num(b, 0xffff));
  const state = b.readState(gpioLockStepState(portIndex), types.number);
  const step = b.bitAnd(state, num(b, 0xf));
  const candidate = b.shiftRightUnsigned(state, num(b, 4));

  const store = (body: Body, next: number, pinsValue: Value<number>) =>
    writeLockState(body, portIndex, next, pinsValue);

  b.if(
    b.equal(types.number, step, num(b, 0)),
    (s0) => {
      const body = asBody(s0);

      body.if(
        lckk,
        (yes) => store(asBody(yes), 1, pins),
        (no) => store(asBody(no), 0, num(asBody(no), 0)),
      );
    },
    (after0) => {
      const branch1 = asBody(after0);

      branch1.if(
        branch1.equal(types.number, step, num(branch1, 1)),
        (s1) => {
          const body = asBody(s1);

          body.if(
            boolAnd(
              body,
              body.not(lckk),
              body.equal(types.number, pins, candidate),
            ),
            (yes) => store(asBody(yes), 2, candidate),
            (no) => {
              const body2 = asBody(no);

              body2.if(
                lckk,
                (restart) => store(asBody(restart), 1, pins),
                (idle) => store(asBody(idle), 0, num(asBody(idle), 0)),
              );
            },
          );
        },
        (after1) => {
          const branch2 = asBody(after1);

          branch2.if(
            branch2.equal(types.number, step, num(branch2, 2)),
            (s2) => {
              const body = asBody(s2);

              body.if(
                boolAnd(
                  body,
                  lckk,
                  body.equal(types.number, pins, candidate),
                ),
                (yes) => store(asBody(yes), 3, candidate),
                (no) => {
                  const body2 = asBody(no);

                  body2.if(
                    lckk,
                    (restart) => store(asBody(restart), 1, pins),
                    (idle) => store(asBody(idle), 0, num(asBody(idle), 0)),
                  );
                },
              );
            },
            (locked) => {
              const body = asBody(locked);

              body.if(
                lckk,
                (restart) => store(asBody(restart), 1, pins),
                (idle) => store(asBody(idle), 4, num(asBody(idle), 0)),
              );
            },
          );
        },
      );
    },
  );
}

/**
 * 读 LCKR：step=3 表示三步写已完成，读确认后把候选位并入锁定掩码；LCKK 读回 1。
 * 这一步不可省略，否则 HAL_GPIO_LockPin 之后的读回语义不正确。
 */
function readLckr(
  b: Body,
  portIndex: number,
  offset: Value<number>,
  size: number,
): Value<number> {
  const lock = b.local(types.number, b.readState(gpioLockState(portIndex), types.number));
  const state = b.local(
    types.number,
    b.readState(gpioLockStepState(portIndex), types.number),
  );
  const step = b.bitAnd(b.getLocal(state), num(b, 0xf));

  b.if(b.equal(types.number, step, num(b, 3)), (confirm) => {
    const body = asBody(confirm);
    const candidate = body.shiftRightUnsigned(body.getLocal(state), num(body, 4));

    body.setLocal(lock, body.bitOr(body.getLocal(lock), candidate));
    body.writeState(gpioLockState(portIndex), body.getLocal(lock));
    body.setLocal(state, num(body, 4));
    body.writeState(gpioLockStepState(portIndex), num(body, 4));
  });

  const lckk = b.select(
    types.number,
    b.greaterThanOrEqual(
      b.bitAnd(b.getLocal(state), num(b, 0xf)),
      num(b, 3),
    ),
    (set) => set.constant(types.number, 1 << 16),
    (clear) => clear.constant(types.number, 0),
  );
  const value = b.bitOr(b.getLocal(lock), lckk);

  return extract(b, value, offset, size);
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
          const current = scope.readState(gpioOdrState(portIndex), types.number);
          const placed = placeWord(scope, value, offset, size);
          const setBits = scope.bitAnd(placed, num(scope, 0xffff));
          const clearBits = scope.bitAnd(
            scope.shiftRightUnsigned(placed, num(scope, 16)),
            num(scope, 0xffff),
          );
          // 同一位同时 set/reset 时 set 优先，与 STM32 BSRR 的约定一致。
          const next = scope.bitOr(scope.bitAnd(current, scope.bitNot(clearBits)), setBits);

          scope.setLocal(changed, scope.bitAnd(scope.bitXor(current, next), num(scope, 0xffff)));
          scope.writeState(gpioOdrState(portIndex), next);
        },
        (other) => {
          const scope = asBody(other);

          scope.if(
            scope.equal(types.number, wordOffset, num(scope, GPIO_BRR)),
            (brr) => {
              const last = asBody(brr);
              const current = last.readState(gpioOdrState(portIndex), types.number);
              const clearBits = last.bitAnd(
                placeWord(last, value, offset, size),
                num(last, 0xffff),
              );
              const next = last.bitAnd(current, last.bitNot(clearBits));

              last.setLocal(changed, last.bitAnd(last.bitXor(current, next), num(last, 0xffff)));
              last.writeState(gpioOdrState(portIndex), next);
            },
            (plain) => {
              const last = asBody(plain);
              const current = last.readState(gpioOdrState(portIndex), types.number);
              const next = mergeWord(last, current, value, offset, size);

              last.setLocal(changed, last.bitAnd(last.bitXor(current, next), num(last, 0xffff)));
              last.writeState(gpioOdrState(portIndex), next);
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

          body2.if(
            body2.equal(types.number, wordOffset, num(body2, GPIO_LCKR)),
            (lckr) => writeLckr(asBody(lckr), portIndex, offset, size, value),
            (config) => {
              const body3 = asBody(config);
              const current = loadWord(body3, portIndex, wordOffset);
              const mergedRaw = mergeWord(body3, current, value, offset, size);
              const locked = lockedFieldMaskDynamic(body3, portIndex, wordOffset);
              const merged = u32(
                body3,
                body3.bitOr(
                  body3.bitAnd(mergedRaw, body3.bitNot(locked)),
                  body3.bitAnd(current, locked),
                ),
              );
              const diff = body3.bitXor(current, merged);

              storeWord(body3, portIndex, wordOffset, merged);
              // 引脚意图读的是影子 state，这里写穿：存储器仍是固件可见的寄存器映像。
              for (const [offsetOf, stateOf] of [
                [GPIO_MODER, gpioModerState],
                [GPIO_OTYPER, gpioOtyperState],
                [GPIO_PUPDR, gpioPupdrState],
                [GPIO_AFR0, gpioAfr0State],
                [GPIO_AFR1, gpioAfr1State],
              ] as const)
                body3.if(
                  body3.equal(types.number, wordOffset, num(body3, offsetOf)),
                  (hit) => {
                    const scope = asBody(hit);

                    scope.writeState(stateOf(portIndex), merged);

                    if (offsetOf === GPIO_OTYPER)
                      scope.setLocal(changed, scope.bitAnd(diff, num(scope, 0xffff)));
                    else if (offsetOf === GPIO_MODER || offsetOf === GPIO_PUPDR)
                      scope.setLocal(changed, changedPairPins(scope, diff));
                    else if (offsetOf === GPIO_AFR0)
                      scope.setLocal(changed, changedNibblePins(scope, diff, 0));
                    else scope.setLocal(changed, changedNibblePins(scope, diff, 8));
                  },
                );
            },
          );
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

/** 静态输出寄存器写对应的 ODR 前后值。 */
function odrTransition(
  b: Body,
  portIndex: number,
  wordOffset: number,
  offset: number,
  size: number,
  value: Value<number>,
): { readonly current: Value<number>; readonly next: Value<number> } {
  const current = b.readState(gpioOdrState(portIndex), types.number);

  if (wordOffset === GPIO_BSRR) {
    const placed = placeWord(b, value, num(b, offset), size);
    const setBits = b.bitAnd(placed, num(b, 0xffff));
    const clearBits = b.bitAnd(b.shiftRightUnsigned(placed, num(b, 16)), num(b, 0xffff));
    const next = b.bitOr(b.bitAnd(current, b.bitNot(clearBits)), setBits);

    return { current, next };
  }

  if (wordOffset === GPIO_BRR) {
    const clearBits = b.bitAnd(placeWord(b, value, num(b, offset), size), num(b, 0xffff));

    return { current, next: b.bitAnd(current, b.bitNot(clearBits)) };
  }

  return { current, next: mergeWord(b, current, value, num(b, offset), size) };
}

/** 稳态快路径：外层已确认 changed 非零，只对候选脚中真正变化的位重发 intent。 */
function emitStaticCandidateIntents(
  b: Body,
  portIndex: number,
  candidateMask: number,
  changed: Value<number>,
  registers: PortRegisters,
): void {
  if (countSetBits(candidateMask) === 1) {
    emitPinIntent(b, portIndex, 31 - Math.clz32(candidateMask), registers);

    return;
  }

  for (let bit = 0; bit < 16; bit += 1) {
    const bitMask = 1 << bit;

    if ((candidateMask & bitMask) === 0 || PORTS[portIndex]?.pins[bit] === null) continue;

    b.if(boolBit(b, changed, bitMask), (selected) => {
      emitPinIntent(asBody(selected), portIndex, bit, registers);
    });
  }
}

/** 供电状态跳变时登记一次全端口刷新；服务块最多执行一次。 */
function markPowerChange(b: Body): void {
  b.writeState(
    GPIO_SYNC,
    b.bitOr(b.readState(GPIO_SYNC, types.number), num(b, GPIO_ALL_PORT_MASK)),
  );
  markService(b, SERVICE_GPIO_SYNC);
}

/**
 * 静态单/双引脚输出写：ODR 在当前指令块内落地，所有宽度的读均由 state 提供。稳态只重算候选
 * 引脚的电气 intent；供电跳变才把全端口刷新交给极少命中的服务块。
 */
function inlineStaticGpioWrite(b: Body, portIndex: number, masks: StaticPinMasks): void {
  const { setMask, effectiveClearMask, candidateMask } = masks;
  const current = b.readState(gpioOdrState(portIndex), types.number);
  const clearKeepMask = ~effectiveClearMask & 0xffff;
  const next = b.bitOr(b.bitAnd(current, num(b, clearKeepMask)), num(b, setMask));
  const changed = b.bitAnd(b.bitXor(current, next), num(b, candidateMask));

  b.if(b.notEqual(types.number, changed, num(b, 0)), (active) => {
    const scope = asBody(active);

    scope.writeState(gpioOdrState(portIndex), next);

    const isPowered = powered(scope);
    const wasPowered = scope.readState(GPIO_POWERED, types.bool);

    scope.if(
      scope.notEqual(types.bool, isPowered, wasPowered),
      (onPowerChange) => markPowerChange(asBody(onPowerChange)),
      (onStablePower) => {
        const stable = asBody(onStablePower);
        const registers = candidateRegisters(stable, portIndex, candidateMask, next, isPowered);

        emitStaticCandidateIntents(stable, portIndex, candidateMask, changed, registers);
      },
    );
  });
}

/** 地址落在 GPIO 区间时取端口号（0–4）。 */
function gpioPortIndex(b: Body, address: Value<number>): Value<number> {
  return b.shiftRightUnsigned(b.subtract(address, num(b, GPIO_BASE)), num(b, 10));
}

/** 登记一次走服务块的 GPIO 写；`GPIO_PIN_MASK = 0` 表示服务块尚未预计算 ODR。 */
function registerGpioWrite(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.writeState(GPIO_PIN_MASK, num(b, 0));
  b.writeState(GPIO_WRITE_ADDR, u32(b, address));
  b.writeState(GPIO_WRITE_VALUE, u32(b, value));
  b.writeState(GPIO_WRITE_SIZE, num(b, size));
  b.writeState(GPIO_WRITE, num(b, 1));
  markService(b, SERVICE_GPIO_WRITE);
}

/** 登记一次完整的 GPIO 寄存器写；静态地址仍会先做编译期端口校验。 */
export function queueGpioWrite(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
  staticAddress?: number,
): void {
  if (staticAddress !== undefined) {
    const relative = staticAddress - GPIO_BASE;

    if (relative < 0 || relative >= 0x2000 || relative >>> 10 >= PORTS.length) return;
    registerGpioWrite(b, num(b, staticAddress), size, value);

    return;
  }

  registerGpioWrite(b, address, size, value);
}

/**
 * 延迟 GPIO 写。静态地址命中 ODR/BSRR/BRR 时在 Guest 块内直接算新 ODR 与变化位，
 * 无变化就完全跳过服务调度。静态值为单/双引脚的 BSRR/BRR 写进一步在 Guest 块内完成
 * 稳态 intent 刷新；其他寄存器或超过两根候选脚的写仍交给服务块处理。
 *
 * 基址无法证明的动态写继续走服务块：为每个动态站点展开端口选择树会放大生成的 Guest
 * 代码。服务块里的 `writeGpioPort` 仍按 ODR 前后值计算精确 `changed`，为零时不会刷新
 * 任何引脚意图。
 */
export function deferGpioWrite(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  staticAddress?: number,
  staticValue?: number,
): void {
  if (staticAddress === undefined) {
    queueGpioWrite(b, address, size, value);

    return;
  }

  const location = staticGpioLocation(staticAddress);

  if (location === undefined) {
    queueGpioWrite(b, address, size, value, staticAddress);

    return;
  }

  const { portIndex, offset, wordOffset } = location;

  // 写 GPIO_IDR 在 STM32 上是只读访问，既不改变 ODR，也不需要服务。
  if (wordOffset === GPIO_IDR) return;

  if (staticValue !== undefined) {
    const masks = staticPinMasks(wordOffset, offset, size, staticValue);

    if (masks !== undefined) {
      if (masks.candidateMask === 0) return;

      if (countSetBits(masks.candidateMask) <= 2) {
        inlineStaticGpioWrite(b, portIndex, masks);

        return;
      }
    }
  }

  if (wordOffset !== GPIO_ODR && wordOffset !== GPIO_BSRR && wordOffset !== GPIO_BRR) {
    queueGpioWrite(b, address, size, value, staticAddress);

    return;
  }

  const transition = odrTransition(b, portIndex, wordOffset, offset, size, value);
  const changed = b.bitAnd(b.bitXor(transition.current, transition.next), num(b, 0xffff));

  b.if(b.notEqual(types.number, changed, num(b, 0)), (hit) => {
    const scope = asBody(hit);

    scope.writeState(gpioOdrState(portIndex), transition.next);
    scope.writeState(GPIO_PIN_MASK, changed);
    scope.writeState(GPIO_WRITE_ADDR, num(scope, staticAddress));
    scope.writeState(GPIO_WRITE_VALUE, u32(scope, value));
    scope.writeState(GPIO_WRITE_SIZE, num(scope, size));
    scope.writeState(GPIO_WRITE, num(scope, 1));
    markService(scope, SERVICE_GPIO_WRITE);
  });
}

/** 动态 GPIO 写服务块：端口在运行期选择，变化位精确同步。 */
export function writeGpioDynamic(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
): void {
  const portValue = gpioPortIndex(b, address);
  const offset = b.bitAnd(b.subtract(address, num(b, GPIO_BASE)), num(b, 0x3ff));
  const changed = b.local(types.number, num(b, 0));

  selectPort(b, portValue, 0, (body, port) => {
    body.setLocal(changed, writeRegister(body, port, offset, size, value));
    body.if(body.notEqual(types.number, body.getLocal(changed), num(body, 0)), (sync) => {
      const scope = asBody(sync);

      syncPort(scope, port, scope.getLocal(changed));
    });
  });
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
  const fastMask = b.readState(GPIO_PIN_MASK, types.number);
  const changed = b.local(types.number, num(b, 0));

  b.if(
    b.notEqual(types.number, fastMask, num(b, 0)),
    (fast) => {
      const scope = asBody(fast);

      scope.writeState(GPIO_PIN_MASK, num(scope, 0));
      scope.setLocal(changed, fastMask);
    },
    (slow) => {
      const scope = asBody(slow);

      scope.setLocal(changed, writeRegister(scope, port, offset, size, value));
    },
  );

  return b.getLocal(changed);
}

export { DRIVE_RESISTANCE, PULL_RESISTANCE };
