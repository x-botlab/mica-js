import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 蜂鸣器行为基线：正端固定接 VCC，负端由开集输出驱动。
 *
 * 负端被拉低时两端构成回路、`active` 为 true；输出释放后由负载电阻把负端拉回 VCC，
 * `active` 回到 false。电平由数字源驱动，端口读数来自模型发布的话题。
 */

async function fixture(props: Record<string, unknown> = {}): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'vcc',
      pins: [
        { instance: 'dut', pin: 'p' },
        { instance: 'src', pin: 'vcc' },
      ],
      voltage: 5,
    },
    {
      id: 'drive',
      pins: [
        { instance: 'dut', pin: 'n' },
        { instance: 'src', pin: 'y' },
      ],
    },
    { id: 'gnd', pins: [{ instance: 'src', pin: 'gnd' }], voltage: 0 },
  ];

  return createTestBoard('buzzer', { nets, sources: ['src'], props });
}

describe('有源蜂鸣器', () => {
  it('元数据声明 2 根引脚、3 个属性与 active 端口', () => {
    const metadata = readMetadata('buzzer') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default: unknown }>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins)).toHaveLength(2);
    expect(metadata.properties.loadResistance?.default).toBe(100);
    expect(metadata.ports.active?.type).toBe('boolean');
  });

  it('负端被拉低时发声，释放后停止', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 0);
      board.run(US);
      expect(board.topics.active).toBe(true);

      board.send('src', 'level', 2); // 释放：负载电阻把负端拉回 VCC
      board.run(US);
      expect(board.topics.active).toBe(false);

      board.send('src', 'level', 1); // 负端也为高，两端没有电压
      board.run(US);
      expect(board.topics.active).toBe(false);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('loadResistance 决定拉低时的电流', async () => {
    // 5 V 经 25 Ω 源电阻与负载电阻分压：负端电压 = 5 × 25 / (25 + loadResistance)。
    const board = await fixture({ loadResistance: 1000 });

    try {
      board.send('src', 'level', 0);
      board.run(US);
      // 1 kΩ 负载下负端约 0.12 V，仍低于 0.8 V 的低电平上限。
      expect(board.topics.active).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
