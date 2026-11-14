import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  DEFER_WRITE,
  DEFER_WRITE_ADDR,
  DEFER_WRITE_SIZE,
  DEFER_WRITE_VALUE,
  FLASH_BASE_REGISTER,
  GPIO_BASE,
  PERIPHERAL_BASE,
  PERIPHERAL_END,
  PERIPH,
  PWR_BASE,
  RCC_BASE,
  SERVICE_DEFER_WRITE,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
} from './layout';
import type { AccessSize } from './layout';
import {
  asBody,
  bool,
  markService,
  num,
  readWord,
  readWordAt,
  u32,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { deferGpioWrite, gpioPortOf, queueGpioWrite, readGpio, readGpioPort } from './gpio';
import type { DeferRead } from './memory';
import { readPwr } from './pwr';
import { readRcc, writeRcc } from './rcc';
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

const GENERIC_STATE = 0x800;

/** `u32(address - base) < size`。 */
const inRegion = (b: Body, address: Value<number>, base: number, size: number): Value<boolean> =>
  b.lessThan(u32(b, b.subtract(address, num(b, base))), num(b, size));

function genericOffset(b: Body, address: Value<number>): Value<number> {
  return b.shiftLeft(
    b.bitAnd(
      b.shiftRightUnsigned(b.subtract(address, num(b, PERIPHERAL_BASE)), num(b, 2)),
      num(b, 0xff),
    ),
    num(b, 2),
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

  if (inStaticRegion(staticAddress, FLASH_BASE_REGISTER, 0x400))
    return readRegisterFileAt(b, staticAddress - FLASH_BASE_REGISTER, size, 0x700);

  if (inStaticRegion(staticAddress, PWR_BASE, 0x400))
    return readPwr(b, num(b, staticAddress - PWR_BASE), size);

  if (inStaticRegion(staticAddress, PERIPHERAL_BASE, PERIPHERAL_END - PERIPHERAL_BASE))
    return readRegisterFileAt(b, staticAddress - PERIPHERAL_BASE, size, GENERIC_STATE);

  return num(b, 0);
}

function registerDeferredWrite(
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
    writeRegisterFileAt(b, staticAddress - PERIPHERAL_BASE, size, value, GENERIC_STATE);
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

  b.if(
    inRegion(b, address, RCC_BASE, 0x400),
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
                                readPwr(body6, body6.subtract(address, num(body6, PWR_BASE)), size),
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

                                  body7.setLocal(
                                    result,
                                    readRegisterFile(
                                      body7,
                                      genericOffset(body7, address),
                                      size,
                                      GENERIC_STATE,
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

                                  writeRegisterFile(
                                    body7,
                                    genericOffset(body7, address),
                                    size,
                                    value,
                                    GENERIC_STATE,
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

export { USART1_BASE, USART2_BASE, USART3_BASE };
