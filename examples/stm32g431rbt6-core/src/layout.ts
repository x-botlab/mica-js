/** STM32G431RBT6 的地址与模型状态分区。 */

export const CODE = 'code';
export const SRAM = 'sram';
export const CCM = 'ccm';
export const PERIPH = 'periph';
export const SYS = 'sys';

/**
 * 每模块专属 memory：新增外设不再挤进 `periph` 的低位偏移，避免不同模块在同一个
 * 后备字上互相覆盖。大小与两个消费者 DDL 的声明保持一致。
 */
export const ANALOG = 'analog';
export const I2C = 'i2c';
export const SPI = 'spi';
export const TIM = 'tim';
export const SERIAL = 'serial';
export const EXTI = 'exti';
export const SYSCFG = 'syscfg';
export const DMA = 'dma';
export const CRC = 'crc';
export const RNG = 'rng';
export const RTC = 'rtc';
export const WATCHDOG = 'watchdog';
export const FLASH_STATE_MEMORY = 'flashState';
export const USB = 'usb';
export const CAN = 'can';
export const UCPD = 'ucpd';
/** TIM 捕获边沿 FIFO：16B/edge，64 项，绝对时间 lo/hi 拆分。 */
export const CAPTURE = 'captureFifo';
export const CAPTURE_SIZE = 0x400;
export const CAPTURE_ENTRY_SIZE = 16;
export const CAPTURE_SLOTS = 64;
export const CAPTURE_HEAD = 'captureHead';
export const CAPTURE_TAIL = 'captureTail';
export const CAPTURE_PENDING = 'capturePending';
export const CAPTURE_OVERFLOW = 'captureOverflow';
export const CAPTURE_RESUME = 'captureResume';
/** 未建模外设的最后写入值后备；哈希散列，不再按低 8 位地址互相别名。 */
export const GENERIC = 'generic';
export const GENERIC_SIZE = 0x2000;

export const ANALOG_SIZE = 0x400;
export const I2C_SIZE = 0x200;
export const SPI_SIZE = 0x200;
export const TIM_SIZE = 0x300;
export const SERIAL_SIZE = 0x200;
export const EXTI_SIZE = 0x100;
export const SYSCFG_SIZE = 0x100;
export const DMA_SIZE = 0x400;
export const CRC_SIZE = 0x20;
export const RNG_SIZE = 0x20;
export const RTC_SIZE = 0x100;
export const WATCHDOG_SIZE = 0x40;
export const FLASH_STATE_SIZE = 0x100;
export const USB_SIZE = 0x800;
export const CAN_SIZE = 0x800;
export const UCPD_SIZE = 0x100;

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
/**
 * 当前 CPU 每周期耗时（ps）。由 RCC 写入后的 `refreshCpuClock` 从 HCLK 缓存更新；
 * 指令块在运行期读取它，而不是把翻译期的 `machine.cyclePs` 固化成常量。
 */
export const CPU_CYCLE_PS = 'cpuCyclePs';
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
/** 动态寄存器读命中的模块下标；-1 表示走 GPIO IDR 路径。 */
export const DEFER_READ_MODULE = 'deferReadModule';
/** 动态寄存器读的绝对地址。 */
export const DEFER_READ_ADDRESS = 'deferReadAddress';
/**
 * 延迟到服务块执行的非 GPIO 外设写。GPIO 写仍然在块内登记，因为服务块要在同一块之后
 * 立即取走它；其余外设寄存器的读改写链很宽，适合统一放到 `SERVICE_WRITE`。
 */
export const DEFER_WRITE = 'deferWrite';
export const DEFER_WRITE_ADDR = 'deferWriteAddr';
export const DEFER_WRITE_VALUE = 'deferWriteValue';
export const DEFER_WRITE_SIZE = 'deferWriteSize';
/** 动态寄存器写命中的模块下标；-1 表示走核心/后备路径。 */
export const DEFER_WRITE_MODULE = 'deferWriteModule';
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
/** 有真实引脚捕获边沿待按绝对时间消费。 */
export const SERVICE_CAPTURE_BIT = 32;
/** 全部立即生效的请求位。 */
export const SERVICE_ALL = 31 | SERVICE_CAPTURE_BIT;
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

/**
 * 时间服务累加的绝对仿真时间（ps）。`pendingPs` 是尚未交给外设的本批耗时；
 * `nowPs` 只在服务块推进时间时增长，供输入捕获、RTC、超时等需要时间戳的模块读取。
 */
export const NOW_PS = 'nowPs';

/**
 * 时间驱动外设的活动槽位。每个模块在 `markPeripheralActive` 时置位，inactive 时清零；
 * `refreshTick` 据此收紧 `tickPs`，`SERVICE_TICK` 只推进活动槽。
 */
