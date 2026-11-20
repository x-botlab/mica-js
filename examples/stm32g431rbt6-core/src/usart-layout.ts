/**
 * USART 扩展状态在 `periph` 中的分区。
 *
 * USART1–5 的寄存器影子连续放在 `layout.ts` 的 `USART_STATE`；RX 内部状态与
 * UART4/LPUART1 的发送器内部状态放在这里没有其它分区占用的尾部。`periph` 是 0x1000
 * 字节；0x800–0xBFF 是旧 `bus` 通用后备区，0xC00 起为空闲区。
 *
 * 这些状态不是固件可见的寄存器映像：只有 `usart.ts` 通过 `PERIPH` 访问它们。
 */

/** G431RB 实际存在的扩展串口基址；与 `layout.ts` 的同名常量一致。 */
export const UART4_BASE = 0x40004c00;
export const LPUART1_BASE = 0x40008000;

/** UART4/LPUART1 发送器内部状态区（每路 0x20 字节）。 */
export const USART_EXT_TX_STATE = 0xc00;
export const USART_EXT_TX_STRIDE = 0x20;
/** RX 内部状态区（5 路，每路 0x20 字节）。 */
export const USART_RX_STATE = 0xcc0;
export const USART_RX_STRIDE = 0x20;

/** `txMask` 的低位沿用发送活动；高位表示接收器已使能。 */
export const USART_TX_BITS = 0x001f;
export const USART_RX_BITS = 0x1f00;

/** 发送器非时间字段在每路状态窗口内的偏移。 */
export const USART_TX_FIELDS = {
  Active: 0x00,
  Queue: 0x04,
  Count: 0x08,
  Publish: 0x0c,
} as const;

/** 发送器时间字段：`lo | hi << 32`，单位皮秒。 */
export const USART_TX_TIME_FIELDS = {
  RemainingLo: 0x10,
  RemainingHi: 0x14,
  PeriodLo: 0x18,
  PeriodHi: 0x1c,
} as const;

/** RX 非时间字段在每路状态窗口内的偏移。 */
export const USART_RX_FIELDS = {
  Phase: 0x00,
  Shift: 0x0c,
  Data: 0x10,
} as const;

/** RX 剩余采样时间：`lo | hi << 32`，单位皮秒。 */
export const USART_RX_TIME_FIELDS = {
  RemainingLo: 0x04,
  RemainingHi: 0x08,
} as const;

export const USART_RX_PHASE_STAGE_MASK = 0x3;
export const USART_RX_PHASE_INDEX_SHIFT = 8;
/** 空闲态已经看到过高电平；只有先高后低才开新帧。 */
export const USART_RX_PHASE_LINE_HIGH = 1 << 16;
/** 一帧刚刚结束，等待确认线路确实空闲后置 IDLE。 */
export const USART_RX_PHASE_FRAME_DONE = 1 << 17;

export const USART_RX_STAGE_IDLE = 0;
export const USART_RX_STAGE_START = 1;
export const USART_RX_STAGE_DATA = 2;
export const USART_RX_STAGE_STOP = 3;

/** `Data` 字：低 8 位是 RDR，高 8 位按 ISR 位号保存 RX 标志。 */
export const USART_RX_DATA_MASK = 0xff;
export const USART_RX_DATA_FE = 1 << (8 + 1);
export const USART_RX_DATA_NE = 1 << (8 + 2);
export const USART_RX_DATA_ORE = 1 << (8 + 3);
export const USART_RX_DATA_IDLE = 1 << (8 + 4);
export const USART_RX_DATA_RXNE = 1 << (8 + 5);

/**
 * clock-tree 的 CLOCK_CACHE 中 USART1–5 实际外设时钟字偏移（相对 RCC 窗口）。
 * 必须与 `clock-tree.ts` 的 `CLOCK_CACHE.usart1Hz`… 保持一致。
 */
export const USART_CLOCK_CACHE_OFFSETS: Readonly<Record<number, number>> = {
  1: 0xbc,
  2: 0xc0,
  3: 0xc4,
  4: 0xc8,
  5: 0xcc,
};
