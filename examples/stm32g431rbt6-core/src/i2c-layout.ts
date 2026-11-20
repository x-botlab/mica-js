/**
 * STM32G431RBT6 I2C1/2/3 的地址、专属 memory 分区与引脚表。
 *
 * 中央 layout 为 I2C 预留了独立的 `i2c` memory（0x200 字节），每路占 0x80：
 * 低 0x40 是固件可见寄存器，高 0x40 是状态机内部相位。这样 I2C 不再和 `periph`
 * 的通用后备区或其它外设共享字节偏移。
 */

import { I2C, I2C1_BASE, I2C2_BASE, I2C3_BASE, I2C_SIZE } from './layout';

export { I2C, I2C1_BASE, I2C2_BASE, I2C3_BASE, I2C_SIZE };

/** `i2c` memory 内的 I2C 起始偏移。 */
export const I2C_STATE = 0x000;
/** 每路寄存器 0x40 + 内部状态 0x40。 */
export const I2C_STATE_STRIDE = 0x80;
export const I2C_REGISTER_SIZE = 0x40;
export const I2C_INTERNAL_OFFSET = 0x40;

/** 每个 I2C 实例占用的外设地址窗口（I2C1/2/3 相同）。 */
export const I2C_RANGE_SIZE = 0x400;

/** `periphActive` 的活动槽位（layout.PeripheralSlot.I2c）。 */
export const I2C_SLOT = 2;

/** I2C 寄存器偏移。 */
export const I2C_CR1 = 0x00;
export const I2C_CR2 = 0x04;
export const I2C_OAR1 = 0x08;
export const I2C_OAR2 = 0x0c;
export const I2C_TIMINGR = 0x10;
export const I2C_TIMEOUTR = 0x14;
export const I2C_ISR = 0x18;
export const I2C_ICR = 0x1c;
export const I2C_PECR = 0x20;
export const I2C_RXDR = 0x24;
export const I2C_TXDR = 0x28;

export type I2cPinRole = 'scl' | 'sda';

export interface I2cPin {
  readonly port: number;
  readonly pin: number;
  readonly af: number;
  readonly role: I2cPinRole;
}

export interface I2cConfig {
  readonly index: number;
  readonly base: number;
  readonly clockName: 'i2c1' | 'i2c2' | 'i2c3';
  /** 事件中断号（I2Cx_EV）。 */
  readonly evIrq: number;
  /** 错误中断号（I2Cx_ER）。 */
  readonly erIrq: number;
  readonly pins: readonly I2cPin[];
}

/**
 * 引脚表来自 ST DS12589 Rev 2 Table 18（Alternate function mapping）与 RM0440 的
 * 复用功能描述，I2C1/2/3 均为 AF4。
 *
 * 重要：STM32G431 的 PB6 **没有** I2C1_SCL。DS12589 Table 18 对 PB6 只列
 * COMP4_OUT/TIM4_CH1/TIM8_CH1/TIM8_ETR/USART1_TX 等；PB7 才是 I2C1_SDA。
 * CT117E-M4 原理图把 PB6/PB7 标注为 I2C1_SCL/SDA 是板级标注，不改变硅片复用表；
 * 该板若要在 PB6/PB7 上使用 AT24C02/MCP4017，只能由 GPIO 软件 I2C 驱动，不能把
 * PB6 塞进硬件 I2C1 的 AF 表。
 *
 * 官方证据：
 * - DS12589 Rev 2, Table 18 "Alternate function mapping", PB6/PB7/PB8/PA15 行；
 *   https://www.st.com/resource/en/datasheet/stm32g431rb.pdf
 * - RM0440 Rev 7, I2C 章节（I2C1/2/3 的 SCL/SDA 复用功能与 AF4）。
 *   https://www.st.com/resource/en/reference_manual/rm0440-stm32g4-series-advanced-armbased-32bit-mcus-stmicroelectronics.pdf
 */
export const I2C_CONFIGS: readonly I2cConfig[] = [
  {
    index: 1,
    base: I2C1_BASE,
    clockName: 'i2c1',
    evIrq: 31,
    erIrq: 32,
    pins: [
      { port: 1, pin: 8, af: 4, role: 'scl' },
      { port: 0, pin: 15, af: 4, role: 'scl' },
      { port: 1, pin: 7, af: 4, role: 'sda' },
      { port: 1, pin: 9, af: 4, role: 'sda' },
      { port: 0, pin: 14, af: 4, role: 'sda' },
    ],
  },
  {
    index: 2,
    base: I2C2_BASE,
    clockName: 'i2c2',
    evIrq: 33,
    erIrq: 34,
    pins: [
      { port: 0, pin: 9, af: 4, role: 'scl' },
      { port: 2, pin: 4, af: 4, role: 'scl' },
      { port: 0, pin: 8, af: 4, role: 'sda' },
      { port: 4, pin: 0, af: 4, role: 'sda' },
    ],
  },
  {
    index: 3,
    base: I2C3_BASE,
    clockName: 'i2c3',
    evIrq: 92,
    erIrq: 93,
    pins: [
      { port: 0, pin: 8, af: 4, role: 'scl' },
      { port: 2, pin: 8, af: 4, role: 'scl' },
      { port: 1, pin: 5, af: 4, role: 'sda' },
      { port: 2, pin: 9, af: 4, role: 'sda' },
      { port: 2, pin: 11, af: 4, role: 'sda' },
    ],
  },
];

/** 内部状态字段（相对 `I2C_INTERNAL_OFFSET`）。 */
export const I2C_F_PHASE = 0x00;
export const I2C_F_REMAINING = 0x04;
export const I2C_F_BIT = 0x08;
export const I2C_F_SHIFT = 0x0c;
export const I2C_F_TX = 0x10;
export const I2C_F_RX = 0x14;
export const I2C_F_FLAGS = 0x18;
export const I2C_F_STRETCH = 0x1c;
export const I2C_F_TIMEOUT = 0x20;
export const I2C_F_SCRATCH = 0x24;
/** 不足一个核心周期的皮秒余数；与 cycles 字段共同保存精确时间。 */
export const I2C_F_FRACTION = 0x28;
export const I2C_F_STRETCH_FRACTION = 0x2c;
/** RCC 时钟缓存代数 + TIMINGR 换算后的低/高/PRESC 时间（ps）。 */
export const I2C_F_CLOCK_EPOCH = 0x30;
export const I2C_F_LOW_PS = 0x34;
export const I2C_F_HIGH_PS = 0x38;
export const I2C_F_PRESC_PS = 0x3c;
export const I2C_F_END = 0x40;

/** 内部 flags 位。 */
export const I2C_FLAG_TX_LOADED = 1 << 0;
export const I2C_FLAG_RX_FULL = 1 << 1;
export const I2C_FLAG_ADDR = 1 << 2;
export const I2C_FLAG_NACK = 1 << 3;
export const I2C_FLAG_STOP = 1 << 4;
export const I2C_FLAG_TC = 1 << 5;
export const I2C_FLAG_TCR = 1 << 6;
export const I2C_FLAG_OVR = 1 << 7;
export const I2C_FLAG_TIMEOUT = 1 << 8;
export const I2C_FLAG_START_PENDING = 1 << 9;
export const I2C_FLAG_STOP_PENDING = 1 << 10;
