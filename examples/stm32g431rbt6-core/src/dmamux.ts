import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { DMA } from './layout';
import type { PeripheralModule } from './peripheral';
import {
  asBody,
  boolAnd,
  boolBitAt,
  boolOr,
  num,
  readWord,
  readWordAt,
  u32,
  writeWord,
} from './ir';
import type { Body } from './ir';

/**
 * STM32G431 的 DMAMUX1。
 *
 * 12 个 DMAMUX 通道分别接 DMA1 CH1–6 与 DMA2 CH1–6。通道寄存器块在 0x00–0x14
 * 与 0x20–0x34 之间，中间两个寄存器位置在 G431 上保留；状态/清零寄存器和四个
 * 请求发生器也按 RM0440 的偏移建模。同步事件本身没有触发源（EXTI/LPTIM 由其它
 * 模块提供），因此本文件只保存同步配置，并提供可注入的溢出标志与中断挂起查询。
 */

export const DMAMUX1_BASE = 0x40020800;
/** DMAMUX 与 DMA1/DMA2 共用中央分配的 `dma` memory；DMAMUX 从 0x200 起。 */
export const DMAMUX_STATE = 0x200;
export const DMAMUX_CHANNELS = 12;
export const DMAMUX_REQUEST_GENERATORS = 4;
export const DMAMUX_IRQ = 94;

const CCR_MASK = 0x1fff037f;
const RGCR_MASK = 0x00ff011f;
const CSR = 0x80;
const CFR = 0x84;
const RGCR_BASE = 0x100;
const RGSR = 0x140;
const RGCFR = 0x144;

/**
 * RM0440 / stm32g4xx_ll_dmamux.h 的请求编号。编号在 STM32G4 系列内稳定；具体
 * 器件支持的外设子集不同，接入方只注册自己真正实现的请求源即可。
 */
export const DMAMUX_REQUESTS = {
  MEM2MEM: 0x00,
  GENERATOR0: 0x01,
  GENERATOR1: 0x02,
  GENERATOR2: 0x03,
  GENERATOR3: 0x04,
  ADC1: 0x05,
  DAC1_CH1: 0x06,
  DAC1_CH2: 0x07,
  TIM6_UP: 0x08,
  TIM7_UP: 0x09,
  SPI1_RX: 0x0a,
  SPI1_TX: 0x0b,
  SPI2_RX: 0x0c,
  SPI2_TX: 0x0d,
  SPI3_RX: 0x0e,
  SPI3_TX: 0x0f,
  I2C1_RX: 0x10,
  I2C1_TX: 0x11,
  I2C2_RX: 0x12,
  I2C2_TX: 0x13,
  I2C3_RX: 0x14,
  I2C3_TX: 0x15,
  USART1_RX: 0x18,
  USART1_TX: 0x19,
  USART2_RX: 0x1a,
  USART2_TX: 0x1b,
  USART3_RX: 0x1c,
  USART3_TX: 0x1d,
  UART4_RX: 0x1e,
  UART4_TX: 0x1f,
  LPUART1_RX: 0x22,
  LPUART1_TX: 0x23,
  ADC2: 0x24,
  TIM1_CH1: 0x2a,
  TIM1_CH2: 0x2b,
  TIM1_CH3: 0x2c,
  TIM1_CH4: 0x2d,
  TIM1_UP: 0x2e,
  TIM1_TRIG: 0x2f,
  TIM1_COM: 0x30,
  TIM2_CH1: 0x38,
  TIM2_CH2: 0x39,
  TIM2_CH3: 0x3a,
  TIM2_CH4: 0x3b,
  TIM2_UP: 0x3c,
  TIM3_CH1: 0x3d,
  TIM3_CH2: 0x3e,
  TIM3_CH3: 0x3f,
  TIM3_CH4: 0x40,
  TIM3_UP: 0x41,
  TIM3_TRIG: 0x42,
  TIM4_CH1: 0x43,
  TIM4_CH2: 0x44,
  TIM4_CH3: 0x45,
  TIM4_CH4: 0x46,
  TIM4_UP: 0x47,
  TIM15_CH1: 0x4e,
  TIM15_UP: 0x4f,
  TIM15_TRIG: 0x50,
  TIM15_COM: 0x51,
  TIM16_CH1: 0x52,
  TIM16_UP: 0x53,
  TIM17_CH1: 0x54,
  TIM17_UP: 0x55,
  CORDIC_READ: 0x70,
  CORDIC_WRITE: 0x71,
  UCPD1_RX: 0x72,
  UCPD1_TX: 0x73,
} as const;

