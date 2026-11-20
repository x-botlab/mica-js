import { types } from '@mica-js/sdk/model';
import type { Local, Value } from '@mica-js/sdk/model';
import {
  CODE,
  FLASH_ALIAS_BASE,
  FLASH_BASE,
  FLASH_SIZE,
  SRAM,
  SRAM_BASE,
  SRAM_SIZE,
} from './layout';
import { asBody, bool, boolAnd, num, u32 } from './ir';
import type { Body } from './ir';
import type { PeripheralModule } from './peripheral';
import { USARTS, readUsart, writeUsart } from './usart';
import type { UsartConfig } from './usart';
import { createDmaModule } from './dma';
import type { DmaBus, DmaRequestSource } from './dma';
import { usartDmaRequests } from './dma-sources';
import { i2cDmaEndpoints, i2cDmaRequests } from './i2c-dma';
import { spiDmaEndpoints, spiDmaRequests } from './spi-dma';
import { DMAMUX_REQUESTS } from './dmamux';

/**
 * 默认 DMA 总线适配器：窄而有界的端点分派，不调用 `readPeripheral`/`writePeripheral`
 * 的通用整树，也不 import `memory.ts`。
 *
 * 可访问端点固定为：
 * - SRAM1 读写；Flash/别名只读（写入按 TE 处理，不能静默丢弃后报 TC）；
 *   CCM SRAM 位于 CPU 私有 CCM 接口，DMA 不可访问，按非法端点处理；
 * - 默认 USART1–3 的寄存器窗口（`usartEndpoints()` 供 owner 追加 UART4/LPUART1）；
 * - I2C/SPI owner 提供的窄 RXDR/TXDR、DR 端点；
 * - owner 显式传入的 DmaEndpoint（ADC 等），不通用枚举保留寄存器。
 *
 * 每次 `valid`/read/write 只展开这些静态区间，不会把 DMA 自身、通用后备区或整个
 * bus 分派树重复展开。DMA 访问自身 DMAMUX 或未建模地址返回 false，由 DMA 核置 TE。
 */

const inRange = (
  b: Body,
  address: Value<number>,
  base: number,
  size: number,
  width: 1 | 2 | 4,
): Value<boolean> => {
  if (width > size) return bool(b, false);
  const relative = u32(b, b.subtract(address, num(b, base)));

  return boolAnd(
    b,
    b.lessThan(relative, num(b, size)),
    b.lessThanOrEqual(relative, num(b, size - width)),
  );
};

function loadWidth(
  b: Body,
  memory: string,
  offset: Value<number>,
  size: 1 | 2 | 4,
): Value<number> {
  if (size === 1) return b.load8(memory, offset);
  if (size === 2) return b.load16le(memory, offset);

  return b.load32le(memory, offset);
}

function storeWidth(
  b: Body,
  memory: string,
  offset: Value<number>,
  size: 1 | 2 | 4,
  value: Value<number>,
): void {
  if (size === 1) b.store8(memory, offset, value);
  else if (size === 2) b.store16le(memory, offset, value);
  else b.store32le(memory, offset, value);
}

export interface DmaEndpoint {
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readonly read: (b: Body, address: Value<number>, size: 1 | 2 | 4) => Value<number>;
  readonly write: (
    b: Body,
    address: Value<number>,
    size: 1 | 2 | 4,
    value: Value<number>,
  ) => void;
}

function usartEndpoint(config: UsartConfig): DmaEndpoint {
  return {
    name: `usart${config.index}`,
    base: config.base,
    size: 0x400,
    read: (b, address, size) =>
      readUsart(b, config, b.subtract(address, num(b, config.base)), size),
    write: (b, address, size, value) =>
      writeUsart(b, config, b.subtract(address, num(b, config.base)), size, value),
  };
}

export function usartEndpoints(): readonly DmaEndpoint[] {
  return USARTS.map(usartEndpoint);
}

function defaultUsartEndpoints(): readonly DmaEndpoint[] {
  return USARTS.filter((config) => config.kind === 'usart').map(usartEndpoint);
}

function defaultEndpoints(): readonly DmaEndpoint[] {
  return [...defaultUsartEndpoints(), ...i2cDmaEndpoints(), ...spiDmaEndpoints()];
}

function endpointsFor(extra: readonly DmaEndpoint[]): readonly DmaEndpoint[] {
  const byBase = new Map<number, DmaEndpoint>();

  for (const endpoint of defaultEndpoints()) byBase.set(endpoint.base, endpoint);
  for (const endpoint of extra) byBase.set(endpoint.base, endpoint);

  return [...byBase.values()];
}

function setTrue(b: Body, flag: Local<boolean>): void {
  b.setLocal(flag, b.constant(types.bool, true));
}

