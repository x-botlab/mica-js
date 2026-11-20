import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import {
  CLOCK_CACHE,
  CLOCK_FLAG_HSI_OFF,
  RESET_FLAGS_DEFAULT,
  RCC_AHB1RSTR,
  RCC_AHB2RSTR,
  RCC_APB1RSTR1,
  RCC_APB1RSTR2,
  RCC_APB2RSTR,
  RCC_BDCR,
  RCC_CCIPR,
  RCC_CFGR,
  RCC_CR,
  RCC_CRRCR,
  RCC_CSR,
  RCC_PLLCFGR,
  clockSources,
  hsiClockOn,
  updateClockTree,
} from './clock-tree';
import {
  FLASH_STATE_MEMORY,
  FLASH_STATE_SIZE,
  GPIO_STATE,
  GPIO_STATE_STRIDE,
  GPIO_SYNC,
  PERIPH,
  SERVICE_PIN_SYNC,
  SYS,
  RCC_RCC_STATE,
  TX_MASK,
  USART_STATE,
  USART_STATE_STRIDE,
  txState,
  gpioAfr0State,
  gpioAfr1State,
  gpioLockState,
  gpioLockStepState,
  gpioModerState,
  gpioOdrState,
  gpioOtyperState,
  gpioPupdrState,
} from './layout';
import {
  asBody,
  bool,
  boolAnd,
  boolBitAt,
  boolOr,
  markService,
  num,
  readWord,
  readWordAt,
  u32,
  writeWord,
  writeWordAt,
} from './ir';
import type { Body } from './ir';
import { machine } from './machine';
import { PWR_REGISTERS } from './pwr';
import { RESET_CAUSE, RESET_COUNT } from './system-layout';
import { USARTS } from './usart';
import {
  USART_EXT_TX_STATE,
  USART_EXT_TX_STRIDE,
  USART_RX_STATE,
  USART_RX_STRIDE,
} from './usart-layout';
import { refreshTick } from './tick';

/**
 * RCC 寄存器模型（RM0440 第 5 章）。
 *
 * - CR 的 ready 位由时钟源状态合成：HSION 缺省为 1（复位值），HSE 只有在机器
 *   提供 `hseFrequency` 时才可能 ready，PLLRDY 需要合法且锁定的 PLL 配置；
 * - CFGR.SWS 由「请求源已就绪」决定：目标未就绪时保持当前源，之后目标就绪时
 *   在下一次 RCC 写入后切换；
 * - CFGR 的 AHB/APB 分频、CCIPR 的 USART/I2C/ADC/RTC 选择在每次时钟写入后由
 *   `clock-tree.ts` 重算并缓存，指令块不参与；
 * - 时钟使能位与复位位原样保存；复位位 0→1 时同步执行已建模外设的状态复位
 *   （GPIO/USART/PWR/FLASH），使复位 hook 可观察，而不是只保存寄存器值；
 * - 未建模的总线门控（寄存器访问是否被时钟关闭屏蔽）仍由 `bus.ts` 决定。
 *
 * CR 与 CFGR 是「读值经过合成」的寄存器；缓存/控制字位于 RCC 窗口 0xA0–0xFF，
 * 与小节的 `CLOCK_CACHE` 对应。
 */

/**
 * RCC 寄存器可见位图（每 4 字节一位，0x00..0xA0 共 40 位）。保留偏移与
 * CLOCK_CACHE（0xA0–0xFF）都读 0、写忽略；绝不对地址做 0x100 取模别名。
 */
const RCC_REGISTER_MASK_LOW = 0xddddddcf;
const RCC_REGISTER_MASK_HIGH = 0x000000f5;
const RCC_REGISTER_WORDS = 40;

const HSI_ON = 1 << 8;
const HSI_RDY = 1 << 10;
const HSE_RDY = 1 << 17;
const PLL_RDY = 1 << 25;
const SWS_MASK = 0x0c;
const LSERDY = 1 << 1;
const BDRST = 1 << 16;
const RMVF = 1 << 23;
const LSIRDY = 1 << 1;
const HSI48RDY = 1 << 1;

