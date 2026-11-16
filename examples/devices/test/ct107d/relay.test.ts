import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 继电器行为基线：线圈驱动端由开集输出拉低时吸合，`com`–`no` 触点随之闭合。
 *
 * 线圈驱动端与触点分别由数字源驱动；触点输出用探针加 1 MΩ 下拉读数，因此断开时读到
 * 低、闭合时读到高。第二组触点（`com2`–`no2`）与第一组同步动作。
 */

interface Fixture {
  readonly board: TestBoard;
  driveCoil(level: number): void;
}

async function fixture(props: Record<string, unknown> = {}, coilSupply = 5): Promise<Fixture> {
  const nets: NetDescription[] = [
    {
      id: 'coilv',
      pins: [
        { instance: 'dut', pin: 'vcc' },
        { instance: 'coilSrc', pin: 'vcc' },
      ],
      voltage: coilSupply,
    },
    {
      id: 'coil',
      pins: [
        { instance: 'dut', pin: 'coil' },
        { instance: 'coilSrc', pin: 'y' },
      ],
    },
    { id: 'coilg', pins: [{ instance: 'coilSrc', pin: 'gnd' }], voltage: 0 },
    {
      id: 'contactv',
      pins: [
        { instance: 'contactSrc', pin: 'vcc' },
        { instance: 'contactSrc2', pin: 'vcc' },
      ],
      voltage: 5,
    },
    { id: 'contactg', pins: [{ instance: 'contactSrc', pin: 'gnd' }], voltage: 0 },
    { id: 'contactg2', pins: [{ instance: 'contactSrc2', pin: 'gnd' }], voltage: 0 },
    {
      id: 'com',
      pins: [
        { instance: 'dut', pin: 'com' },
        { instance: 'contactSrc', pin: 'y' },
      ],
    },
    {
      id: 'no',
      pins: [
        { instance: 'dut', pin: 'no' },
        { instance: 'probe', pin: 'y' },
        { instance: 'pull', pin: 'a' },
      ],
    },
    { id: 'pullg', pins: [{ instance: 'pull', pin: 'b' }], voltage: 0 },
    {
      id: 'com2',
      pins: [
        { instance: 'dut', pin: 'com2' },
        { instance: 'contactSrc2', pin: 'y' },
      ],
    },
    {
      id: 'no2',
      pins: [
        { instance: 'dut', pin: 'no2' },
        { instance: 'probe2', pin: 'y' },
        { instance: 'pull2', pin: 'a' },
      ],
    },
    { id: 'pull2g', pins: [{ instance: 'pull2', pin: 'b' }], voltage: 0 },
  ];

  const board = await createTestBoard('relay', {
    nets,
    probes: ['probe', 'probe2'],
    sources: ['coilSrc', 'contactSrc', 'contactSrc2'],
    resistors: [
      { id: 'pull', resistance: 1_000_000 },
      { id: 'pull2', resistance: 1_000_000 },
    ],
    props,
  });

  return { board, driveCoil: (level) => board.send('coilSrc', 'level', level) };
}

describe('电磁继电器', () => {
  it('元数据声明 6 根引脚、5 个属性与 energized 端口', () => {
    const metadata = readMetadata('relay') as {
      readonly pins: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, { readonly default: unknown }>>;
      readonly ports: Readonly<Record<string, { readonly type: string }>>;
    };

    expect(Object.keys(metadata.pins).sort()).toEqual(['coil', 'com', 'com2', 'no', 'no2', 'vcc']);
    expect(metadata.properties.coilResistance?.default).toBe(400);
    expect(metadata.ports.energized?.type).toBe('boolean');
  });

  it('线圈拉低时吸合并闭合两组触点，释放后断开', async () => {
    const built = await fixture();

    try {
      built.board.send('contactSrc', 'level', 1);
      built.board.send('contactSrc2', 'level', 1);

      built.driveCoil(0);
      built.board.run(US);
      expect(built.board.topics.energized).toBe(true);
      expect(built.board.probe('probe')).toBe(1);
      expect(built.board.probe('probe2')).toBe(1);

      built.driveCoil(2); // 释放：线圈正端仍为高，驱动端由 400 Ω 线圈拉高
      built.board.run(US);
      expect(built.board.topics.energized).toBe(false);
      expect(built.board.probe('probe')).toBe(0);
      expect(built.board.probe('probe2')).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('线圈正端为低时不吸合', async () => {
    const built = await fixture({}, 0);

    try {
      built.board.send('coilSrc', 'level', 0);
      built.board.send('contactSrc', 'level', 1);
      built.board.run(US);

      expect(built.board.topics.energized).toBe(false);
      expect(built.board.probe('probe')).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('contactResistance 决定闭合时的导通能力', async () => {
    const built = await fixture({ contactResistance: 1_000_000 });

    try {
      built.board.send('contactSrc', 'level', 1);
      built.driveCoil(0);
      built.board.run(US);

      // 1 MΩ 触点与 1 MΩ 下拉分压，触点输出落在 2.5 V，既非高也非低。
      expect(built.board.topics.energized).toBe(true);
      expect(built.board.probe('probe')).toBe(2);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
