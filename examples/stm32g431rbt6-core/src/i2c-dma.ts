import type { Body } from './ir';
import { num } from './ir';
import { I2C_CONFIGS, I2C_RXDR, I2C_TXDR } from './i2c-layout';
import type { DmaRequestSource } from './dma';
import type { DmaEndpoint } from './dma-default';
import { DMAMUX_REQUESTS } from './dmamux';
import { i2cDmaRequestReady, readI2c, writeI2c } from './i2c';

/**
 * I2C1/2/3 的 DMA 请求与窄数据端点。
 *
 * 请求只在 PE + 对应 CR1.TXDMAEN/RXDMAEN + TXIS/RXNE 同时成立时拉高；
 * 端点只暴露 RXDR（只读 1 字节）和 TXDR（只写 1 字节），不把整个 0x400
 * 寄存器窗口当作 DMA 可访问区域。数据读写仍调用 `readI2c`/`writeI2c`，
 * 因此 RXNE 清除、TXDR 装载和 NACK/OVR 语义与 CPU 访问一致。
 */
export const i2cDmaRequests: readonly DmaRequestSource[] = I2C_CONFIGS.flatMap((config) => [
  {
    id:
      config.index === 1
        ? DMAMUX_REQUESTS.I2C1_TX
        : config.index === 2
          ? DMAMUX_REQUESTS.I2C2_TX
          : DMAMUX_REQUESTS.I2C3_TX,
    name: `I2C${config.index} TX`,
    ready: (b: Body) => i2cDmaRequestReady(b, config, true),
  },
  {
    id:
      config.index === 1
        ? DMAMUX_REQUESTS.I2C1_RX
        : config.index === 2
          ? DMAMUX_REQUESTS.I2C2_RX
          : DMAMUX_REQUESTS.I2C3_RX,
    name: `I2C${config.index} RX`,
    ready: (b: Body) => i2cDmaRequestReady(b, config, false),
  },
]);

const i2cRxEndpoint = (config: (typeof I2C_CONFIGS)[number]): DmaEndpoint => ({
  name: `i2c${config.index}-rxdr`,
  base: config.base + I2C_RXDR,
  size: 1,
  read: (b) => readI2c(b, config, num(b, I2C_RXDR), 1),
  // RXDR 是只读寄存器；错误方向写不产生数据副作用。
  write: () => {},
});

const i2cTxEndpoint = (config: (typeof I2C_CONFIGS)[number]): DmaEndpoint => ({
  name: `i2c${config.index}-txdr`,
  base: config.base + I2C_TXDR,
  size: 1,
  // TXDR 是只写寄存器；读取返回 0 且不消费数据。
  read: (b) => num(b, 0),
  write: (b, address, size, value) => {
    void address;
    void size;
    writeI2c(b, config, num(b, I2C_TXDR), 1, value);
  },
});

export function i2cDmaEndpoints(): readonly DmaEndpoint[] {
  return I2C_CONFIGS.flatMap((config) => [i2cRxEndpoint(config), i2cTxEndpoint(config)]);
}
