import type { Body } from './ir';
import { num } from './ir';
import { SPI_CONFIGS, SPI_DR } from './spi-layout';
import type { DmaRequestSource } from './dma';
import type { DmaEndpoint } from './dma-default';
import { DMAMUX_REQUESTS } from './dmamux';
import { readSpi, spiDmaRequestReady, writeSpi } from './spi';

/**
 * SPI1/2/3 的 DMA 请求与窄 DR 端点。
 *
 * TX 请求 = SPE + CR2.TXDMAEN + TXE；RX 请求 = SPE + CR2.RXDMAEN + RXNE。
 * 请求源覆盖只动 DR 的低 byte（8 位标准 DMA 路径）；DR 端点供 system owner 的
 * DmaBus 按 PSIZE 处理 16 位。两者都走 `readSpi`/`writeSpi`，保留 RXNE/OVR 与
 * TXE 副作用，不暴露整个 0x400 窗口。
 */
export const spiDmaRequests: readonly DmaRequestSource[] = SPI_CONFIGS.flatMap((config) => [
  {
    id:
      config.index === 1
        ? DMAMUX_REQUESTS.SPI1_TX
        : config.index === 2
          ? DMAMUX_REQUESTS.SPI2_TX
          : DMAMUX_REQUESTS.SPI3_TX,
    name: `SPI${config.index} TX`,
    ready: (b: Body) => spiDmaRequestReady(b, config, true),
  },
  {
    id:
      config.index === 1
        ? DMAMUX_REQUESTS.SPI1_RX
        : config.index === 2
          ? DMAMUX_REQUESTS.SPI2_RX
          : DMAMUX_REQUESTS.SPI3_RX,
    name: `SPI${config.index} RX`,
    ready: (b: Body) => spiDmaRequestReady(b, config, false),
  },
]);

const spiDrEndpoint = (config: (typeof SPI_CONFIGS)[number]): DmaEndpoint => ({
  name: `spi${config.index}-dr`,
  base: config.base + SPI_DR,
  size: 2,
  read: (b, address, size) =>
    readSpi(b, config, b.subtract(address, num(b, config.base)), size),
  write: (b, address, size, value) =>
    writeSpi(b, config, b.subtract(address, num(b, config.base)), size, value),
});

export function spiDmaEndpoints(): readonly DmaEndpoint[] {
  return SPI_CONFIGS.map(spiDrEndpoint);
}
