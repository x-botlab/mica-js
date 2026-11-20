import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 2×3 跳线排针行为基线：1-3 固定短接，接收端公共脚 4 在 4-6 与 2-4 之间二选一，
 * 且运行期可通过 control 输入切换。
 *
 * 三个数字源分别驱动 1、2、6，两个探针读 3 与 4；未驱动的源保持释放（level 2），
 * 探针所在网络各带 1 MΩ 下拉，因此「断开」读低、「导通」读高。
 */

interface Fixture {
  readonly board: TestBoard;
}

async function fixture(props: Record<string, unknown> = {}): Promise<Fixture> {
  const sources = ['s1', 's2', 's3'];
  const nets: NetDescription[] = [
    {
      id: 'p1drv',
      pins: [
        { instance: 'dut', pin: 'p1' },
        { instance: 's1', pin: 'y' },
      ],
    },
    {
      id: 'p3out',
      pins: [
        { instance: 'dut', pin: 'p3' },
        { instance: 'probe1', pin: 'y' },
        { instance: 'pull1', pin: 'a' },
      ],
    },
    { id: 'pull1g', pins: [{ instance: 'pull1', pin: 'b' }], voltage: 0 },
    {
      id: 'p2drv',
      pins: [
        { instance: 'dut', pin: 'p2' },
        { instance: 's2', pin: 'y' },
      ],
    },
    {
      id: 'p6drv',
      pins: [
        { instance: 'dut', pin: 'p6' },
        { instance: 's3', pin: 'y' },
      ],
    },
    {
      id: 'p4out',
      pins: [
        { instance: 'dut', pin: 'p4' },
        { instance: 'probe2', pin: 'y' },
        { instance: 'pull2', pin: 'a' },
      ],
    },
    { id: 'pull2g', pins: [{ instance: 'pull2', pin: 'b' }], voltage: 0 },
  ];

  for (const id of sources) {
    nets.push(
      { id: `${id}v`, pins: [{ instance: id, pin: 'vcc' }], voltage: 5 },
      { id: `${id}g`, pins: [{ instance: id, pin: 'gnd' }], voltage: 0 },
    );
  }

  const board = await createTestBoard('jumper-2x3', {
    nets,
    probes: ['probe1', 'probe2'],
    sources,
    resistors: [
      { id: 'pull1', resistance: 1_000_000 },
      { id: 'pull2', resistance: 1_000_000 },
    ],
    props,
  });

  return { board };
}

describe('2×3 跳线排针', () => {
  it('清单声明 6 根引脚、2 个属性以及控制/状态方法与事件', () => {
    const metadata = readMetadata('jumper-2x3');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(metadata.properties?.vs1838?.default).toBe(true);
    expect(metadata.model.methods.selectVs1838).toBeDefined();
    expect(metadata.model.methods.isVs1838).toBeDefined();
    expect(metadata.model.events.onDidClosedState2).toMatchObject({ type: 'boolean' });
  });

  it('1-3 固定短接', async () => {
    const built = await fixture();

    try {
      built.board.send('s1', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe1')).toBe(1);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('默认短接 4-6（VS1838），2-4 断开', async () => {
    const built = await fixture();

    try {
      built.board.send('s3', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(1);
      expect(built.board.topics.closedState2).toBe(true);

      built.board.send('s3', 'level', 2);
      built.board.send('s2', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('运行期 control 输入可在两条接收支路间切换', async () => {
    const built = await fixture();

    try {
      built.board.send('s3', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(1);

      built.board.send('dut', 'selectVs1838', false);
      built.board.run(US);
      expect(built.board.topics.closedState2).toBe(false);
      expect(built.board.probe('probe2')).toBe(0);

      built.board.send('s3', 'level', 2);
      built.board.send('s2', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(1);

      built.board.send('dut', 'selectVs1838', true);
      built.board.run(US);
      expect(built.board.topics.closedState2).toBe(true);
      expect(built.board.probe('probe2')).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });

  it('vs1838 为 false 时短接 2-4，4-6 断开', async () => {
    const built = await fixture({ vs1838: false });

    try {
      built.board.send('s2', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(1);
      expect(built.board.topics.closedState2).toBe(false);

      built.board.send('s2', 'level', 2);
      built.board.send('s3', 'level', 1);
      built.board.run(US);
      expect(built.board.probe('probe2')).toBe(0);
      expect(built.board.faults).toEqual([]);
    } finally {
      built.board.dispose();
    }
  });
});
