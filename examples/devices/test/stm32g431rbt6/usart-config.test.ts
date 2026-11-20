import { describe, expect, it } from 'vitest';
import { USARTS } from '@mica-js/stm32g431rbt6-core/usart';

describe('STM32G431RBT6 USART 配置表', () => {
  it('只登记 G431RB 实际存在的 3 USART + UART4 + LPUART1', () => {
    expect(USARTS.map((config) => [config.index, config.kind, config.base, config.irq])).toEqual([
      [1, 'usart', 0x4001_3800, 37],
      [2, 'usart', 0x4000_4400, 38],
      [3, 'usart', 0x4000_4800, 39],
      [4, 'uart', 0x4000_4c00, 52],
      [5, 'lpuart', 0x4000_8000, 91],
    ]);
    expect(USARTS.some((config) => config.base === 0x4000_5000)).toBe(false);
  });

  it('USART1/2/3 的 RX 引脚包含数据手册 AF7 的真实引脚', () => {
    const pins = (index: number) =>
      USARTS[index]!.rxPins.map((pin) => `${pin.port}:${pin.pin}:${pin.af}`);

    expect(pins(0)).toEqual(expect.arrayContaining(['0:10:7', '1:7:7', '2:5:7']));
    expect(pins(1)).toEqual(expect.arrayContaining(['0:3:7', '0:15:7', '1:4:7']));
    expect(pins(2)).toEqual(expect.arrayContaining(['1:11:7', '1:8:7', '2:11:7']));
  });

  it('UART4 与 LPUART1 使用各自真实的 AF', () => {
    expect(USARTS[3]!.txPins).toEqual([{ port: 2, pin: 10, af: 5 }]);
    expect(USARTS[3]!.rxPins).toEqual([{ port: 2, pin: 11, af: 5 }]);
    expect(USARTS[4]!.txPins).toEqual(
      expect.arrayContaining([
        { port: 0, pin: 2, af: 12 },
        { port: 1, pin: 11, af: 8 },
        { port: 2, pin: 1, af: 8 },
      ]),
    );
    expect(USARTS[4]!.rxPins).toEqual(
      expect.arrayContaining([
        { port: 0, pin: 3, af: 12 },
        { port: 1, pin: 10, af: 8 },
        { port: 2, pin: 0, af: 8 },
      ]),
    );
  });
});
