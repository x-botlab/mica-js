import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  FLASH_BASE_REGISTER,
  GPIO_BASE,
  GPIO_WRITE,
  GPIO_WRITE_ADDR,
  GPIO_WRITE_SIZE,
  GPIO_WRITE_VALUE,
  PERIPHERAL_BASE,
  PERIPHERAL_END,
  PERIPH,
  PWR_BASE,
  RCC_BASE,
  USART1_BASE,
  USART2_BASE,
  USART3_BASE,
} from './layout';
import { asBody, num, readWord, u32, writeWord } from './ir';
import type { Body } from './ir';
import { gpioPortOf, readGpio } from './gpio';
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

export function readPeripheral(b: Body, address: Value<number>, size: number): Value<number> {
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
          gpio.setLocal(result, readGpio(asBody(gpio), address, size));
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
                                readRegisterFile(
                                  body6,
                                  body6.subtract(address, num(body6, PWR_BASE)),
                                  size,
                                  0x740,
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
  size: number,
  value: Value<number>,
): void {
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
            const inner = asBody(hit);

            inner.writeState(GPIO_WRITE_ADDR, u32(inner, address));
            inner.writeState(GPIO_WRITE_VALUE, u32(inner, value));
            inner.writeState(GPIO_WRITE_SIZE, num(inner, size));
            inner.writeState(GPIO_WRITE, num(inner, 1));
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
