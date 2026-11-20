import { describe, expect, it } from 'vitest';
import { createBoardWith, readMetadata, US } from '../harness.ts';

/**
 * CT107D 的 J2 第 5 脚是红外发射管支路 `N_A2`。本用例把该脚与 ir-emitter 的 mod
 * 接在同一网络，再用电平源模拟该数字支路上的调制信号；证明接法可行，同时不改变
 * jumper-2x3 现有的 1-3 固定短接与 4-6/2-4 接收选择行为。
 */

describe('jumper-2x3 第 5 脚到 ir-emitter.mod', () => {
  it('N_A2 支路的高/低电平直接调制发射端载波', async () => {
    const board = await createBoardWith(
      [
        { id: 'j2', type: 'jumper-2x3' },
        { id: 'tx', type: 'ir-emitter' },
      ],
      {
        nets: [
          {
            id: 'five',
            pins: [
              { instance: 'tx', pin: 'vcc' },
              { instance: 'nA2Drv', pin: 'vcc' },
            ],
            voltage: 5,
          },
          {
            id: 'gnd',
            pins: [
              { instance: 'tx', pin: 'gnd' },
              { instance: 'nA2Drv', pin: 'gnd' },
            ],
            voltage: 0,
          },
          {
            id: 'n_a2',
            pins: [
              { instance: 'j2', pin: 'p5' },
              { instance: 'tx', pin: 'mod' },
              { instance: 'nA2Drv', pin: 'y' },
            ],
          },
        ],
        sources: ['nA2Drv'],
      },
    );

    try {
      board.run(0);
      expect(board.call('tx', 'isCarrier')).toBe(false);

      board.send('nA2Drv', 'level', 1);
      board.run(US);
      expect(board.call('tx', 'isCarrier')).toBe(true);

      board.send('nA2Drv', 'level', 0);
      board.run(US);
      expect(board.call('tx', 'isCarrier')).toBe(false);
      expect(board.faults).toEqual([]);

      // J2 的选择仍由既有属性/方法控制，第 5 脚只是 N_A2 的连接点。
      const jumper = readMetadata('jumper-2x3');
      expect(jumper.pins?.p5).toBeDefined();
      expect(board.call('j2', 'isVs1838')).toBe(true);
    } finally {
      board.dispose();
    }
  });
});
