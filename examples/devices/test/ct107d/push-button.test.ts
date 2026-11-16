import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 两脚抽象轻触开关的行为基线。
 *
 * 一端由数字源驱动，另一端用 1 MΩ 下拉；按下时 1 Ω 支路把高电平带到 b，松开时模型
 * 移除支路，b 回到低电平。若松开仍保留 1 GΩ 假支路，5 V × 1 MΩ / (1 GΩ + 1 MΩ) 会让
 * 探针读到高，因此该用例同时回归“松开不漏电”。
 */
async function fixture(): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'drive',
      pins: [
        { instance: 'dut', pin: 'a' },
        { instance: 'src', pin: 'y' },
      ],
    },
    {
      id: 'out',
      pins: [
        { instance: 'dut', pin: 'b' },
        { instance: 'probe', pin: 'y' },
        { instance: 'pull', pin: 'a' },
      ],
    },
    { id: 'pullg', pins: [{ instance: 'pull', pin: 'b' }], voltage: 0 },
    { id: 'srcv', pins: [{ instance: 'src', pin: 'vcc' }], voltage: 5 },
    { id: 'srcg', pins: [{ instance: 'src', pin: 'gnd' }], voltage: 0 },
  ];

  return createTestBoard('push-button', {
    nets,
    probes: ['probe'],
    sources: ['src'],
    resistors: [{ id: 'pull', resistance: 1_000_000 }],
  });
}

describe('两脚轻触开关', () => {
  it('清单声明 a/b 两脚、公共方法与事件', () => {
    const manifest = readMetadata('push-button');

    expect(Object.keys(manifest.pins ?? {}).sort()).toEqual(['a', 'b']);
    expect(manifest.model.methods.press).toBeDefined();
    expect(manifest.model.methods.isPressed).toBeDefined();
    expect(Object.keys(manifest.model.events)).toEqual(['onDidPress']);
    expect((manifest as unknown as Record<string, unknown>).view2d).toBeUndefined();
  });

  it('按下闭合、松开移除支路且不漏电，事件与查询跟随模型', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(0);
      expect(board.topics.press).toBe(false);
      expect(await board.query('dut', 'isPressed')).toBe(false);

      board.send('dut', 'press', true);
      board.run(US);
      expect(board.probe('probe')).toBe(1);
      expect(board.topics.press).toBe(true);
      expect(await board.query('dut', 'isPressed')).toBe(true);

      board.send('dut', 'press', false);
      board.run(US);
      // 1 MΩ 下拉读到低，证明模型已经移除支路，而不是留下 1 GΩ 假闭合。
      expect(board.probe('probe')).toBe(0);
      expect(board.topics.press).toBe(false);
      expect(await board.query('dut', 'isPressed')).toBe(false);
      expect(board.history.press).toEqual([false, true, false]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('源也释放后两端悬空，不产生模型错误或残余导通', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 1);
      board.send('dut', 'press', true);
      board.run(US);
      expect(board.probe('probe')).toBe(1);

      board.send('dut', 'press', false);
      board.send('src', 'level', 2);
      board.run(US);

      expect(board.probe('probe')).toBe(0);
      expect(board.topics.press).toBe(false);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