/** CSR 的复位源只读位：OBLRSTF..LPWRRSTF（bit25..31）。 */
const CSR_RESET_FLAGS = 0xfe000000;
export const RCC_CSR_OBLRSTF = 1 << 25;
export const RCC_CSR_PINRSTF = 1 << 26;
export const RCC_CSR_BORRSTF = 1 << 27;
export const RCC_CSR_SFTRSTF = 1 << 28;
export const RCC_CSR_IWDGRSTF = 1 << 29;
export const RCC_CSR_WWDGRSTF = 1 << 30;
export const RCC_CSR_LPWRRSTF = 0x80000000;
const RESET_FLAG_OBL = RCC_CSR_OBLRSTF;
const RESET_FLAG_PIN = RCC_CSR_PINRSTF;
const RESET_FLAG_BOR = RCC_CSR_BORRSTF;
const RESET_FLAG_SFT = RCC_CSR_SFTRSTF;
const RESET_FLAG_IWDG = RCC_CSR_IWDGRSTF;
const RESET_FLAG_WWDG = RCC_CSR_WWDGRSTF;
const RESET_FLAG_LPWR = RCC_CSR_LPWRRSTF;

/**
 * RCC_CSR 复位标志的持久化位置（`sys` 内，和 reset owner 的 RESET_CAUSE/COUNT 相邻）。
 * reset owner 应在清空 SYS 后调用 `recordRccResetFlags`，或保留这两个字，才能跨多次
 * 复位累计标志。0x14 存已累计 flags，0x18 存 RMVF 清除标记（高 bit + reset count）。
 */
export const RCC_RESET_FLAGS_STATE = 0x14;
export const RCC_RESET_FLAGS_CLEARED_STATE = 0x18;
const RESET_FLAGS_CLEARED_BIT = 0x80000000;

/**
 * 复位 cause → RCC_CSR 标志。5=IWDG、6/7=WWDG（与 reset owner 对齐：WWDG 不再
 * 复用 5）；8=BOR/POR、9=LPWR；0 表示未知上电，回退 PIN|BOR。
 */
export function rccResetFlagsForCause(cause: number): number {
  switch (cause) {
    case 1:
      return RESET_FLAG_PIN;
    case 2:
    case 3:
      return RESET_FLAG_SFT;
    case 4:
      return RESET_FLAG_OBL;
    case 5:
      return RESET_FLAG_IWDG;
    case 6:
    case 7:
      return RESET_FLAG_WWDG;
    case 8:
      return RESET_FLAG_BOR;
    case 9:
      return RESET_FLAG_LPWR;
    default:
      return RESET_FLAGS_DEFAULT;
  }
}

function resetFlagsValue(b: Body, cause: Value<number>): Value<number> {
  const values = [
    RESET_FLAGS_DEFAULT,
    RESET_FLAG_PIN,
    RESET_FLAG_SFT,
    RESET_FLAG_SFT,
    RESET_FLAG_OBL,
    RESET_FLAG_IWDG,
    RESET_FLAG_WWDG,
    RESET_FLAG_WWDG,
    RESET_FLAG_BOR,
    RESET_FLAG_LPWR,
  ];
  let result = num(b, 0);

  for (let causeValue = values.length - 1; causeValue >= 0; causeValue -= 1)
    result = b.select(
      types.number,
      b.equal(types.number, cause, num(b, causeValue)),
      (inner) => inner.constant(types.number, values[causeValue]!),
      () => result,
    );

  return result;
}

/**
 * 硬件复位入口调用：把当前 RESET_CAUSE 追加进持久 flags，并清 RMVF 清除标记。
 * 该函数在 `applyReset` 写完 RESET_CAUSE 后调用；若 owner 选择保留 SYS 0x14，
 * 则可跨多次复位累计。
 */
export function recordRccResetFlags(b: Body): void {
  const cause = readWordAt(b, SYS, RESET_CAUSE);
  const flags = readWordAt(b, SYS, RCC_RESET_FLAGS_STATE);

  writeWordAt(b, SYS, RCC_RESET_FLAGS_STATE, b.bitOr(flags, resetFlagsValue(b, cause)));
  writeWordAt(b, SYS, RCC_RESET_FLAGS_CLEARED_STATE, num(b, 0));
}

/**
 * PWR 后备区只从 pwr.ts 的 `PWR_REGISTERS` 读取（当前 0x740）；Flash 控制器已
 * 迁到独立的 `flashState` memory。
 */

/**
 * 外设复位副作用需要 GPIO/PWR 的影子 state 与引脚声明。合成时钟探针只声明
 * RCC/PWR 后备区，可把 `clockResetHooks` 设为 false 跳过这些分支；真实器件
 * 不设置该字段，默认执行。
 */
