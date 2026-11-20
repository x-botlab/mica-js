/**
 * STM32G431RBT6 的 ADC1/ADC2 寄存器与通道映射。
 *
 * 地址与位定义取自 RM0440 第 21 章和 ST 的 CMSIS `stm32g431xx.h`：
 * - ADC1 0x5000_0000，ADC2 0x5000_0100，ADC12_COMMON 0x5000_0300；
 * - 每个 ADC 的寄存器偏移 0x00–0xC0，公共区 CSR/CCR/CDR 在 0x300/0x308/0x30C。
 *
 * 外部通道映射按 RM0440 Table “ADC channel source assignment”：
 * - ADC1: IN1=PA0, IN2=PA1, IN3=PA2, IN4=PA3, IN5=PB14, IN6=PC0, IN7=PC1,
 *   IN8=PC2, IN9=PC3, IN10=PF0, IN11=PB12, IN12=PB1, IN14=PB11, IN15=PB0；
 * - ADC2: IN1=PA0, IN2=PA1, IN3=PA6, IN4=PA7, IN5=PC4, IN6=PC0, IN7=PC1,
 *   IN8=PC2, IN9=PC3, IN10=PF1, IN11=PC5, IN12=PB2, IN13=PA5, IN14=PB11,
 *   IN15=PB15, IN17=PA4。
 *
 * 因此 CT117E-M4 的两个电位器是 PB12 → ADC1_IN11、PB15 → ADC2_IN15；
 * PB14 是 ADC1_IN5（不是 ADC2）。IN13 在 G431 上只接 OPAMP 内部输出，未在
 * 引脚表中占用外部焊盘。
 *
 * 内部通道：ADC1 的 IN16=温度传感器、IN17=VBAT/3、IN18=VREFINT；ADC2 的
 * IN16=OPAMP2 内部输出、IN17=PA4、IN18=OPAMP3 内部输出。
 */

/** 每个 ADC 实例的寄存器基址。 */
export const ADC1_BASE = 0x50000000;
export const ADC2_BASE = 0x50000100;
export const ADC12_COMMON_BASE = 0x50000300;
export const ADC_COMMON_SIZE = 0x10;
/** ADC1/ADC2 + 公共寄存器的连续拦截区间。 */
export const ADC_REGION_BASE = ADC1_BASE;
export const ADC_REGION_END = ADC12_COMMON_BASE + ADC_COMMON_SIZE;

/** ADC1_2 共用中断号（CMSIS ADC1_2_IRQn）。 */
export const ADC12_IRQ = 18;

/** ADC 实例寄存器偏移。 */
export const ADC_ISR = 0x00;
export const ADC_IER = 0x04;
export const ADC_CR = 0x08;
export const ADC_CFGR = 0x0c;
export const ADC_CFGR2 = 0x10;
export const ADC_SMPR1 = 0x14;
export const ADC_SMPR2 = 0x18;
export const ADC_TR1 = 0x20;
export const ADC_TR2 = 0x24;
export const ADC_TR3 = 0x28;
export const ADC_SQR1 = 0x30;
export const ADC_SQR2 = 0x34;
export const ADC_SQR3 = 0x38;
export const ADC_SQR4 = 0x3c;
export const ADC_DR = 0x40;
export const ADC_JSQR = 0x4c;
export const ADC_OFR1 = 0x60;
export const ADC_OFR2 = 0x64;
export const ADC_OFR3 = 0x68;
export const ADC_OFR4 = 0x6c;
export const ADC_JDR1 = 0x80;
export const ADC_JDR2 = 0x84;
export const ADC_JDR3 = 0x88;
export const ADC_JDR4 = 0x8c;
export const ADC_AWD2CR = 0xa0;
export const ADC_AWD3CR = 0xa4;
export const ADC_DIFSEL = 0xb0;
export const ADC_CALFACT = 0xb4;
export const ADC_GCOMP = 0xc0;
/** 最后一个已定义寄存器偏移；之后为保留区。 */
export const ADC_LAST_REGISTER = ADC_GCOMP;

/** 公共寄存器偏移。 */
export const ADC_CSR = 0x00;
export const ADC_CCR = 0x08;
export const ADC_CDR = 0x0c;