/** DMA1 CH1–6 → DMAMUX 0–5；DMA2 CH1–6 → DMAMUX 6–11。 */
export function dmamuxGlobalChannel(controller: 1 | 2, channel: number): number {
  return controller === 1 ? channel - 1 : 6 + channel - 1;
}

/** G431 的 DMAMUX 通道 6/7 从 0x20 开始，0x18/0x1C 保留。 */
export function dmamuxChannelOffset(channel: number): number {
  return channel < 6 ? channel * 4 : 0x20 + (channel - 6) * 4;
}

function load(b: Body, offset: number): Value<number> {
  return readWordAt(b, DMA, DMAMUX_STATE + offset);
}

function loadAt(b: Body, offset: Value<number>): Value<number> {
  return readWord(b, DMA, b.add(num(b, DMAMUX_STATE), offset));
}

function store(b: Body, offset: number, value: Value<number>): void {
  writeWord(b, DMA, num(b, DMAMUX_STATE + offset), value);
}

function storeAt(b: Body, offset: Value<number>, value: Value<number>): void {
  writeWord(b, DMA, b.add(num(b, DMAMUX_STATE), offset), value);
}

function extract(
  b: Body,
  value: Value<number>,
  offset: Value<number>,
  size: number,
): Value<number> {
  if (size === 4) return value;
  const shift = b.multiply(b.bitAnd(offset, num(b, 3)), num(b, 8));

  return b.bitAnd(b.shiftRightUnsigned(value, shift), num(b, size === 2 ? 0xffff : 0xff));
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

/** DMAMUX 通道控制寄存器中的请求编号；DMA 侧用它选择请求源。 */
export function dmamuxRequestId(b: Body, globalChannel: number | Value<number>): Value<number> {
  const offset =
    typeof globalChannel === 'number'
      ? num(b, dmamuxChannelOffset(globalChannel))
      : b.select(
          types.number,
          b.lessThan(globalChannel, num(b, 6)),
          (inner) => inner.multiply(globalChannel, inner.constant(types.number, 4)),
          (inner) =>
            inner.add(
              inner.constant(types.number, 0x20),
              inner.multiply(inner.subtract(globalChannel, inner.constant(types.number, 6)), inner.constant(types.number, 4)),
            ),
        );

  return b.bitAnd(loadAt(b, offset), num(b, 0x7f));
}

export function readDmamux(b: Body, offset: Value<number>, size: number): Value<number> {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));
  const result = b.local(types.number, 0);

  b.if(
    b.equal(types.number, wordOffset, num(b, CSR)),
    (csr) => csr.setLocal(result, load(asBody(csr), CSR)),
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, RGSR)),
        (rgsr) => rgsr.setLocal(result, load(asBody(rgsr), RGSR)),
        (next) => {
          const scope = asBody(next);

          scope.if(
            scope.lessThan(wordOffset, num(scope, 0x38)),
            (channel) => {
              const body2 = asBody(channel);

              channel.setLocal(result, loadAt(body2, wordOffset));
            },
            (wide) => {
              const body2 = asBody(wide);

              body2.if(
                boolAnd(
                  body2,
                  body2.greaterThanOrEqual(wordOffset, num(body2, RGCR_BASE)),
                  body2.lessThan(wordOffset, num(body2, RGCR_BASE + 0x10)),
                ),
                (rg) => {
                  const body3 = asBody(rg);

                  body3.setLocal(result, loadAt(body3, wordOffset));
                },
              );
            },
          );
        },
      );
    },
  );

  return extract(b, b.getLocal(result), offset, size);
}

