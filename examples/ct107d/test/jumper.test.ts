import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 两脚跳线行为基线：`closed` 为 true 时两端导通、false 时断开。
 *
 * 一端由数字源驱动，另一端用探针加 1 MΩ 下拉读数：闭合时读到高，断开时读到低。
 */

async function fixture(props: Record<string, unknown> = {}): Promise<TestBoard> {
  const nets: NetDescription[] = [
    {
      id: 'drv',
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

  return createTestBoard('jumper', {
    nets,
    probes: ['probe'],
    sources: ['src'],
    resistors: [{ id: 'pull', resistance: 1_000_000 }],
    props,
  });
}

describe('两脚跳线', () => {
  it('元数据声明 2 根引脚、3 个属性且没有端口', () => {
    const metadata = readMetadata('jumper') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default: unknown }>>;
      readonly ports: Readonly<Record<string, unknown>>;
    };

    expect(Object.keys(metadata.pins).sort()).toEqual(['a', 'b']);
    expect(metadata.properties.closed?.default).toBe(true);
    expect(Object.keys(metadata.ports)).toEqual([]);
  });

  it('默认插上跳线帽时两端导通', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(1);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('拔掉跳线帽时两端断开', async () => {
    const board = await fixture({ closed: false });

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
