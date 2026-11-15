/** STM32G431RBT6 的地址与模型状态分区。 */

export const CODE = 'code';
export const SRAM = 'sram';
export const CCM = 'ccm';
export const PERIPH = 'periph';
export const SYS = 'sys';

export const FLASH_BASE = 0x08000000;
export const FLASH_ALIAS_BASE = 0x00000000;
export const FLASH_SIZE = 0x20000;
export const SRAM_BASE = 0x20000000;
export const SRAM_SIZE = 0x5800;
export const CCM_BASE = 0x10000000;
export const CCM_SIZE = 0x2800;
export const PERIPHERAL_BASE = 0x40000000;
export const PERIPHERAL_END = 0x60000000;
export const SYSTEM_BASE = 0xe0000000;
export const SYSTEM_END = 0xe0100000;

/**
 * r0–r12、SP、LR 使用独立 state。寄存器不是可寻址存储（`regs` 不在地址映射里），
 * 因此用 state 比用字节内存快：块内每次寄存器访问只有一次数组读，不需要 4 次字节访问。
 */
export const REG_STATES: readonly string[] = [
  'r0',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'sp',
  'lr',
  'pc',
];

export const regState = (index: number): string => REG_STATES[index & 0xf]!;
export const SP_STATE = 'sp';
export const LR_STATE = 'lr';

/** 每个块把自己的耗时累加进 `pendingPs`；越过阈值后一次性推进外设。 */
export const PENDING_PS = 'pendingPs';
/** 当前服务节拍粒度（ps）：空闲时放大，外设需要时由 refreshTick 收紧。 */
export const TICK_PS = 'tickPs';
/**
 * 是否有需要按时间推进的外设（SysTick 使能或有发送活动）。为 false 时指令块跳过
 * 时间服务，空闲固件完全不付服务块的成本。
 */
export const TICK_ACTIVE = 'tickActive';
/** 服务块要返回的 PC：节拍点指令顺序执行后的位置。 */
export const SERVICE_RESUME = 'serviceResume';
/** 待刷新引脚意图的端口位掩码（bit0=GPIOA … bit4=GPIOF）。 */
export const GPIO_SYNC = 'gpioSync';
/**
 * Guest 已预计算的变化位。非零时服务块只消费掩码；为零时服务块执行完整寄存器写。
 */
export const GPIO_PIN_MASK = 'gpioPinMask';
/** 上一次同步时的供电状态：变化时整端口重新生成意图。 */
export const GPIO_POWERED = 'gpioPowered';
/** 延迟到服务块执行的 GPIO 写。 */
export const GPIO_WRITE = 'gpioWrite';
export const GPIO_WRITE_ADDR = 'gpioWriteAddr';
export const GPIO_WRITE_VALUE = 'gpioWriteValue';
export const GPIO_WRITE_SIZE = 'gpioWriteSize';
/**
 * 延迟到服务块执行的 GPIO IDR 读。IDR 要逐脚读采样再拼字，5 个端口全内联会让每条
 * 动态地址访存都背上整棵组包树；寄存器号、地址与宽度先记在这里，由 `SERVICE_READ`
 * 组包后写回。
 */
export const DEFER_READ = 'deferRead';
export const DEFER_READ_PORT = 'deferReadPort';
export const DEFER_READ_OFFSET = 'deferReadOffset';
export const DEFER_READ_TARGET = 'deferReadTarget';
export const DEFER_READ_SIZE = 'deferReadSize';
export const DEFER_READ_SIGNED = 'deferReadSigned';
/**
 * 延迟到服务块执行的非 GPIO 外设写。GPIO 写仍然在块内登记，因为服务块要在同一块之后
 * 立即取走它；其余外设寄存器的读改写链很宽，适合统一放到 `SERVICE_WRITE`。
 */
export const DEFER_WRITE = 'deferWrite';
export const DEFER_WRITE_ADDR = 'deferWriteAddr';
export const DEFER_WRITE_VALUE = 'deferWriteValue';
export const DEFER_WRITE_SIZE = 'deferWriteSize';
/** 可能已具备中断条件；只在为 true 的块里扫描异常。 */
export const IRQ_DIRTY = 'irqDirty';
/** SysTick CTRL.ENABLE 的影子，避免每拍读 CTRL。 */
export const SYSTICK_ON = 'systickOn';