export function writeDmamux(
  b: Body,
  offset: Value<number>,
  size: number,
  value: Value<number>,
): void {
  const wordOffset = b.bitAnd(offset, num(b, 0x3fc));

  b.if(
    b.equal(types.number, wordOffset, num(b, CFR)),
    (cfr) => {
      const body = asBody(cfr);
      const current = load(body, CSR);
      const clears = body.bitAnd(u32(body, value), num(body, 0xfff));

      store(body, CSR, body.bitAnd(current, body.bitNot(clears)));
    },
    (other) => {
      const body = asBody(other);

      body.if(
        body.equal(types.number, wordOffset, num(body, RGCFR)),
        (rgcfr) => {
          const scope = asBody(rgcfr);
          const current = load(scope, RGSR);

          store(
            scope,
            RGSR,
            scope.bitAnd(current, scope.bitNot(scope.bitAnd(u32(scope, value), num(scope, 0xf)))),
          );
        },
        (next) => {
          const scope = asBody(next);

          scope.if(
            boolOr(
              scope,
              boolOr(
                scope,
                scope.equal(types.number, wordOffset, num(scope, CSR)),
                scope.equal(types.number, wordOffset, num(scope, RGSR)),
              ),
              boolOr(
                scope,
                scope.equal(types.number, wordOffset, num(scope, CFR)),
                scope.equal(types.number, wordOffset, num(scope, RGCFR)),
              ),
            ),
            () => {},
            (writable) => {
              const inner = asBody(writable);

              inner.if(
                boolOr(
                  inner,
                  inner.lessThan(wordOffset, num(inner, 0x38)),
                  boolAnd(
                    inner,
                    inner.greaterThanOrEqual(wordOffset, num(inner, RGCR_BASE)),
                    inner.lessThan(wordOffset, num(inner, RGCR_BASE + 0x10)),
                  ),
                ),
                (register) => {
                  const body2 = asBody(register);
                  const current = loadAt(body2, wordOffset);
                  const merged = merge(body2, current, value, offset, size);
                  const masked = body2.select(
                    types.number,
                    body2.lessThan(wordOffset, num(body2, 0x38)),
                    (inner2) => inner2.bitAnd(merged, inner2.constant(types.number, CCR_MASK)),
                    (inner2) => inner2.bitAnd(merged, inner2.constant(types.number, RGCR_MASK)),
                  );

                  storeAt(body2, wordOffset, masked);
                },
              );
            },
          );
        },
      );
    },
  );
}

export function setDmamuxOverrun(b: Body, channel: number, overrun = true): void {
  const current = load(b, CSR);
  const mask = 1 << (channel & 31);

  store(b, CSR, overrun ? b.bitOr(current, num(b, mask)) : b.bitAnd(current, num(b, ~mask)));
}

export function setDmamuxRequestGeneratorOverrun(b: Body, generator: number, overrun = true): void {
  const current = load(b, RGSR);
  const mask = 1 << (generator & 31);

  store(b, RGSR, overrun ? b.bitOr(current, num(b, mask)) : b.bitAnd(current, num(b, ~mask)));
}

/** DMAMUX 溢出中断：任一通道 SOFx 且 SOIE，或任一发生器 OFx 且 OIE。 */
export function dmamuxPending(b: Body): Value<boolean> {
  const result = b.local(types.bool, false);
  const status = load(b, CSR);

  for (let channel = 0; channel < DMAMUX_CHANNELS; channel += 1) {
    const ccr = load(b, dmamuxChannelOffset(channel));
    const ready = boolAnd(b, boolBitAt(b, status, channel), boolBitAt(b, ccr, 8));

    b.if(
      ready,
      (hit) => {
        const body = asBody(hit);

        body.setLocal(result, body.constant(types.bool, true));
      },
    );
  }

  const rgStatus = load(b, RGSR);

  for (let generator = 0; generator < DMAMUX_REQUEST_GENERATORS; generator += 1) {
    const rgcr = load(b, RGCR_BASE + generator * 4);
    const ready = boolAnd(b, boolBitAt(b, rgStatus, generator), boolBitAt(b, rgcr, 8));

    b.if(
      ready,
      (hit) => {
        const body = asBody(hit);

        body.setLocal(result, body.constant(types.bool, true));
      },
    );
  }

  return b.getLocal(result);
}

/** 绝对地址入口，供中央 `PeripheralModule` 使用。 */
export function readDmamuxAddress(
  b: Body,
  address: Value<number>,
  size: number,
): Value<number> {
  return readDmamux(b, b.subtract(address, num(b, DMAMUX1_BASE)), size);
}

export function writeDmamuxAddress(
  b: Body,
  address: Value<number>,
  size: number,
  value: Value<number>,
): void {
  writeDmamux(b, b.subtract(address, num(b, DMAMUX1_BASE)), size, value);
}

/**
 * 中央外设注册项。DMAMUX 没有自己的时间行为；同步触发由 EXTI/LPTIM 等模块提供，
 * 这里只保存同步配置与溢出标志，并暴露 overrun 中断。
 */
export const dmamuxModule: PeripheralModule = {
  id: 'dmamux',
  ranges: [{ base: DMAMUX1_BASE, size: 0x400 }],
  read: readDmamuxAddress,
  write: writeDmamuxAddress,
  interrupts: [
    {
      exception: DMAMUX_IRQ + 16,
      pendingIsPure: true,
      pending: dmamuxPending,
      acknowledge: () => {},
    },
  ],
};

/** DMAMUX 没有独立内部 state；所有状态都在 `dma` memory 的 0x200 起。 */

export const DMAMUX_STATES: readonly {
  readonly name: string;
  readonly type: 'number' | 'bool';
  readonly initial: number | boolean;
}[] = [];