function validEndpoint(
  endpoints: readonly DmaEndpoint[],
  b: Body,
  address: Value<number>,
  size: 1 | 2 | 4,
  access: 'read' | 'write',
): Value<boolean> {
  const result = b.local(types.bool, false);

  b.if(inRange(b, address, SRAM_BASE, SRAM_SIZE, size), (hit) => setTrue(asBody(hit), result));
  if (access === 'read') {
    b.if(inRange(b, address, FLASH_BASE, FLASH_SIZE, size), (hit) =>
      setTrue(asBody(hit), result),
    );
    b.if(inRange(b, address, FLASH_ALIAS_BASE, FLASH_SIZE, size), (hit) =>
      setTrue(asBody(hit), result),
    );
  }

  for (const endpoint of endpoints)
    b.if(inRange(b, address, endpoint.base, endpoint.size, size), (hit) =>
      setTrue(asBody(hit), result),
    );

  return b.getLocal(result);
}

function readEndpoint(
  endpoints: readonly DmaEndpoint[],
  b: Body,
  address: Value<number>,
  size: 1 | 2 | 4,
): Value<number> {
  const result = b.local(types.number, 0);

  b.if(inRange(b, address, SRAM_BASE, SRAM_SIZE, size), (hit) => {
    const body = asBody(hit);

    body.setLocal(result, loadWidth(body, SRAM, body.subtract(address, num(body, SRAM_BASE)), size));
  });
  b.if(inRange(b, address, FLASH_BASE, FLASH_SIZE, size), (hit) => {
    const body = asBody(hit);

    body.setLocal(result, loadWidth(body, CODE, body.subtract(address, num(body, FLASH_BASE)), size));
  });
  b.if(inRange(b, address, FLASH_ALIAS_BASE, FLASH_SIZE, size), (hit) => {
    const body = asBody(hit);

    body.setLocal(
      result,
      loadWidth(body, CODE, body.subtract(address, num(body, FLASH_ALIAS_BASE)), size),
    );
  });

  for (const endpoint of endpoints)
    b.if(inRange(b, address, endpoint.base, endpoint.size, size), (hit) => {
      const body = asBody(hit);

      body.setLocal(result, endpoint.read(body, address, size));
    });

  return b.getLocal(result);
}

function writeEndpoint(
  endpoints: readonly DmaEndpoint[],
  b: Body,
  address: Value<number>,
  size: 1 | 2 | 4,
  value: Value<number>,
): void {
  b.if(inRange(b, address, SRAM_BASE, SRAM_SIZE, size), (hit) => {
    const body = asBody(hit);

    storeWidth(body, SRAM, body.subtract(address, num(body, SRAM_BASE)), size, value);
  });

  for (const endpoint of endpoints)
    b.if(inRange(b, address, endpoint.base, endpoint.size, size), (hit) => {
      const body = asBody(hit);

      endpoint.write(body, address, size, value);
    });
}

export function createDmaBus(extraEndpoints: readonly DmaEndpoint[] = []): DmaBus {
  const endpoints = endpointsFor(extraEndpoints);

  return {
    valid: (b, address, size, access) =>
      validEndpoint(endpoints, b, address, size, access),
    read: (b, address, size) => readEndpoint(endpoints, b, address, size),
    write: (b, address, size, value) => writeEndpoint(endpoints, b, address, size, value),
  };
}

/** 默认接 USART1–3 与 I2C/SPI owner 请求；UART4/LPUART1、ADC 由 owner 显式追加。 */
const DEFAULT_REQUEST_IDS = new Set<number>([
  DMAMUX_REQUESTS.USART1_RX,
  DMAMUX_REQUESTS.USART1_TX,
  DMAMUX_REQUESTS.USART2_RX,
  DMAMUX_REQUESTS.USART2_TX,
  DMAMUX_REQUESTS.USART3_RX,
  DMAMUX_REQUESTS.USART3_TX,
]);
const defaultRequests = [
  ...usartDmaRequests.filter((request) => DEFAULT_REQUEST_IDS.has(request.id)),
  ...i2cDmaRequests,
  ...spiDmaRequests,
];

export function createDefaultDmaModule(
  extraRequests: readonly DmaRequestSource[] = [],
  extraEndpoints: readonly DmaEndpoint[] = [],
): PeripheralModule {
  const requests = new Map<number, DmaRequestSource>();

  for (const request of [...defaultRequests, ...extraRequests]) requests.set(request.id, request);

  return createDmaModule({
    bus: createDmaBus(extraEndpoints),
    requests: [...requests.values()],
  });
}

export const dmaModule = createDefaultDmaModule();
export const dmaBus = createDmaBus();
