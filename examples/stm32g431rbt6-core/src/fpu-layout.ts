import { PERIPH } from './layout';

/**
 * FPU 状态在既有 `periph` 后备区的隐藏高段。
 *
 * 现有模块占用到 `TIM_STATE + 10*0x40` 附近（< 0x700），`periph` 长度为 0x1000。
 * 这里取 `0xf00..0xf8b`，不新增 DDL memory/state，也不会被固件通过外设偏移看到。
 * D0–D15 不是独立寄存器，只是 S(2n):S(2n+1) 的别名。
 */
export const FPU_MEMORY = PERIPH;
export const FPU_S_BASE = 0x0f00;
export const FPU_FPSCR = 0x0f80;
/** 是否已经执行过 FPU 指令；异常入口据此保存 FP 扩展帧。 */
export const FPU_ACTIVE = 0x0f84;
/** FPCCR 的生产模型存储；MMIO 地址是 0xe000ef34。 */
export const FPU_FPCCR = 0x0f88;
export const FPU_FPCCR_ADDRESS = 0xe000_ef34;

/**
 * FPSCR 中软件可写的位（ARMv7-M ARM A2.5.3 / Cortex-M4 FPSCR）：
 * NZCV[31:28]、AHP[26]、DN[25]、FZ[24]、RMode[23:22]、IDC[7]、IXC[4]、UFC[3]、
 * OFC[2]、DZC[1]、IOC[0]。保留位读出为 0，写入忽略。
 */
export const FPSCR_WRITE_MASK = 0xf7c0009f;

/** ARMv7-M FPCCR 的最小实现字段：ASPEN/LSPEN 可写，LSPACT 为只读硬件状态。 */
export const FPCCR_RESET = 0xc0000000;
export const FPCCR_WRITE_MASK = 0xc0000000;
export const FPCCR_ASPEN = 0x80000000;
export const FPCCR_LSPEN = 0x40000000;
export const FPCCR_LSPACT = 0x00000001;

/** 模型边界 fault：需要 FP 扩展栈帧/lazy PreserveFPState，但本轮不支持。 */
export const FP_CONTEXT_UNSUPPORTED = 0x21;

export const FPU_S_REGISTER_COUNT = 32;
export const FPU_D_REGISTER_COUNT = 16;
