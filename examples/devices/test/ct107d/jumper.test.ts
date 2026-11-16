import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from './harness.ts';
import type { NetDescription, TestBoard } from './harness.ts';

/**
 * 两脚跳线行为基线：`closed` 为装配初值，运行期 `setClosed` 可切换，`closedState` 回传
 * 当前状态并发出 `onDidClosedState`。
 *
 * 一端由数字源驱动，另一端用探针加 1 MΩ 下拉读数：闭合时读到高，断开时读到低。悬空
 * 用例去掉下拉，确认断开后 `b` 真正浮空，而不是残留有限大假支路。
 */
async function fixture(props: Record<string, unknown> = {}, pull = true): Promise<TestBoard> {
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
        ...(pull ? [{ instance: 'pull', pin: 'a' }] : []),
      ],
    },
    ...(pull ? [{ id: 'pullg', pins: [{ instance: 'pull', pin: 'b' }], voltage: 0 }] : []),
    { id: 'srcv', pins: [{ instance: 'src', pin: 'vcc' }], voltage: 5 },
    { id: 'srcg', pins: [{ instance: 'src', pin: 'gnd' }], voltage: 0 },
  ];

  return createTestBoard('jumper', {
    nets,
    probes: ['probe'],
    sources: ['src'],
    ...(pull ? { resistors: [{ id: 'pull', resistance: 1_000_000 }] } : {}),
    props,
  });
}

describe('两脚跳线', () => {
  it('清单声明 2 根引脚、装配与显示属性以及控制/状态方法与事件', () => {
    const metadata = readMetadata('jumper');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['a', 'b']);
    expect(metadata.properties?.closed?.default).toBe(true);
    expect(metadata.model.methods.setClosed).toBeDefined();
    expect(metadata.model.methods.isClosed).toBeDefined();
    expect(metadata.model.events.onDidClosedState).toMatchObject({ type: 'boolean' });
  });

  it('默认插上跳线帽时两端导通', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(1);
      expect(board.topics.closedState).toBe(true);
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
      expect(board.topics.closedState).toBe(false);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('运行期 setClosed 方法可反复切换闭合状态', async () => {
    const board = await fixture();

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(1);

      board.send('dut', 'setClosed', false);
      board.run(US);
      expect(board.probe('probe')).toBe(0);
      expect(board.topics.closedState).toBe(false);

      board.send('dut', 'setClosed', true);
      board.run(US);
      expect(board.probe('probe')).toBe(1);
      expect(board.topics.closedState).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('断开后 b 真正悬空，没有残留 1 GΩ 类假支路', async () => {
    const board = await fixture({}, false);

    try {
      board.send('src', 'level', 1);
      board.run(US);
      expect(board.probe('probe')).toBe(1);

      board.send('dut', 'setClosed', false);
      board.run(US);
      expect(board.probe('probe')).toBe(2);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
