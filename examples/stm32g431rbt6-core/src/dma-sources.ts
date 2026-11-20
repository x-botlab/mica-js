import type { DmaRequestSource } from './dma';
import { DMAMUX_REQUESTS } from './dmamux';
import { USARTS, usartDmaRequestReady } from './usart';

/**
 * 可选的 DMA 请求源适配器。
 *
 * DMA 核心不 import 任何设备；本文件把 USART owner 的 `usartDmaRequestReady`
 * （CR3.DMAT/DMAR + TXE/RXNE）翻译成 `DmaRequestSource.ready`，数据仍由 DmaBus
 * 对 CPAR/TDR/RDR 的真实访问完成。
 * ADC/SPI/I2C/TIM 的请求源由各自模块按同一接口提供，避免 dma.ts 反向依赖所有设备。
 */

const REQUEST_IDS: Readonly<Record<number, { readonly tx: number; readonly rx: number }>> = {
  1: { tx: DMAMUX_REQUESTS.USART1_TX, rx: DMAMUX_REQUESTS.USART1_RX },
  2: { tx: DMAMUX_REQUESTS.USART2_TX, rx: DMAMUX_REQUESTS.USART2_RX },
  3: { tx: DMAMUX_REQUESTS.USART3_TX, rx: DMAMUX_REQUESTS.USART3_RX },
  4: { tx: DMAMUX_REQUESTS.UART4_TX, rx: DMAMUX_REQUESTS.UART4_RX },
  5: { tx: DMAMUX_REQUESTS.LPUART1_TX, rx: DMAMUX_REQUESTS.LPUART1_RX },
};

function usartRequest(configIndex: number, tx: boolean): DmaRequestSource {
  const config = USARTS[configIndex]!;
  const ids = REQUEST_IDS[config.index]!;

  return {
    id: tx ? ids.tx : ids.rx,
    name: `${config.kind.toUpperCase()}${config.index} ${tx ? 'TX' : 'RX'}`,
    ready: (b) => usartDmaRequestReady(b, config, tx),
  };
}

/** USART1–3、UART4、LPUART1 的 TXE/RXNE 请求；数据路径故意不覆盖，走真实总线。 */
export const usartDmaRequests: readonly DmaRequestSource[] = USARTS.flatMap((_, index) => [
  usartRequest(index, true),
  usartRequest(index, false),
]);
