/** STM32G431 系统外设的私有隐藏状态偏移。 */

/** EXTI `exti` memory 中的边沿采样隐藏区。 */
export const EXTI_PREV = 0x80;
export const EXTI_INIT = 0x84;
export const EXTI_EVENT = 0x88;

/** `sys` memory 中的复位请求状态（NVIC/SCB 使用 0x40–0x1ef）。 */
export const RESET_REQUEST = 0x08;
export const RESET_HELD = 0x0c;
export const RESET_CAUSE = 0x10;
export const RESET_COUNT = 0x1fc;

/** NRST 复位入口：中央在 `isServicePc`/`buildService` 中注册。 */
export const SERVICE_RESET_PC = 0x20050;