export const PERIPH_ACTIVE = 'periphActive';
export const PERIPH_SLOT_COUNT = 16;
/** 本轮还需推进的模块槽；SERVICE_ADVANCE 块逐个消费。 */
export const ADVANCE_PENDING = 'advancePending';
/** 本轮交给模块推进的经过时间（ps）。 */
export const ADVANCE_ELAPSED = 'advanceElapsedPs';
/** 模块时间推进服务块：每个槽一个 PC，按需翻译。 */
export const SERVICE_ADVANCE_BASE = 0x20080;
/** 捕获 FIFO 服务块：在 SERVICE_TICK 推进 TIM 之前消费真实边沿。 */
export const SERVICE_CAPTURE = 0x20008;
export const SERVICE_DISPATCH = 0x20060;
export const SERVICE_FLASH_WRITE = 0x20070;
export const SERVICE_SYSTEM_WRITE = 0x20078;
export const SERVICE_MODULE_WRITE_BASE = 0x20090;
export const SERVICE_MODULE_READ_BASE = 0x200b0;
export const SERVICE_CORE_WRITE_BASE = 0x200d0;

export const enum PeripheralSlot {
  Tim = 0,
  Analog = 1,
  I2c = 2,
  Spi = 3,
  Serial = 4,
  Exti = 5,
  Dma = 6,
  Rtc = 7,
  Flash = 8,
  Usb = 9,
  Can = 10,
  Ucpd = 11,
  CrcRng = 12,
  Watchdog = 13,
  Misc = 14,
  Reserved = 15,
}

export const periphDeadlineState = (slot: number): string =>
  `periphDeadline${slot & (PERIPH_SLOT_COUNT - 1)}`;

/**
 * 未建模外设后备区的槽索引。每个槽 8 字节：4 字节地址 tag + 4 字节最后写入值。
 * tag 不匹配时读回 0，而不是另一个未知外设的旧值；哈希碰撞因此不会伪装成别名。
 */
export const GENERIC_SLOTS = GENERIC_SIZE / 8;
export const genericWordIndex = (address: number): number => {
  const word = ((address - PERIPHERAL_BASE) >>> 2) >>> 0;
  const mixed = (word ^ (word >>> 8) ^ (word >>> 16)) >>> 0;

  return mixed & (GENERIC_SLOTS - 1);
};
export const genericTagOffset = (slot: number): number => slot * 8;
export const genericValueOffset = (slot: number): number => slot * 8 + 4;
export const genericTagOf = (address: number): number => (address & 0xfffffffc) >>> 0;

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
/** LCKR 已锁定的引脚位（低 16 位）；配置寄存器写入时保持这些字段不变。 */
export const gpioLockState = (port: number): string => `gpioLck${port}`;
/** LCKK 三步序列阶段：0 空闲、1 写 1、2 写 0、3 待读确认、4 已锁。 */
export const gpioLockStepState = (port: number): string => `gpioLckStep${port}`;

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
export const TIM1_BASE = 0x40012c00;
export const TIM8_BASE = 0x40013400;
export const TIM15_BASE = 0x40014000;
export const TIM16_BASE = 0x40014400;
export const TIM17_BASE = 0x40014800;
export const LPTIM1_BASE = 0x40007c00;
/** 兼容旧导出；TIM 外设的实际存储已迁到独立 `tim` memory。 */
export const TIM_STATE = 0x400;
export const TIM_STATE_STRIDE = 0x40;

export const FLASH_BASE_REGISTER = 0x40022000;
export const FLASH_STATE = 0x600;
export const PWR_BASE = 0x40007000;
export const PWR_STATE = 0x620;

export const SYSCFG_BASE = 0x40010000;
export const EXTI_BASE = 0x40010400;
export const ADC1_BASE = 0x50000000;
export const ADC2_BASE = 0x50000100;
export const ADC12_COMMON_BASE = 0x50000300;
export const DAC1_BASE = 0x50000800;
export const COMP1_BASE = 0x40010200;
export const OPAMP_BASE = 0x40010300;
export const I2C1_BASE = 0x40005400;
export const I2C2_BASE = 0x40005800;
export const I2C3_BASE = 0x40007800;
export const SPI1_BASE = 0x40013000;
export const SPI2_BASE = 0x40003800;
export const SPI3_BASE = 0x40003c00;
export const UART4_BASE = 0x40004c00;
export const LPUART1_BASE = 0x40008000;
export const DMA1_BASE = 0x40020000;
export const DMA2_BASE = 0x40020400;
export const DMAMUX1_BASE = 0x40020800;
export const CORDIC_BASE = 0x40020c00;
export const FMAC_BASE = 0x40021400;
export const CRC_BASE = 0x40023000;
export const RNG_BASE = 0x50060800;
export const RTC_BASE = 0x40002800;
export const TAMP_BASE = 0x40002400;
export const IWDG_BASE = 0x40003000;
export const WWDG_BASE = 0x40002c00;
export const SAI1_BASE = 0x40015400;
export const USB_BASE = 0x40005c00;
export const FDCAN1_BASE = 0x40006400;
export const UCPD1_BASE = 0x4000a000;
export const CRS_BASE = 0x40002000;
export const VREFBUF_BASE = 0x40010030;

/** Cortex 异常号 = 16 + CMSIS IRQn。 */
export const exceptionOf = (irq: number): number => 16 + irq;

export const SYSTICK_BASE = 0xe000e010;
export const SYSTICK_STATE = 0x000;
export const NVIC_BASE = 0xe000e100;
export const NVIC_STATE = 0x040;
export const SCB_BASE = 0xe000ed00;
export const SCB_STATE = 0x100;

/** packed 外设寄存器的统一读取宽度。 */
export type AccessSize = 1 | 2 | 4;
