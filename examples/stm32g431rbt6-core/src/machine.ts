import type { Value } from '@mica-js/sdk/model';
import type { Body } from './ir';
import type { InterruptSource, PeripheralModule } from './peripheral';

/** 一个 GPIO 端口的静态引脚表；不存在的位为 null。 */
export interface PortPins {
  readonly id: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly pins: readonly (string | null)[];
}

export const PORTS: readonly PortPins[] = [
  {
    id: 'A',
    pins: [
      'PA0',
      'PA1',
      'PA2',
      'PA3',
      'PA4',
      'PA5',
      'PA6',
      'PA7',
      'PA8',
      'PA9',
      'PA10',
      'PA11',
      'PA12',
      'PA13',
      'PA14',
      'PA15',
    ],
  },
  {
    id: 'B',
    pins: [
      'PB0',
      'PB1',
      'PB2',
      'PB3',
      'PB4',
      'PB5',
      'PB6',
      'PB7',
      'PB8',
      'PB9',
      'PB10',
      'PB11',
      'PB12',
      'PB13',
      'PB14',
      'PB15',
    ],
  },
  {
    id: 'C',
    pins: [
      'PC0',
      'PC1',
      'PC2',
      'PC3',
      'PC4',
      'PC5',
      'PC6',
      'PC7',
      'PC8',
      'PC9',
      'PC10',
      'PC11',
      'PC12',
      'PC13',
      'PC14',
      'PC15',
    ],
  },
  {
    id: 'D',
    pins: [
      null,
      null,
      'PD2',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  },
  {
    id: 'F',
    pins: [
      'PF0',
      'PF1',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  },
];

/**
 * 复用功能输出。`active` 检查外设是否正在驱动该脚（例如 USART 已使能 TE），
 * `level` 给出推挽电平。AF 编号由 GPIOx_AFR 决定，端口位号在此静态声明。
 */
export interface AlternateDriver {
  readonly port: number;
  readonly pin: number;
  readonly af: number;
  readonly active: (b: Body) => Value<boolean>;
  /** `true` 表示输出高；openDrain 时为释放。 */
  readonly level: (b: Body) => Value<boolean>;
  /**
   * 外设输出级是否开漏。true 时 level=true 释放到 PUPDR（保留内部上/下拉），
   * level=false 拉低；false 时仍尊重 GPIOx_OTYPER。
   */
  readonly openDrain?: boolean;
}

export interface Machine {
  readonly clockFrequency: number;
  readonly cyclePs: number;
  /** HSE 晶振频率；0/缺省表示未焊晶振，HSERDY 永远为 0。 */
  readonly hseFrequency?: number;
  /**
   * 是否启用运行期 `cpuCyclePs` 状态。生产 adapter 为 true；只声明静态周期的小型
   * rig 保持缺省，避免为每个 rig 增加 DDL state。
   */
  readonly dynamicClock?: boolean;
  /** LSE/LSI 频率；缺省使用 clock-tree 的 32.768 kHz / 32 kHz。 */
  readonly lseFrequency?: number;
  readonly lsiFrequency?: number;
  readonly alternateDrivers: readonly AlternateDriver[];
  /** 本 profile 启用的外设模块；fused 基线可以为空。 */
  readonly peripherals: readonly PeripheralModule[];
  /** 从已启用模块汇总的 NVIC 中断源，按注册顺序扫描。 */
  readonly interruptSources: readonly InterruptSource[];
  /** profile 名称，仅用于诊断/测试。 */
  readonly profile: string;
}

let active: Machine | undefined;

export function activateMachine<T>(machine: Machine, run: () => T): T {
  const previous = active;

  active = machine;

  try {
    return run();
  } finally {
    active = previous;
  }
}

export function machine(): Machine {
  if (active === undefined) throw new Error('stm32g431rbt6: 在 translate 之外访问器件翻译上下文');

  return active;
}

/** 端口编号来自 GPIO 基址偏移；不存在的端口返回 -1。 */
export function portIndex(port: PortPins): number {
  return PORTS.indexOf(port);
}