/** ISR 标志位（写 1 清除）。 */
export const ADC_ISR_ADRDY = 1 << 0;
export const ADC_ISR_EOSMP = 1 << 1;
export const ADC_ISR_EOC = 1 << 2;
export const ADC_ISR_EOS = 1 << 3;
export const ADC_ISR_OVR = 1 << 4;
export const ADC_ISR_JEOC = 1 << 5;
export const ADC_ISR_JEOS = 1 << 6;
export const ADC_ISR_AWD1 = 1 << 7;
export const ADC_ISR_AWD2 = 1 << 8;
export const ADC_ISR_AWD3 = 1 << 9;
export const ADC_ISR_JQOVF = 1 << 10;
export const ADC_ISR_MASK = 0x7ff;

/** IER 中断使能位，与 ISR 同名位一一对应。 */
export const ADC_IER_MASK = 0x7ff;

/** CR 控制位。 */
export const ADC_CR_ADEN = 1 << 0;
export const ADC_CR_ADDIS = 1 << 1;
export const ADC_CR_ADSTART = 1 << 2;
export const ADC_CR_JADSTART = 1 << 3;
export const ADC_CR_ADSTP = 1 << 4;
export const ADC_CR_JADSTP = 1 << 5;
export const ADC_CR_ADVREGEN = 1 << 28;
export const ADC_CR_DEEPPWD = 1 << 29;
export const ADC_CR_ADCALDIF = 1 << 30;
export const ADC_CR_ADCAL = 1 << 31;
/** 由硬件管理的动作位；普通位写入不能直接改写它们。 */
export const ADC_CR_ACTION_MASK =
  ADC_CR_ADEN |
  ADC_CR_ADDIS |
  ADC_CR_ADSTART |
  ADC_CR_JADSTART |
  ADC_CR_ADSTP |
  ADC_CR_JADSTP |
  ADC_CR_ADCAL;

/** CFGR 位。 */
export const ADC_CFGR_DMAEN = 1 << 0;
export const ADC_CFGR_DMACFG = 1 << 1;
export const ADC_CFGR_RES_SHIFT = 3;
export const ADC_CFGR_RES_MASK = 0x3 << ADC_CFGR_RES_SHIFT;
export const ADC_CFGR_EXTSEL_SHIFT = 5;
export const ADC_CFGR_EXTSEL_MASK = 0x1f << ADC_CFGR_EXTSEL_SHIFT;
export const ADC_CFGR_EXTEN_SHIFT = 10;
export const ADC_CFGR_EXTEN_MASK = 0x3 << ADC_CFGR_EXTEN_SHIFT;
export const ADC_CFGR_OVRMOD = 1 << 12;
export const ADC_CFGR_CONT = 1 << 13;
export const ADC_CFGR_AUTDLY = 1 << 14;
export const ADC_CFGR_ALIGN = 1 << 15;
export const ADC_CFGR_DISCEN = 1 << 16;
export const ADC_CFGR_DISCNUM_SHIFT = 17;
export const ADC_CFGR_DISCNUM_MASK = 0x7 << ADC_CFGR_DISCNUM_SHIFT;
export const ADC_CFGR_JDISCEN = 1 << 20;
export const ADC_CFGR_JQM = 1 << 21;
export const ADC_CFGR_AWD1SGL = 1 << 22;
export const ADC_CFGR_AWD1EN = 1 << 23;
export const ADC_CFGR_JAWD1EN = 1 << 24;
export const ADC_CFGR_JAUTO = 1 << 25;
export const ADC_CFGR_AWD1CH_SHIFT = 26;
export const ADC_CFGR_AWD1CH_MASK = 0x1f << ADC_CFGR_AWD1CH_SHIFT;
export const ADC_CFGR_JQDIS = 1 << 31;

/** 公共 CCR 位。 */
export const ADC_CCR_DUAL_MASK = 0x1f;
export const ADC_CCR_DELAY_SHIFT = 8;
export const ADC_CCR_DELAY_MASK = 0xf << ADC_CCR_DELAY_SHIFT;
export const ADC_CCR_DMACFG = 1 << 13;
export const ADC_CCR_MDMA_SHIFT = 14;
export const ADC_CCR_MDMA_MASK = 0x3 << ADC_CCR_MDMA_SHIFT;
export const ADC_CCR_CKMODE_SHIFT = 16;
export const ADC_CCR_CKMODE_MASK = 0x3 << ADC_CCR_CKMODE_SHIFT;
export const ADC_CCR_PRESC_SHIFT = 18;
export const ADC_CCR_PRESC_MASK = 0xf << ADC_CCR_PRESC_SHIFT;
export const ADC_CCR_VREFEN = 1 << 22;
export const ADC_CCR_VSENSESEL = 1 << 23;
export const ADC_CCR_VBATSEL = 1 << 24;

