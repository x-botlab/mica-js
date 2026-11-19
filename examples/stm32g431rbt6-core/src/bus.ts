import { types } from '@mica-js/sdk/model';
import type { Local, Value } from '@mica-js/sdk/model';
import {
  DEFER_READ,
  DEFER_READ_ADDRESS,
  DEFER_READ_MODULE,
  DEFER_READ_SIGNED,
  DEFER_READ_SIZE,
  DEFER_READ_TARGET,
  DEFER_WRITE,
  DEFER_WRITE_ADDR,
  DEFER_WRITE_MODULE,
  DEFER_WRITE_SIZE,
  DEFER_WRITE_VALUE,
  CCM,
  CCM_BASE,
  CCM_SIZE,
  FLASH_BASE,
  FLASH_ALIAS_BASE,
  FLASH_BASE_REGISTER,
  FLASH_SIZE,
  GENERIC,
  GENERIC_SIZE,
  GPIO_BASE,
  PERIPHERAL_BASE,
  PERIPHERAL_END,
  PERIPH,
  PWR_BASE,
  RCC_BASE,
  SERVICE_DEFER_READ,
  SERVICE_DEFER_WRITE,
  SERVICE_CORE_WRITE_BASE,
  SERVICE_FLASH_WRITE,
  SERVICE_SYSTEM_WRITE,
  SERVICE_MODULE_READ_BASE,
  SERVICE_MODULE_WRITE_BASE,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
  SYSTEM_BASE,
  SYSTEM_END,
  GENERIC_SLOTS,
  genericTagOf,
  genericTagOffset,
  genericValueOffset,
  genericWordIndex,
} from './layout';
import type { AccessSize } from './layout';
import {
  asBody,
  bool,
  boolOr,
  markService,
  num,
  readWord,
  readWordAt,
  u32,
  writeByte,
  writeHalf,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { deferGpioWrite, gpioPortOf, queueGpioWrite, readGpio, readGpioPort } from './gpio';
import { machine } from './machine';
import type { DeferRead } from './memory';
import type { PeripheralModule } from './peripheral';
import { readPwr } from './pwr';
import { readRcc, writeRcc } from './rcc';
import { refreshCpuClock, refreshTick } from './tick';
import { USARTS, readUsart, writeUsart } from './usart';

/**
 * 外设总线。
 *
 * 已建模的区间按寄存器语义处理；其余 0x40000000–0x5FFFFFFF 的地址落在一个 1 KiB
 * 的通用寄存器后备区里，读回最后写入的值。这样固件对未建模外设（定时器、ADC、
 * SPI、I2C 等）的配置不会读到随机的 0 或触发错误，但那些外设也没有实际行为。
 *
 * 各区间互不重叠，因此判定是一条命中即停的 if/else 链，按常见程度排序；
 * 后备区读写也是字节访问，块可以进 direct 后端。
 */

/** `u32(address - base) < size`。 */
const inRegion = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

function genericSlot(b: Body, address: Value<number>): Value<number> {
  const word = b.shiftRightUnsigned(b.subtract(address, num(b, PERIPHERAL_BASE)), num(b, 2));
  const mixed = b.bitXor(
    word,
    b.bitXor(b.shiftRightUnsigned(word, num(b, 8)), b.shiftRightUnsigned(word, num(b, 16))),
  );

  return b.bitAnd(mixed, num(b, GENERIC_SLOTS - 1));
}

/** 静态地址命中的注册模块；翻译期完成，运行期不扫描模块表。 */
function staticModuleAt(
  address: number,
): { readonly module: PeripheralModule; readonly offset: number } | undefined {
  for (const module of machine().peripherals) {
    for (const range of module.ranges) {
      if (inStaticRegion(address, range.base, range.size))
        return { module, offset: address - range.base };
    }
  }

  return undefined;
}

function readRegisteredStatic(
  b: Body,
  size: number,
  staticAddress: number,
): Value<number> | undefined {
  const hit = staticModuleAt(staticAddress);

  if (hit === undefined) return undefined;

  // `readStatic` 只允许在确定处理时发射 IR；decline（undefined）必须发生在任何
  // 副作用之前，否则下面的旧 `read` 会重复执行同一访问。
  const fast = hit.module.readStatic?.(b, staticAddress, size);

  return fast ?? hit.module.read(b, num(b, staticAddress), size);
}

function writeRegisteredStatic(
  b: Body,
  staticAddress: number,
  size: AccessSize,
  value: Value<number>,
): boolean {
  const hit = staticModuleAt(staticAddress);

  if (hit === undefined) return false;

  // 与读相同：`writeStatic` 返回 false 前不得发射 IR，随后才由旧 `write` 接手。
  if (hit.module.writeStatic?.(b, staticAddress, size, value) === true) return true;

  hit.module.write(b, num(b, staticAddress), size, value);

  return true;
}

interface DynamicRange {
  readonly module: PeripheralModule;
  readonly base: number;
  readonly size: number;
}

function registeredRanges(): readonly DynamicRange[] {
  const ranges: DynamicRange[] = [];

  for (const module of machine().peripherals)
    for (const range of module.ranges) ranges.push({ module, base: range.base, size: range.size });

  return ranges;
}

/** 动态读的外设模块分派；所有模块都不命中时落到 `fallback`。 */
function readRegisteredDynamic(
  b: Body,
  address: Value<number>,
  size: number,
  result: Local<number>,
  fallback: (body: Body) => void,
): void {
  const ranges = registeredRanges();
  const step = (body: Body, index: number): void => {
    const range = ranges[index];

    if (range === undefined) {
      fallback(body);

      return;
    }

    body.if(
      inRegion(body, address, range.base, range.size),
      (hit) => {
        const scope = asBody(hit);

        scope.setLocal(result, range.module.read(scope, address, size));
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

/** 动态写的外设模块分派；所有模块都不命中时落到 `fallback`。 */
function writeRegisteredDynamic(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  fallback: (body: Body) => void,
): void {
  const ranges = registeredRanges();
  const step = (body: Body, index: number): void => {
    const range = ranges[index];

    if (range === undefined) {
      fallback(body);

      return;
    }

    body.if(
      inRegion(body, address, range.base, range.size),
      (hit) => {
        range.module.write(asBody(hit), address, size, value);
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

function readGenericStatic(b: Body, size: number, staticAddress: number): Value<number> {
  const slot = genericWordIndex(staticAddress);
  const tag = readWordAt(b, GENERIC, genericTagOffset(slot));
  const value = readWordAt(b, GENERIC, genericValueOffset(slot));

  return b.select(
    types.number,
    b.equal(types.number, tag, num(b, genericTagOf(staticAddress))),
    (hit) => extractAt(asBody(hit), value, staticAddress, size),
    (miss) => miss.constant(types.number, 0),
  );
}

function writeGenericStatic(
  b: Body,
  size: number,
  value: Value<number>,
  staticAddress: number,
): void {
  const slot = genericWordIndex(staticAddress);
  const tag = genericTagOf(staticAddress);
  const storedTag = readWordAt(b, GENERIC, genericTagOffset(slot));
  const stored = readWordAt(b, GENERIC, genericValueOffset(slot));
  const current = b.select(
    types.number,
    b.equal(types.number, storedTag, num(b, tag)),
    (hit) => hit.constant(types.number, 0),
    (miss) => miss.constant(types.number, 0),
  );
  const base = b.select(
    types.number,
    b.equal(types.number, storedTag, num(b, tag)),
    () => stored,
    () => current,
  );

  writeWordAt(b, GENERIC, genericTagOffset(slot), num(b, tag));
  writeWordAt(
    b,
    GENERIC,
    genericValueOffset(slot),
    merge(b, base, value, num(b, staticAddress), size),
  );
}

/** 按字节位置截取一次寄存器字；`size` 是编译期常量。 */
function extract(b: Body, word: Value<number>, offset: Value<number>, size: number): Value<number> {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
}

function readRegisterFile(
  b: Body,
  offset: Value<number>,
  size: number,
  base: number,
): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  return extract(b, readWord(b, PERIPH, b.add(num(b, base), wordOffset)), offset, size);
}

function writeRegisterFile(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
  base: number,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const at = b.add(num(b, base), wordOffset);
  const current = readWord(b, PERIPH, at);

  writeWord(b, PERIPH, at, merge(b, current, value, offset, size));
}

function merge(
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

const inStaticRegion = (address: number, base: number, size: number): boolean =>
  address >= base && address < base + size;

/** 按静态字节偏移截取寄存器字。 */
function extractAt(b: Body, word: Value<number>, offset: number, size: number): Value<number> {
  if (size === 4) return word;
  const shift = (offset & 3) * 8;
  const shifted = shift === 0 ? word : b.shiftRightUnsigned(word, num(b, shift));

  return b.bitAnd(shifted, num(b, size === 2 ? 0xffff : 0xff));
}

function readRegisterFileAt(b: Body, offset: number, size: number, base: number): Value<number> {
  return extractAt(b, readWordAt(b, PERIPH, base + (offset & 0x3fc)), offset, size);
}

function writeRegisterFileAt(
  b: Body,
  offset: number,
  size: number,
  value: Value<number>,
  base: number,
): void {
  const wordOffset = offset & 0x3fc;
  const at = base + wordOffset;
  const current = readWordAt(b, PERIPH, at);

  writeWordAt(b, PERIPH, at, merge(b, current, value, num(b, offset), size));
}

/** 静态外设读：区间判定全部在翻译期完成，只发射命中的那一路。 */
function readStaticPeripheral(
  b: Body,
  size: number,
  defer: DeferRead | undefined,
  staticAddress: number,
): Value<number> {
  if (inStaticRegion(staticAddress, RCC_BASE, 0x400))
    return readRcc(b, num(b, staticAddress - RCC_BASE), size);

  if (inStaticRegion(staticAddress, GPIO_BASE, 0x2000)) {
    const relative = staticAddress - GPIO_BASE;
    const port = relative >>> 10;
    const offset = relative & 0x3ff;

    return readGpioPort(b, port, offset, size, defer);
  }

  if (inStaticRegion(staticAddress, USART1_BASE, 0x400))
    return readUsart(b, USARTS[0]!, num(b, staticAddress - USART1_BASE), size);

  if (inStaticRegion(staticAddress, USART2_BASE, 0x400))
    return readUsart(b, USARTS[1]!, num(b, staticAddress - USART2_BASE), size);

  if (inStaticRegion(staticAddress, USART3_BASE, 0x400))
    return readUsart(b, USARTS[2]!, num(b, staticAddress - USART3_BASE), size);

  // 注册模块优先于旧的 Flash/PWR 后备与通用后备区；Flash 控制器由 flashModule 接管。
  // 静态读同样直接展开唯一命中；decline 时必须无副作用（见 readRegisteredStatic）。
  const registered = readRegisteredStatic(b, size, staticAddress);

  if (registered !== undefined) return registered;

  if (inStaticRegion(staticAddress, FLASH_BASE_REGISTER, 0x400))
    return readRegisterFileAt(b, staticAddress - FLASH_BASE_REGISTER, size, 0x700);

  if (inStaticRegion(staticAddress, PWR_BASE, 0x400))
    return readPwr(b, num(b, staticAddress - PWR_BASE), size);

  if (inStaticRegion(staticAddress, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE))
    return readGenericStatic(b, size, staticAddress);

  return num(b, 0);
}

export function registerDeferredWrite(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  b.writeState(DEFER_WRITE, bool(b, true));
  b.writeState(DEFER_WRITE_ADDR, u32(b, address));
  b.writeState(DEFER_WRITE_VALUE, u32(b, value));
  b.writeState(DEFER_WRITE_SIZE, num(b, size));
  markService(b, SERVICE_DEFER_WRITE);
}

/** 静态外设写；GPIO 延迟写携带静态值，其余外设直接走各自的寄存器写路径。 */
function writeStaticPeripheral(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  defer: boolean,
  staticAddress: number,
  staticValue?: number,
): void {
  // 新外设模块只在静态地址路径展开。动态地址若把每个模块的完整 read/write body
  // 内联进 SERVICE_WRITE，会把 RCC/GPIO/USART 热路径的 JIT 块撑爆；模块访问本来就是
  // 固件里的固定 MMIO 地址，静态路径覆盖实际固件。静态模块写在翻译期已命中唯一模块/
  // 地址，直接展开其语义，不进入 `DEFER_WRITE` 单槽；动态地址仍保留原有 defer 合同。
  if (writeRegisteredStatic(b, staticAddress, size, value)) return;

  if (defer) {
    if (inStaticRegion(staticAddress, GPIO_BASE, 0x2000))
      deferGpioWrite(b, address, size, value, staticAddress, staticValue);
    else registerDeferredWrite(b, address, size, value);

    return;
  }

  if (inStaticRegion(staticAddress, RCC_BASE, 0x400)) {
    writeRcc(b, num(b, staticAddress - RCC_BASE), size, value);

    return;
  }

  if (inStaticRegion(staticAddress, GPIO_BASE, 0x2000)) {
    queueGpioWrite(b, address, size, value, staticAddress);

    return;
  }

  if (inStaticRegion(staticAddress, USART1_BASE, 0x400)) {
    writeUsart(b, USARTS[0]!, num(b, staticAddress - USART1_BASE), size, value);

    return;
  }

  if (inStaticRegion(staticAddress, USART2_BASE, 0x400)) {
    writeUsart(b, USARTS[1]!, num(b, staticAddress - USART2_BASE), size, value);

    return;
  }

  if (inStaticRegion(staticAddress, USART3_BASE, 0x400)) {
    writeUsart(b, USARTS[2]!, num(b, staticAddress - USART3_BASE), size, value);

    return;
  }

  if (inStaticRegion(staticAddress, FLASH_BASE_REGISTER, 0x400)) {
    writeRegisterFileAt(b, staticAddress - FLASH_BASE_REGISTER, size, value, 0x700);

    return;
  }

  if (inStaticRegion(staticAddress, PWR_BASE, 0x400)) {
    writeRegisterFileAt(b, staticAddress - PWR_BASE, size, value, 0x740);

    return;
  }

  if (inStaticRegion(staticAddress, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE))
    writeGenericStatic(b, size, value, staticAddress);
}

/**
 * SERVICE_WRITE 的动态写分派。Flash 代码/别名写转到独立服务块，避免把
 * writeFlashMemory 的完整 IAP 程序树内联进每次外设写；SRAM/CCM/外设/系统区
 * 复用现有语义。
 */
export function writeServiceMemory(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  diverted: Local<boolean>,
): void {
  const storeWidth = (body: Body, memory: string, offset: Value<number>): void => {
    if (size === 1) writeByte(body, memory, offset, value);
    else if (size === 2) writeHalf(body, memory, offset, value);
    else writeWord(body, memory, offset, value);
  };
  const divert = (body: Body, pc: number): void => {
    body.writeState('pc', num(body, pc));
    body.setLocal(diverted, bool(body, true));
  };
  const coreWrites: readonly {
    readonly base: number;
    readonly size: number;
    readonly index: number;
  }[] = [
    { base: RCC_BASE, size: 0x400, index: 0 },
    { base: GPIO_BASE, size: 0x2000, index: 1 },
    { base: USART1_BASE, size: 0x400, index: 2 },
    { base: USART2_BASE, size: 0x400, index: 2 },
    { base: USART3_BASE, size: 0x400, index: 2 },
    { base: FLASH_BASE_REGISTER, size: 0x400, index: 3 },
    { base: PWR_BASE, size: 0x400, index: 4 },
    { base: PERIPHERAL_BASE, size: PERIPHERAL_END - PERIPHERAL_BASE, index: 5 },
  ];
  const coreStep = (body: Body, index: number): void => {
    const target = coreWrites[index];

    if (target === undefined) {
      body.if(
        inRegion(body, address, SYSTEM_BASE, SYSTEM_END - SYSTEM_BASE),
        (system) => divert(asBody(system), SERVICE_SYSTEM_WRITE),
        (flash) => {
          const scope = asBody(flash);
          const inFlash = boolOr(
            scope,
            inRegion(scope, address, FLASH_BASE, FLASH_SIZE),
            inRegion(scope, address, FLASH_ALIAS_BASE, FLASH_SIZE),
          );

          scope.if(inFlash, (hit) => divert(asBody(hit), SERVICE_FLASH_WRITE));
        },
      );

      return;
    }

    body.if(
      inRegion(body, address, target.base, target.size),
      (hit) => divert(asBody(hit), SERVICE_CORE_WRITE_BASE + target.index),
      (next) => coreStep(asBody(next), index + 1),
    );
  };

  b.if(
    inRegion(b, address, SRAM_BASE, SRAM_SIZE),
    (ram) =>
      storeWidth(asBody(ram), SRAM, asBody(ram).subtract(address, num(asBody(ram), SRAM_BASE))),
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, CCM_BASE, CCM_SIZE),
        (ccm) =>
          storeWidth(asBody(ccm), CCM, asBody(ccm).subtract(address, num(asBody(ccm), CCM_BASE))),
        (rest) => coreStep(asBody(rest), 0),
      );
    },
  );
}

interface ModuleRangeEntry {
  readonly module: PeripheralModule;
  readonly index: number;
  readonly base: number;
  readonly size: number;
}

function moduleEntries(): readonly ModuleRangeEntry[] {
  const entries: ModuleRangeEntry[] = [];

  machine().peripherals.forEach((module, index) => {
    for (const range of module.ranges)
      entries.push({ module, index, base: range.base, size: range.size });
  });

  return entries;
}

/** 动态读命中模块时登记延迟读；只发射区间比较，不内联模块 body。 */
export function deferModuleRead(
  b: Body,
  address: Value<number>,
  size: number,
  defer: DeferRead,
  diverted: Local<boolean>,
): void {
  const entries = moduleEntries();
  const step = (body: Body, index: number): void => {
    const entry = entries[index];

    if (entry === undefined) return;

    body.if(
      inRegion(body, address, entry.base, entry.size),
      (hit) => {
        const scope = asBody(hit);

        scope.writeState(DEFER_READ, bool(scope, true));
        scope.writeState(DEFER_READ_MODULE, num(scope, entry.index));
        scope.writeState(DEFER_READ_ADDRESS, u32(scope, address));
        scope.writeState(DEFER_READ_TARGET, num(scope, defer.target));
        scope.writeState(DEFER_READ_SIZE, num(scope, size));
        scope.writeState(DEFER_READ_SIGNED, bool(scope, defer.signed));
        scope.setLocal(diverted, bool(scope, true));
        markService(scope, SERVICE_DEFER_READ);
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

/** 动态写命中模块时把 PC 转到该模块的写服务块；只发射区间比较。 */
export function deferModuleWrite(b: Body, address: Value<number>, diverted: Local<boolean>): void {
  const entries = moduleEntries();
  const step = (body: Body, index: number): void => {
    const entry = entries[index];

    if (entry === undefined) return;

    body.if(
      inRegion(body, address, entry.base, entry.size),
      (hit) => {
        const scope = asBody(hit);

        scope.writeState(DEFER_WRITE_MODULE, num(scope, entry.index));
        scope.writeState('pc', num(scope, SERVICE_MODULE_WRITE_BASE + entry.index));
        scope.setLocal(diverted, bool(scope, true));
      },
      (next) => step(asBody(next), index + 1),
    );
  };

  step(b, 0);
}

export function readPeripheral(
  b: Body,
  address: Value<number>,
  size: number,
  defer?: DeferRead,
  staticAddress?: number,
): Value<number> {
  if (staticAddress !== undefined) return readStaticPeripheral(b, size, defer, staticAddress);

  const result = b.local(types.number, 0);

  const readTree = (body: Body): void => {
    body.if(
      inRegion(body, address, RCC_BASE, 0x400),
      (rcc) => {
        const body = asBody(rcc);

        rcc.setLocal(result, readRcc(body, body.subtract(address, num(body, RCC_BASE)), size));
      },
      (other) => {
        const body = asBody(other);

        body.if(
          inRegion(body, address, GPIO_BASE, 0x2000),
          (gpio) => {
            gpio.setLocal(result, readGpio(asBody(gpio), address, size, defer));
          },
          (rest) => {
            const inner = asBody(rest);
            const [first, second, third] = USARTS;

            inner.if(
              inRegion(inner, address, USART1_BASE, 0x400),
              (hit) => {
                const body2 = asBody(hit);

                body2.setLocal(
                  result,
                  readUsart(body2, first!, body2.subtract(address, num(body2, USART1_BASE)), size),
                );
              },
              (u2) => {
                const body2 = asBody(u2);

                body2.if(
                  inRegion(body2, address, USART2_BASE, 0x400),
                  (hit) => {
                    const body3 = asBody(hit);

                    body3.setLocal(
                      result,
                      readUsart(
                        body3,
                        second!,
                        body3.subtract(address, num(body3, USART2_BASE)),
                        size,
                      ),
                    );
                  },
                  (u3) => {
                    const body3 = asBody(u3);

                    body3.if(
                      inRegion(body3, address, USART3_BASE, 0x400),
                      (hit) => {
                        const body4 = asBody(hit);

                        body4.setLocal(
                          result,
                          readUsart(
                            body4,
                            third!,
                            body4.subtract(address, num(body4, USART3_BASE)),
                            size,
                          ),
                        );
                      },
                      (tail) => {
                        const body4 = asBody(tail);

                        body4.if(
                          inRegion(body4, address, FLASH_BASE_REGISTER, 0x400),
                          (hit) => {
                            const body5 = asBody(hit);

                            body5.setLocal(
                              result,
                              readRegisterFile(
                                body5,
                                body5.subtract(address, num(body5, FLASH_BASE_REGISTER)),
                                size,
                                0x700,
                              ),
                            );
                          },
                          (pwrRegion) => {
                            const body5 = asBody(pwrRegion);

                            body5.if(
                              inRegion(body5, address, PWR_BASE, 0x400),
                              (hit) => {
                                const body6 = asBody(hit);

                                body6.setLocal(
                                  result,
                                  readPwr(
                                    body6,
                                    body6.subtract(address, num(body6, PWR_BASE)),
                                    size,
                                  ),
                                );
                              },
                              (generic) => {
                                const body6 = asBody(generic);

                                body6.if(
                                  inRegion(
                                    body6,
                                    address,
                                    PERIPHERAL_BASE,
                                    PERIPHERAL_END - PERIPHERAL_BASE,
                                  ),
                                  (hit) => {
                                    const body7 = asBody(hit);
                                    const slot = genericSlot(body7, address);
                                    const tagOffset = body7.shiftLeft(slot, num(body7, 3));
                                    const valueOffset = body7.add(tagOffset, num(body7, 4));
                                    const tag = body7.bitAnd(address, num(body7, 0xfffffffc));
                                    const storedTag = readWord(body7, GENERIC, tagOffset);
                                    const stored = readWord(body7, GENERIC, valueOffset);
                                    const current = body7.select(
                                      types.number,
                                      body7.equal(types.number, storedTag, tag),
                                      () => stored,
                                      (miss) => miss.constant(types.number, 0),
                                    );

                                    body7.setLocal(
                                      result,
                                      extract(
                                        body7,
                                        current,
                                        body7.add(
                                          valueOffset,
                                          body7.bitAnd(address, num(body7, 3)),
                                        ),
                                        size,
                                      ),
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
  };

  if (defer !== undefined && machine().peripherals.length > 0) {
    const diverted = b.local(types.bool, false);

    deferModuleRead(b, address, size, defer, diverted);
    b.if(
      b.getLocal(diverted),
      () => {},
      (normal) => {
        readTree(asBody(normal));
      },
    );
  } else readTree(b);

  return b.getLocal(result);
}

export function writePeripheral(
  b: Body,
  address: Value<number>,
  size: AccessSize,
  value: Value<number>,
  defer = false,
  staticAddress?: number,
  staticValue?: number,
): void {
  if (staticAddress !== undefined) {
    writeStaticPeripheral(b, address, size, value, defer, staticAddress, staticValue);

    return;
  }

  if (defer) {
    // GPIO 写必须立即登记：同一块的 tick 要把 PC 转给该端口的服务块。其余外设
    // 寄存器的读改写链只在服务块里展开一次，块内只登记地址、宽度与值。
    b.if(
      inRegion(b, address, GPIO_BASE, 0x2000),
      (gpio) => {
        const scope = asBody(gpio);

        scope.if(scope.lessThan(gpioPortOf(scope, address), num(scope, 5)), (hit) => {
          deferGpioWrite(asBody(hit), address, size, value);
        });
      },
      (other) => registerDeferredWrite(asBody(other), address, size, value),
    );

    return;
  }

  b.if(
    inRegion(b, address, RCC_BASE, 0x400),
    (rcc) => {
      const body = asBody(rcc);

      writeRcc(body, body.subtract(address, num(body, RCC_BASE)), size, value);
    },
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, GPIO_BASE, 0x2000),
        (gpio) => {
          // GPIO 写的端口分支与引脚意图都很大：这里只登记这次写，由服务块执行。
          // 端口 5–7 在本器件上没有对应 GPIOx，直接忽略（与写未映射地址一致）。
          const scope = asBody(gpio);

          scope.if(scope.lessThan(gpioPortOf(scope, address), num(scope, 5)), (hit) => {
            queueGpioWrite(asBody(hit), address, size, value);
          });
        },
        (rest) => {
          const inner = asBody(rest);
          const [first, second, third] = USARTS;

          inner.if(
            inRegion(inner, address, USART1_BASE, 0x400),
            (hit) => {
              const body2 = asBody(hit);

              writeUsart(
                body2,
                first!,
                body2.subtract(address, num(body2, USART1_BASE)),
                size,
                value,
              );
            },
            (u2) => {
              const body2 = asBody(u2);

              body2.if(
                inRegion(body2, address, USART2_BASE, 0x400),
                (hit) => {
                  const body3 = asBody(hit);

                  writeUsart(
                    body3,
                    second!,
                    body3.subtract(address, num(body3, USART2_BASE)),
                    size,
                    value,
                  );
                },
                (u3) => {
                  const body3 = asBody(u3);

                  body3.if(
                    inRegion(body3, address, USART3_BASE, 0x400),
                    (hit) => {
                      const body4 = asBody(hit);

                      writeUsart(
                        body4,
                        third!,
                        body4.subtract(address, num(body4, USART3_BASE)),
                        size,
                        value,
                      );
                    },
                    (tail) => {
                      const body4 = asBody(tail);

                      body4.if(
                        inRegion(body4, address, FLASH_BASE_REGISTER, 0x400),
                        (hit) => {
                          const body5 = asBody(hit);

                          writeRegisterFile(
                            body5,
                            body5.subtract(address, num(body5, FLASH_BASE_REGISTER)),
                            size,
                            value,
                            0x700,
                          );
                        },
                        (pwrRegion) => {
                          const body5 = asBody(pwrRegion);

                          body5.if(
                            inRegion(body5, address, PWR_BASE, 0x400),
                            (hit) => {
                              const body6 = asBody(hit);

                              writeRegisterFile(
                                body6,
                                body6.subtract(address, num(body6, PWR_BASE)),
                                size,
                                value,
                                0x740,
                              );
                            },
                            (generic) => {
                              const body6 = asBody(generic);

                              body6.if(
                                inRegion(
                                  body6,
                                  address,
                                  PERIPHERAL_BASE,
                                  PERIPHERAL_END - PERIPHERAL_BASE,
                                ),
                                (hit) => {
                                  const body7 = asBody(hit);
                                  const slot = genericSlot(body7, address);
                                  const tagOffset = body7.shiftLeft(slot, num(body7, 3));
                                  const valueOffset = body7.add(tagOffset, num(body7, 4));
                                  const tag = body7.bitAnd(address, num(body7, 0xfffffffc));
                                  const storedTag = readWord(body7, GENERIC, tagOffset);
                                  const stored = readWord(body7, GENERIC, valueOffset);
                                  const current = body7.select(
                                    types.number,
                                    body7.equal(types.number, storedTag, tag),
                                    () => stored,
                                    (miss) => miss.constant(types.number, 0),
                                  );
                                  const offset = body7.add(
                                    valueOffset,
                                    body7.bitAnd(address, num(body7, 3)),
                                  );

                                  writeWord(body7, GENERIC, tagOffset, tag);
                                  writeWord(
                                    body7,
                                    GENERIC,
                                    valueOffset,
                                    merge(body7, current, value, offset, size),
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

/** 核心外设写服务块的窄入口；都接收编译期宽度。 */
export function writeRccAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRcc(b, b.subtract(address, num(b, RCC_BASE)), size, value);
  // RCC 写入可能在同一次 runUntil 内改变 HCLK。这里把新的周期耗时落到
  // `cpuCyclePs`，并重算 SysTick/USART 的服务粒度；后续指令块运行期读取该状态。
  refreshCpuClock(b);
  if (machine().dynamicClock === true) refreshTick(b);
}

export function writeUsartAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const [first, second, third] = USARTS;
  const writeOne = (body: Body, config: (typeof USARTS)[number], base: number): void => {
    writeUsart(body, config, body.subtract(address, num(body, base)), size, value);
  };

  b.if(
    inRegion(b, address, USART1_BASE, 0x400),
    (hit) => writeOne(asBody(hit), first!, USART1_BASE),
    (other) => {
      const body = asBody(other);

      body.if(
        inRegion(body, address, USART2_BASE, 0x400),
        (hit) => writeOne(asBody(hit), second!, USART2_BASE),
        (thirdBody) => {
          const scope = asBody(thirdBody);

          scope.if(inRegion(scope, address, USART3_BASE, 0x400), (hit) =>
            writeOne(asBody(hit), third!, USART3_BASE),
          );
        },
      );
    },
  );
}

export function writeFlashRegisterAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRegisterFile(b, b.subtract(address, num(b, FLASH_BASE_REGISTER)), size, value, 0x700);
}

export function writePwrRegisterAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeRegisterFile(b, b.subtract(address, num(b, PWR_BASE)), size, value, 0x740);
}

export function writeGenericRegisterAt(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const slot = genericSlot(b, address);
  const tagOffset = b.shiftLeft(slot, num(b, 3));
  const valueOffset = b.add(tagOffset, num(b, 4));
  const tag = b.bitAnd(address, num(b, 0xfffffffc));
  const storedTag = readWord(b, GENERIC, tagOffset);
  const stored = readWord(b, GENERIC, valueOffset);
  const current = b.select(
    types.number,
    b.equal(types.number, storedTag, tag),
    () => stored,
    (miss) => miss.constant(types.number, 0),
  );
  const offset = b.add(valueOffset, b.bitAnd(address, num(b, 3)));

  writeWord(b, GENERIC, tagOffset, tag);
  writeWord(b, GENERIC, valueOffset, merge(b, current, value, offset, size));
}

export { USART1_BASE, USART2_BASE, USART3_BASE };
