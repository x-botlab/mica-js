/**
 * STM32G431RBT6 SPI1/2/3 的地址、专属 memory 分区与引脚表。
 *
 * 中央 layout 为 SPI 预留独立 `spi` memory（0x200 字节），每路 0x80：低 0x40 是
 * 固件可见寄存器，高 0x40 是移位状态。SPI 不使用 `periph` 的通用后备字。
 */

import { SPI, SPI1_BASE, SPI2_BASE, SPI3_BASE, SPI_SIZE } from './layout';

export { SPI, SPI1_BASE, SPI2_BASE, SPI3_BASE, SPI_SIZE };

export const SPI_STATE = 0x000;
export const SPI_STATE_STRIDE = 0x80;
export const SPI_REGISTER_SIZE = 0x40;
export const SPI_INTERNAL_OFFSET = 0x40;
export const SPI_RANGE_SIZE = 0x400;

/** `periphActive` 的活动槽位（layout.PeripheralSlot.Spi）。 */
export const SPI_SLOT = 3;

export const SPI_CR1 = 0x00;
export const SPI_CR2 = 0x04;
export const SPI_SR = 0x08;
export const SPI_DR = 0x0c;
export const SPI_CRCPR = 0x10;
export const SPI_RXCRCR = 0x14;
export const SPI_TXCRCR = 0x18;
export const SPI_I2SCFGR = 0x1c;
export const SPI_I2SPR = 0x20;

export type SpiPinRole = 'sck' | 'miso' | 'mosi';

export interface SpiPin {
  readonly port: number;
  readonly pin: number;
  readonly af: number;
  readonly role: SpiPinRole;
}

export interface SpiConfig {
  readonly index: number;
  readonly base: number;
  readonly clockName: 'spi1' | 'spi2' | 'spi3';
  readonly irq: number;
  readonly pins: readonly SpiPin[];
}

/**
 * 引脚表来自 RM0440 的复用功能表：SPI1/SPI2 为 AF5，SPI3 为 AF6。
 * 只列 SCK/MISO/MOSI；NSS 未建模（边界见 spi.ts 顶部说明）。
 */
export const SPI_CONFIGS: readonly SpiConfig[] = [
  {
    index: 1,
    base: SPI1_BASE,
    clockName: 'spi1',
    irq: 35,
    pins: [
      { port: 0, pin: 5, af: 5, role: 'sck' },
      { port: 1, pin: 3, af: 5, role: 'sck' },
      { port: 0, pin: 6, af: 5, role: 'miso' },
      { port: 1, pin: 4, af: 5, role: 'miso' },
      { port: 0, pin: 7, af: 5, role: 'mosi' },
      { port: 1, pin: 5, af: 5, role: 'mosi' },
    ],
  },
  {
    index: 2,
    base: SPI2_BASE,
    clockName: 'spi2',
    irq: 36,
    pins: [
      { port: 1, pin: 13, af: 5, role: 'sck' },
      { port: 4, pin: 1, af: 5, role: 'sck' },
      { port: 1, pin: 14, af: 5, role: 'miso' },
      { port: 0, pin: 10, af: 5, role: 'miso' },
      { port: 1, pin: 15, af: 5, role: 'mosi' },
      { port: 0, pin: 11, af: 5, role: 'mosi' },
    ],
  },
  {
    index: 3,
    base: SPI3_BASE,
    clockName: 'spi3',
    irq: 51,
    pins: [
      { port: 2, pin: 10, af: 6, role: 'sck' },
      { port: 1, pin: 3, af: 6, role: 'sck' },
      { port: 2, pin: 11, af: 6, role: 'miso' },
      { port: 1, pin: 4, af: 6, role: 'miso' },
      { port: 2, pin: 12, af: 6, role: 'mosi' },
      { port: 1, pin: 5, af: 6, role: 'mosi' },
    ],
  },
];

/** 内部状态字段（相对 `SPI_INTERNAL_OFFSET`）。 */
export const SPI_F_PHASE = 0x00;
export const SPI_F_REMAINING = 0x04;
export const SPI_F_BIT = 0x08;
export const SPI_F_TX_SHIFT = 0x0c;
export const SPI_F_RX_SHIFT = 0x10;
export const SPI_F_TX = 0x14;
export const SPI_F_RX = 0x18;
export const SPI_F_FLAGS = 0x1c;
export const SPI_F_BITS = 0x20;
/** 不足一个核心周期的皮秒余数。 */
export const SPI_F_FRACTION = 0x24;
export const SPI_F_END = 0x28;

/** 内部 flags 位。 */
export const SPI_FLAG_TX_LOADED = 1 << 0;
export const SPI_FLAG_RX_FULL = 1 << 1;
export const SPI_FLAG_OVR = 1 << 2;
/** 已读 DR、尚未读 SR；OVR 只在 DR→SR 序列后清除。 */
export const SPI_FLAG_DR_READ = 1 << 3;
