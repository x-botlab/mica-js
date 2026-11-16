/**
 * 外设内部状态在 `periph` 存储器中的分区。
 *
 * 这些字节不是架构可见的 SFR：它们保存计数余量、移位寄存器、相位等实现状态。
 * 每个外设只使用自己区间内的偏移，区间之间不重叠；`PERIPH_SIZE` 是 model.ddl 中
 * `memory periph[]` 的长度。
 */

export const PERIPH_SIZE = 0x100;

/** 中断控制器：脏标志、当前优先级、栈指针与 16 字节优先级栈。 */
export const INTERRUPT_BASE = 0x00;
/** 定时器 T0/T1/T2 的计数余量与复用状态。 */
export const TIMER_BASE = 0x20;
/** 串口 1/2 的发送与接收移位状态。 */
export const UART_BASE = 0x40;
/** A/D 转换的启动、通道与计时状态。 */
export const ADC_BASE = 0x60;
/** PCA 计数器、捕获与 PWM 状态。 */
export const PCA_BASE = 0x68;
/** SPI 主模式的移位状态。 */
export const SPI_BASE = 0x78;
/** IAP/EEPROM 命令执行状态。 */
export const IAP_BASE = 0x80;
/** 看门狗计数状态。 */
export const WDT_BASE = 0x88;
/** 外部中断 2/3/4 的边沿锁存。 */
export const EXTINT_BASE = 0x8c;
/**
 * 时钟与省电模式的内部状态。
 *
 * 0x90 曾是低压标志，但外部中断的 LEVEL(4)（P3_0 的采样电平）也落在 0x90；
 * 两者会互相覆盖。外部中断区间止于 0x94，因此时钟区改到完整的空隙 0x95–0x97。
 */
export const CLOCK_BASE = 0x95;
/** 串口 1/2 在发送忙时各缓存一个待发送字节。 */
export const UART_QUEUE_BASE = 0x98;
/**
 * 节拍服务：活动门控字节、服务块返回地址。
 *
 * `BUSY` 是「有外设可能自行变化」的缓存：任何外设 SFR 写入与每次推进后按各外设的
 * `active` 条件重算。空闲时指令块只读它一个字节就能跳过整个推进服务。
 */
export const TICK_BASE = 0xa0;

/**
 * 各模块在 `periph` 中实际占用的闭区间。
 *
 * 这些区间必须两两不重叠，并且整体落在 `PERIPH_SIZE` 内。测试会据此检查布局；
 * 新增状态时先在这里登记，避免再次出现「外部中断电平覆盖低压标志」这类静默冲突。
 */
export const PERIPHERAL_REGIONS: readonly {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}[] = Object.freeze([
  { name: 'interrupt', start: 0x00, end: 0x1f },
  { name: 'timer', start: TIMER_BASE, end: 0x3f },
  { name: 'uart', start: UART_BASE, end: 0x5f },
  { name: 'adc', start: ADC_BASE, end: 0x67 },
  { name: 'pca', start: PCA_BASE, end: 0x77 },
  { name: 'spi', start: SPI_BASE, end: 0x7f },
  { name: 'iap', start: IAP_BASE, end: 0x87 },
  { name: 'watchdog', start: WDT_BASE, end: 0x8b },
  { name: 'extint', start: EXTINT_BASE, end: 0x94 },
  { name: 'clock', start: CLOCK_BASE, end: 0x97 },
  { name: 'uartQueue', start: UART_QUEUE_BASE, end: 0x99 },
  { name: 'tick', start: TICK_BASE, end: 0xa2 },
]);