/** CFGR.RES[1:0] 编码：00/01/10/11 → 12/10/8/6 位。 */
export const ADC_RESOLUTION_BITS = [12, 10, 8, 6] as const;
/** 对应分辨率的满量程码与 SAR 转换时钟数。 */
export const ADC_FULL_SCALE = [4095, 1023, 255, 63] as const;
export const ADC_SAR_CYCLES = [12.5, 10.5, 8.5, 6.5] as const;
/** SMP[2:0] 对应的采样时钟数（RM0440 21.4.12）。 */
export const ADC_SAMPLE_CYCLES = [2.5, 6.5, 12.5, 24.5, 47.5, 92.5, 247.5, 640.5] as const;

/** ADC 时钟预分频（CCR.PRESC，异步模式）。 */
export const ADC_PRESCALER = [1, 2, 4, 6, 8, 12, 16, 32, 64, 128, 256, 256, 256, 256, 256, 256] as const;

export interface AdcPin {
  readonly pin: string;
  /** GPIO 端口号（A=0、B=1、C=2）。 */
  readonly port: number;
  readonly bit: number;
}

/**
 * 外部通道映射。表里没有的通道在该 ADC 上不接外部引脚。
 */
export const ADC1_PINS: Readonly<Record<number, AdcPin>> = {
  1: { pin: 'PA0', port: 0, bit: 0 },
  2: { pin: 'PA1', port: 0, bit: 1 },
  3: { pin: 'PA2', port: 0, bit: 2 },
  4: { pin: 'PA3', port: 0, bit: 3 },
  5: { pin: 'PB14', port: 1, bit: 14 },
  6: { pin: 'PC0', port: 2, bit: 0 },
  7: { pin: 'PC1', port: 2, bit: 1 },
  8: { pin: 'PC2', port: 2, bit: 2 },
  9: { pin: 'PC3', port: 2, bit: 3 },
  10: { pin: 'PF0', port: 4, bit: 0 },
  11: { pin: 'PB12', port: 1, bit: 12 },
  12: { pin: 'PB1', port: 1, bit: 1 },
  14: { pin: 'PB11', port: 1, bit: 11 },
  15: { pin: 'PB0', port: 1, bit: 0 },
};

export const ADC2_PINS: Readonly<Record<number, AdcPin>> = {
  1: { pin: 'PA0', port: 0, bit: 0 },
  2: { pin: 'PA1', port: 0, bit: 1 },
  3: { pin: 'PA6', port: 0, bit: 6 },
  4: { pin: 'PA7', port: 0, bit: 7 },
  5: { pin: 'PC4', port: 2, bit: 4 },
  6: { pin: 'PC0', port: 2, bit: 0 },
  7: { pin: 'PC1', port: 2, bit: 1 },
  8: { pin: 'PC2', port: 2, bit: 2 },
  9: { pin: 'PC3', port: 2, bit: 3 },
  10: { pin: 'PF1', port: 4, bit: 1 },
  11: { pin: 'PC5', port: 2, bit: 5 },
  12: { pin: 'PB2', port: 1, bit: 2 },
  13: { pin: 'PA5', port: 0, bit: 5 },
  14: { pin: 'PB11', port: 1, bit: 11 },
  15: { pin: 'PB15', port: 1, bit: 15 },
  17: { pin: 'PA4', port: 0, bit: 4 },
};

export const ADC_CHANNEL_PINS: readonly Readonly<Record<number, AdcPin>>[] = [
  ADC1_PINS,
  ADC2_PINS,
];

/** VREFINT 的标称电压；只作为未校准模型，不用于精度验收。 */
export const ADC_VREFINT_NOMINAL = 1.212;
/** VBAT 内部桥的分压比：VBAT/3。 */
export const ADC_VBAT_DIVIDER = 3;
/** 低于该参考电压视为参考浮空/未上电。 */
export const ADC_MIN_REFERENCE = 0.1;
/** VDDA 最低可用电压（数据手册 1.62 V，按 1.6 V 判定）。 */
export const ADC_MIN_VDDA = 1.6;