/**
 * 「现在就需要服务」的位掩码。
 *
 * 指令块每条指令都要判断要不要进服务块，把四个延迟请求合并成一个字以后，判断从四次
 * state 读降到一次。设置位的地方就是原来设置对应标志的地方；清除位的地方是服务块清
 * 对应标志处。陈旧位只会多派发一次服务（服务块自己什么也不做），不会漏服务。
 */
export const SERVICE_MASK = 'serviceMask';
/** 有延迟的 GPIO 寄存器写。 */
export const SERVICE_GPIO_WRITE = 1;
/** 有延迟的 GPIO IDR 读。 */
export const SERVICE_DEFER_READ = 2;
/** 有延迟的非 GPIO 外设写。 */
export const SERVICE_DEFER_WRITE = 4;
/** 有端口需要刷新引脚意图。 */
export const SERVICE_PIN_SYNC = 8;
/** 有中断待扫描（还需要 `primask` 为 0 才能派发，由服务块自己判断）。 */
export const SERVICE_IRQ = 16;
/** 全部立即生效的请求位。 */
export const SERVICE_ALL = 31;
/** 有发送活动（TX_ACTIVE 或排队字节）的 USART 位掩码。 */
export const TX_MASK = 'txMask';

/**
 * SysTick 与 USART 发送器的内部寄存器用 state 保存：它们每个块的节拍推进都要读，
 * 用 state 时一次访问只有一个数组读，而字节内存要 4 次访存。这些值不是固件可见的
 * 寄存器映像，`periph`/`sys` 里不再保留它们的字节。
 */
export const SYSTICK_CTRL = 'systickCtrl';
export const SYSTICK_LOAD = 'systickLoad';
export const SYSTICK_VAL = 'systickVal';
export const SYSTICK_COUNT = 'systickCount';
export const SYSTICK_PENDING = 'systickPending';

export type TxField = 'Active' | 'Remaining' | 'Queue' | 'Count' | 'Period' | 'Publish';

export const txState = (index: number, field: TxField): string => `tx${index}${field}`;

/** APCR 位：N/Z/C/V 与 Thumb。 */
export const APSR_N = 0x80000000;
export const APSR_Z = 0x40000000;
export const APSR_C = 0x20000000;
export const APSR_V = 0x10000000;
export const APSR_T = 0x01000000;

export const RCC_BASE = 0x40021000;
export const RCC_RCC_STATE = 0x000;
export const RCC_STATE_SIZE = 0x80;

export const GPIO_BASE = 0x48000000;
export const GPIO_PORT_STRIDE = 0x400;
export const GPIO_STATE = 0x100;
export const GPIO_STATE_STRIDE = 0x40;

/** 引脚意图需要的端口配置寄存器；每个都有对应的影子 state（见 model.ddl）。 */
export const gpioModerState = (port: number): string => `gpioModer${port}`;
export const gpioOtyperState = (port: number): string => `gpioOtyper${port}`;
export const gpioPupdrState = (port: number): string => `gpioPupdr${port}`;
export const gpioAfr0State = (port: number): string => `gpioAfr0${port}`;
export const gpioAfr1State = (port: number): string => `gpioAfr1${port}`;
export const gpioOdrState = (port: number): string => `gpioOdr${port}`;
/**
 * MODER=输出且 OTYPER=推挽的引脚位图。只在配置写时维护，稳态输出写据此跳过
 * MODER/OTYPER/PUPDR/AFR 的完整意图分支。
 */
export const gpioSimpleOutState = (port: number): string => `gpioSimpleOut${port}`;

export const USART1_BASE = 0x40013800;
export const USART2_BASE = 0x40004400;
export const USART3_BASE = 0x40004800;
export const USART_STATE = 0x300;
export const USART_STATE_STRIDE = 0x40;

export const TIM2_BASE = 0x40000000;
export const TIM3_BASE = 0x40000400;
export const TIM4_BASE = 0x40000800;
export const TIM6_BASE = 0x40001000;
export const TIM7_BASE = 0x40001400;
export const TIM_STATE = 0x400;
export const TIM_STATE_STRIDE = 0x40;

export const FLASH_BASE_REGISTER = 0x40022000;
export const FLASH_STATE = 0x600;
export const PWR_BASE = 0x40007000;
export const PWR_STATE = 0x620;

export const SYSTICK_BASE = 0xe000e010;
export const SYSTICK_STATE = 0x000;
export const NVIC_BASE = 0xe000e100;
export const NVIC_STATE = 0x040;
export const SCB_BASE = 0xe000ed00;
export const SCB_STATE = 0x100;

/** packed 外设寄存器的统一读取宽度。 */
export type AccessSize = 1 | 2 | 4;