function resetHooksEnabled(): boolean {
  const current = machine() as ReturnType<typeof machine> & {
    readonly clockResetHooks?: boolean;
  };

  return current.clockResetHooks !== false;
}

const loadCache = (b: Body, offset: number): Value<number> =>
  readWordAt(b, PERIPH, RCC_RCC_STATE + offset);

const extract = (
  b: Body,
  word: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> => {
  if (size === 4) return word;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(word, shift), num(b, size === 2 ? 0xffff : 0xff));
};

function visibleRccRegister(b: Body, wordOffset: Value<number>): Value<boolean> {
  const index = b.shiftRightUnsigned(wordOffset, num(b, 2));
  const low = num(b, RCC_REGISTER_MASK_LOW);
  const high = num(b, RCC_REGISTER_MASK_HIGH);
  const mask = b.select(
    types.number,
    b.lessThan(index, num(b, 32)),
    () => low,
    () => high,
  );
  const bit = b.bitAnd(b.shiftRightUnsigned(mask, b.bitAnd(index, num(b, 31))), num(b, 1));

  return boolAnd(
    b,
    b.lessThan(index, num(b, RCC_REGISTER_WORDS)),
    b.notEqual(types.number, bit, num(b, 0)),
  );
}

/** 读一次 RCC 字：CR/CFGR/BDCR/CSR/CRRCR 合成，保留地址读 0。 */
export function readRcc(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);
  const sources = clockSources();

  b.if(visibleRccRegister(b, wordOffset), (inside) => {
    const scope = asBody(inside);
    const stored = readWord(scope, PERIPH, scope.add(num(scope, RCC_RCC_STATE), wordOffset));

    scope.if(
      scope.equal(types.number, wordOffset, num(scope, RCC_CR)),
      (cr) => {
        const body = asBody(cr);
        const flags = loadCache(body, CLOCK_CACHE.control);
        const sws = loadCache(body, CLOCK_CACHE.sws);
        const pll = readWordAt(body, PERIPH, RCC_RCC_STATE + RCC_PLLCFGR);
        const hsiReady = hsiClockOn(body, stored, flags, sws, pll);
        const hseReady = boolAnd(body, boolBitAt(body, stored, 16), bool(body, sources.hseHz > 0));
        // PLL 的锁定状态在 RCC 写入时已经算进缓存；读 CR 不再展开整棵 PLL 算术，
        // 否则 HAL 的 CR 轮询会让每个指令块都背着 VCO 计算。
        const pllVco = loadCache(body, CLOCK_CACHE.pllVcoHz);
        const locked = boolAnd(
          body,
          boolBitAt(body, stored, 24),
          body.notEqual(types.number, pllVco, num(body, 0)),
        );
        const cleaned = body.bitAnd(stored, num(body, ~(HSI_ON | HSI_RDY | HSE_RDY | PLL_RDY)));
        const hsiBits = body.select(
          types.number,
          hsiReady,
          (inner) => inner.constant(types.number, HSI_ON | HSI_RDY),
          (inner) => inner.constant(types.number, 0),
        );
        const hseBits = body.select(
          types.number,
          hseReady,
          (inner) => inner.constant(types.number, HSE_RDY),
          (inner) => inner.constant(types.number, 0),
        );
        const pllBits = body.select(
          types.number,
          locked,
          (inner) => inner.constant(types.number, PLL_RDY),
          (inner) => inner.constant(types.number, 0),
        );

        body.setLocal(
          result,
          body.bitOr(body.bitOr(cleaned, hsiBits), body.bitOr(hseBits, pllBits)),
        );
      },
      (next) => {
        const body = asBody(next);

        body.if(
          body.equal(types.number, wordOffset, num(body, RCC_CFGR)),
          (cfgr) => {
            const inner = asBody(cfgr);
            const sws = loadCache(inner, CLOCK_CACHE.sws);

            inner.setLocal(
              result,
              inner.bitOr(
                inner.bitAnd(stored, inner.constant(types.number, ~SWS_MASK)),
                inner.shiftLeft(sws, inner.constant(types.number, 2)),
              ),
            );
          },
          (third) => {
            const body2 = asBody(third);

            body2.if(
              body2.equal(types.number, wordOffset, num(body2, RCC_BDCR)),
              (bdcr) => {
                const inner = asBody(bdcr);
                const lseReady = boolAnd(
                  inner,
                  boolBitAt(inner, stored, 0),
                  bool(inner, sources.lseHz > 0),
                );
                const readyBits = inner.select(
                  types.number,
                  lseReady,
                  (yes) => yes.constant(types.number, LSERDY),
                  (no) => no.constant(types.number, 0),
                );

                inner.setLocal(
                  result,
                  inner.bitOr(
                    inner.bitAnd(stored, inner.constant(types.number, ~(LSERDY | BDRST))),
                    readyBits,
                  ),
                );
              },
              (fourth) => {
                const body3 = asBody(fourth);

                body3.if(
                  body3.equal(types.number, wordOffset, num(body3, RCC_CSR)),
                  (csr) => {
                    const inner = asBody(csr);
                    const cause = readWordAt(inner, SYS, RESET_CAUSE);
                    const persisted = readWordAt(inner, SYS, RCC_RESET_FLAGS_STATE);
                    const marker = readWordAt(inner, SYS, RCC_RESET_FLAGS_CLEARED_STATE);
                    const count = readWordAt(inner, SYS, RESET_COUNT);
                    const markerCount = inner.bitAnd(
                      marker,
                      inner.constant(types.number, ~RESET_FLAGS_CLEARED_BIT),
                    );
                    const cleared = boolAnd(
                      inner,
                      boolBitAt(inner, marker, 31),
                      inner.equal(types.number, markerCount, count),
                    );
                    const derived = resetFlagsValue(inner, cause);
                    const combined = inner.bitOr(persisted, derived);
                    const resetFlags = inner.select(
                      types.number,
                      cleared,
                      (yes) => yes.constant(types.number, 0),
                      () => combined,
                    );
                    const lsiReady = inner.select(
                      types.number,
                      boolBitAt(inner, stored, 0),
                      (yes) => yes.constant(types.number, LSIRDY),
                      (no) => no.constant(types.number, 0),
                    );

                    inner.setLocal(
                      result,
                      inner.bitOr(
                        inner.bitAnd(
                          stored,
                          inner.constant(types.number, ~(LSIRDY | RMVF | CSR_RESET_FLAGS)),
                        ),
                        inner.bitOr(resetFlags, lsiReady),
                      ),
                    );
                  },
                  (fifth) => {
                    const body4 = asBody(fifth);

                    body4.if(
                      body4.equal(types.number, wordOffset, num(body4, RCC_CRRCR)),
                      (crrcr) => {
                        const inner = asBody(crrcr);
                        const ready = inner.select(
                          types.number,
                          boolBitAt(inner, stored, 0),
                          (yes) => yes.constant(types.number, HSI48RDY),
                          (no) => no.constant(types.number, 0),
                        );

                        inner.setLocal(
                          result,
                          inner.bitOr(
                            inner.bitAnd(stored, inner.constant(types.number, ~HSI48RDY)),
                            ready,
                          ),
                        );
                      },
                      (plain) => plain.setLocal(result, stored),
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  });

  return extract(b, b.getLocal(result), offset, size);
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

/** 冷路径清寄存器块：运行期循环，IR 体积与块大小无关。 */
function clearRegisters(b: Body, base: number, size: number): void {
  const offset = b.local(types.number, 0);

  b.while(
    (test) => {
      const scope = asBody(test);

      return scope.lessThan(scope.getLocal(offset), num(scope, size));
    },
    (body) => {
      const scope = asBody(body);

      writeWord(scope, PERIPH, scope.add(num(scope, base), scope.getLocal(offset)), num(scope, 0));
      scope.setLocal(offset, scope.add(scope.getLocal(offset), num(scope, 4)));
    },
  );
}

function clearMemory(b: Body, memory: string, size: number): void {
  const offset = b.local(types.number, 0);

  b.while(
    (test) => {
      const scope = asBody(test);

      return scope.lessThan(scope.getLocal(offset), num(scope, size));
    },
    (body) => {
      const scope = asBody(body);

      writeWord(scope, memory, scope.getLocal(offset), num(scope, 0));
      scope.setLocal(offset, scope.add(scope.getLocal(offset), num(scope, 4)));
    },
  );
}

/** 只登记端口刷新；真正的引脚意图在紧随其后的 SERVICE_SYNC 里生成。 */
function markPortSync(b: Body, mask: number): void {
  b.writeState(GPIO_SYNC, b.bitOr(b.readState(GPIO_SYNC, types.number), num(b, mask)));
  markService(b, SERVICE_PIN_SYNC);
}

function resetGpioPort(b: Body, port: number): void {
  clearRegisters(b, GPIO_STATE + port * GPIO_STATE_STRIDE, 0x40);
  b.writeState(gpioModerState(port), num(b, 0));
  b.writeState(gpioOtyperState(port), num(b, 0));
  b.writeState(gpioPupdrState(port), num(b, 0));
  b.writeState(gpioAfr0State(port), num(b, 0));
  b.writeState(gpioAfr1State(port), num(b, 0));
  b.writeState(gpioOdrState(port), num(b, 0));
  b.writeState(gpioLockState(port), num(b, 0));
  b.writeState(gpioLockStepState(port), num(b, 0));
  markPortSync(b, 1 << port);
}

function resetUsart(b: Body, index: number): void {
  const config = USARTS[index - 1];

  if (config === undefined) return;

  clearRegisters(b, USART_STATE + (index - 1) * USART_STATE_STRIDE, 0x40);
  clearRegisters(b, USART_RX_STATE + (index - 1) * USART_RX_STRIDE, 0x20);
  if (index <= 3) {
    b.writeState(txState(index, 'Active'), num(b, 0));
    b.writeState(txState(index, 'Remaining'), num(b, 0));
    b.writeState(txState(index, 'Queue'), num(b, 0));
    b.writeState(txState(index, 'Count'), num(b, 0));
    b.writeState(txState(index, 'Period'), num(b, 1));
    b.writeState(txState(index, 'Publish'), num(b, -1));
  } else {
    clearRegisters(b, USART_EXT_TX_STATE + (index - 4) * USART_EXT_TX_STRIDE, 0x20);
  }
  b.writeState(TX_MASK, b.bitAnd(b.readState(TX_MASK, types.number), num(b, ~(1 << (index - 1)))));

  let mask = 0;

  for (const pin of config.txPins) mask |= 1 << pin.port;
  markPortSync(b, mask);
}

const rising = (
  b: Body,
  next: Value<number>,
  previous: Value<number>,
  bitIndex: number,
): Value<boolean> =>
  boolAnd(b, boolBitAt(b, next, bitIndex), b.not(boolBitAt(b, previous, bitIndex)));

/** RSTR 位 0→1 时执行已建模外设的状态复位。 */
function applyResetEffects(
  b: Body,
  wordOffset: Value<number>,
  previous: Value<number>,
  next: Value<number>,
): void {
  const usartReset = b.local(types.bool, false);

  b.if(b.equal(types.number, wordOffset, num(b, RCC_AHB1RSTR)), (ahb1) => {
    const scope = asBody(ahb1);

    scope.if(rising(scope, next, previous, 8), (flash) => {
      clearMemory(asBody(flash), FLASH_STATE_MEMORY, FLASH_STATE_SIZE);
    });
  });

  b.if(b.equal(types.number, wordOffset, num(b, RCC_AHB2RSTR)), (ahb2) => {
    const scope = asBody(ahb2);

    for (const [bitIndex, port] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [5, 4],
    ] as const) {
      scope.if(rising(scope, next, previous, bitIndex), (portReset) => {
        resetGpioPort(asBody(portReset), port);
      });
    }
  });

  b.if(b.equal(types.number, wordOffset, num(b, RCC_APB1RSTR1)), (apb1) => {
    const scope = asBody(apb1);

    scope.if(rising(scope, next, previous, 17), (usart2) => {
      const inner = asBody(usart2);

      resetUsart(inner, 2);
      inner.setLocal(usartReset, bool(inner, true));
    });
    scope.if(rising(scope, next, previous, 18), (usart3) => {
      const inner = asBody(usart3);

      resetUsart(inner, 3);
      inner.setLocal(usartReset, bool(inner, true));
    });
    scope.if(rising(scope, next, previous, 19), (uart4) => {
      const inner = asBody(uart4);

      resetUsart(inner, 4);
      inner.setLocal(usartReset, bool(inner, true));
    });
    scope.if(rising(scope, next, previous, 28), (pwr) => {
      clearRegisters(asBody(pwr), PWR_REGISTERS, 0x80);
    });
  });

  b.if(b.equal(types.number, wordOffset, num(b, RCC_APB1RSTR2)), (apb1b) => {
    const scope = asBody(apb1b);

    scope.if(rising(scope, next, previous, 0), (lpuart1) => {
      const inner = asBody(lpuart1);

      resetUsart(inner, 5);
      inner.setLocal(usartReset, bool(inner, true));
    });
  });

  b.if(b.equal(types.number, wordOffset, num(b, RCC_APB2RSTR)), (apb2) => {
    const scope = asBody(apb2);

    scope.if(rising(scope, next, previous, 14), (usart1) => {
      const inner = asBody(usart1);

      resetUsart(inner, 1);
      inner.setLocal(usartReset, bool(inner, true));
    });
  });

  b.if(b.getLocal(usartReset), (usart) => refreshTick(asBody(usart)));
}

function writeRegister(
  b: Body,
  wordOffset: Value<number>,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const at = b.add(num(b, RCC_RCC_STATE), wordOffset);
  const current = readWord(b, PERIPH, at);
  const merged = merge(b, current, value, offset, size);
  const next = b.local(types.number, merged);

  // CR：HSION 的复位缺省由控制字保存；显式写 1 时清除「软件关闭」标志。
  b.if(b.equal(types.number, wordOffset, num(b, RCC_CR)), (cr) => {
    const scope = asBody(cr);
    const flags = loadCache(scope, CLOCK_CACHE.control);
    const cleared = scope.bitAnd(flags, scope.constant(types.number, ~CLOCK_FLAG_HSI_OFF));
    const disabled = scope.bitOr(flags, scope.constant(types.number, CLOCK_FLAG_HSI_OFF));

    writeWordAt(
      scope,
      PERIPH,
      RCC_RCC_STATE + CLOCK_CACHE.control,
      scope.select(
        types.number,
        boolBitAt(scope, merged, 8),
        () => cleared,
        () => disabled,
      ),
    );
  });

  // BDCR.BDRST 自清，并复位备份域（LSE/RTC 选择与 RTCEN）。
  b.if(b.equal(types.number, wordOffset, num(b, RCC_BDCR)), (bdcr) => {
    const scope = asBody(bdcr);

    scope.if(boolBitAt(scope, merged, 16), (reset) => {
      asBody(reset).setLocal(next, asBody(reset).bitAnd(merged, num(asBody(reset), ~0x1ffff)));
    });
  });

  // CSR 的复位源位只读；RMVF 自清并清除持久 flags。
  b.if(b.equal(types.number, wordOffset, num(b, RCC_CSR)), (csr) => {
    const scope = asBody(csr);

    scope.setLocal(
      next,
      scope.bitAnd(merged, scope.constant(types.number, ~(RMVF | CSR_RESET_FLAGS))),
    );
    scope.if(boolBitAt(scope, merged, 23), (clear) => {
      const inner = asBody(clear);
      const count = readWordAt(inner, SYS, RESET_COUNT);

      writeWordAt(inner, SYS, RCC_RESET_FLAGS_STATE, num(inner, 0));
      writeWordAt(
        inner,
        SYS,
        RCC_RESET_FLAGS_CLEARED_STATE,
        inner.bitOr(inner.constant(types.number, RESET_FLAGS_CLEARED_BIT), count),
      );
    });
  });

  writeWord(b, PERIPH, at, b.getLocal(next));

  const written = b.getLocal(next);

  if (resetHooksEnabled()) applyResetEffects(b, wordOffset, current, written);

  const clockChanged = boolOr(
    b,
    boolOr(
      b,
      b.equal(types.number, wordOffset, num(b, RCC_CR)),
      b.equal(types.number, wordOffset, num(b, RCC_CFGR)),
    ),
    boolOr(
      b,
      boolOr(
        b,
        b.equal(types.number, wordOffset, num(b, RCC_PLLCFGR)),
        b.equal(types.number, wordOffset, num(b, RCC_CCIPR)),
      ),
      boolOr(
        b,
        boolOr(
          b,
          b.equal(types.number, wordOffset, num(b, RCC_BDCR)),
          b.equal(types.number, wordOffset, num(b, RCC_CSR)),
        ),
        b.equal(types.number, wordOffset, num(b, RCC_CRRCR)),
      ),
    ),
  );

  b.if(clockChanged, (changed) => updateClockTree(asBody(changed), true));
}

export function writeRcc(b: Body, offset: Value<number>, size: number, value: Value<number>): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  b.if(visibleRccRegister(b, wordOffset), (register) => {
    writeRegister(asBody(register), wordOffset, offset, size, value);
  });
}
