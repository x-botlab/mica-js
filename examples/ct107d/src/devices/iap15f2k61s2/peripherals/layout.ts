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
/** 时钟与省电模式的内部状态。 */
export const CLOCK_BASE = 0x90;
/**
 * 节拍服务：活动门控字节、服务块返回地址。
 *
 * `BUSY` 是「有外设可能自行变化」的缓存：任何外设 SFR 写入与每次推进后按各外设的
 * `active` 条件重算。空闲时指令块只读它一个字节就能跳过整个推进服务。
 */
export const TICK_BASE = 0xa0;
