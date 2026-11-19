import { MethodError } from '@mica-js/sdk/fused';
import { describe, expect, it } from 'vitest';
import { createTestBoard, readMetadata, US } from '../harness.ts';
import type { TestBoard } from '../harness.ts';
import { activeEvents, createHallFixture as fixture, isActive, setField } from './fixture.ts';

/**
 * 开关型霍尔传感器的行为基线。
 *
 * OUT 是低有效开漏输出：测试用 10 kΩ 上拉到 5 V 后经探针采样。供电默认接固定的
 * 5 V/0 V；需要验证掉电行为时改由测试源驱动 VCC。磁场只经公共方法提交，不绕过
 * 适配器直接写 DDL 输入。
 */

interface InvalidCreationCase {
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly message: RegExp;
}

const INVALID_CREATION_PROPS: readonly InvalidCreationCase[] = [
  { name: '负初始磁场', props: { field: -1 }, message: /field must be within 0\.\.1000 mT/ },
  { name: '过大初始磁场', props: { field: 1001 }, message: /field must be within 0\.\.1000 mT/ },
  {
    name: '吸合点等于释放点',
    props: { operatePoint: 10, releasePoint: 10 },
    message: /operatePoint must be greater than releasePoint/,
  },
  {
    name: '吸合点低于释放点',
    props: { operatePoint: 5, releasePoint: 10 },
    message: /operatePoint must be greater than releasePoint/,
  },
  {
    name: '吸合点超出范围',
    props: { operatePoint: 1001 },
    message: /operatePoint must be within 0\.\.1000 mT/,
  },
  {
    name: '输出电阻为零',
    props: { outputResistance: 0 },
    message: /outputResistance must be within the supported range/,
  },
  {
    name: '低/高门限顺序非法',
    props: { lowThreshold: 2, highThreshold: 1 },
    message: /Pin thresholds must satisfy low < high/,
  },
  {
    name: '高门限超压',
    props: { lowThreshold: 0.8, highThreshold: 6 },
    message: /highThreshold must be above lowThreshold and within 5 V/,
  },
];

function expectInvalidField(board: TestBoard, value: number): void {
  let error: unknown;
  try {
    board.call('dut', 'setField', value);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(MethodError);
  if (!(error instanceof MethodError)) throw new Error('expected MethodError');
  expect(error.code).toBe('hall/invalid-field');
  expect(error.message).toMatch(/finite value within 0\.\.1000 mT/);
}

describe('hall', () => {
  it('清单声明三根引脚、迟滞阈值方法与 active 事件', () => {
    const metadata = readMetadata('hall');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['gnd', 'out', 'vcc']);
    expect(metadata.properties?.field?.default).toBe(0);
    expect(metadata.properties?.operatePoint?.default).toBe(15);
    expect(metadata.properties?.releasePoint?.default).toBe(10);
    expect(metadata.model.methods.setField).toBeDefined();
    expect(metadata.model.methods.getField).toBeDefined();
    expect(metadata.model.methods.isActive).toBeDefined();
    expect(metadata.model.events.onDidActive).toMatchObject({ type: 'boolean' });
  });

  it.each(INVALID_CREATION_PROPS)('创建期拒绝非法参数：$name', async ({ props, message }) => {
    await expect(createTestBoard('hall', { nets: [], props })).rejects.toThrow(message);
  });

  it('吸合点、释放点与中间迟滞区', async () => {
    const board = await fixture();

    try {
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      setField(board, 14.9);
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      setField(board, 15);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);

      // 10 与 15 之间保持吸合，不因磁场下降立即释放。
      setField(board, 10.1);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);

      setField(board, 10);
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      // 释放点与吸合点之间仍保持释放。
      setField(board, 14.9);
      expect(isActive(board)).toBe(false);

      setField(board, 15);
      expect(isActive(board)).toBe(true);
      expect(activeEvents(board)).toEqual([false, true, false, true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('初始磁场达到吸合点时上电即吸合', async () => {
    const board = await fixture({ field: 20 });

    try {
      expect(board.call('dut', 'getField')).toBe(20);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);
      expect(activeEvents(board)).toEqual([true]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('开漏输出需要外部上拉；未上拉时释放态悬空', async () => {
    const board = await fixture({ pullup: false });

    try {
      // 释放时没有上拉，探针读到未知电平；吸合时仍能把 OUT 拉到地。
      expect(board.probe('outProbe')).toBe(2);

      setField(board, 20);
      expect(board.probe('outProbe')).toBe(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('VCC 掉电释放输出并清除锁存，恢复后按当前磁场重新判定', async () => {
    const board = await fixture({ drivenVcc: true, field: 20 });

    try {
      // vccDrv 初始 level=2（释放），器件未上电。
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      board.send('vccDrv', 'level', 1);
      board.run(US);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);

      board.send('vccDrv', 'level', 0);
      board.run(US);
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      board.send('vccDrv', 'level', 1);
      board.run(US);
      expect(isActive(board)).toBe(true);
      expect(board.probe('outProbe')).toBe(0);

      // 掉电时磁场仍在迟滞区：重新上电不继承掉电前的吸合状态。
      setField(board, 12);
      expect(isActive(board)).toBe(true);
      board.send('vccDrv', 'level', 0);
      board.run(US);
      expect(isActive(board)).toBe(false);
      board.send('vccDrv', 'level', 1);
      board.run(US);
      expect(isActive(board)).toBe(false);
      expect(board.probe('outProbe')).toBe(1);

      // 未上电时提交的磁场仍会保存，恢复供电后按它重新判定。
      board.send('vccDrv', 'level', 0);
      board.run(US);
      setField(board, 20);
      expect(isActive(board)).toBe(false);
      board.send('vccDrv', 'level', 1);
      board.run(US);
      expect(isActive(board)).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('重复设置同一磁场不重复发 active 事件', async () => {
    const board = await fixture();

    try {
      setField(board, 20);
      const before = activeEvents(board).length;
      setField(board, 20);
      setField(board, 20);
      expect(activeEvents(board)).toHaveLength(before);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('拒绝非法磁场后保持 MethodError 语义并可恢复', async () => {
    const board = await fixture();

    try {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1000.1]) {
        expectInvalidField(board, value);
      }
      expect(board.call('dut', 'getField')).toBe(0);
      expect(board.faults).toEqual([]);

      setField(board, 20);
      expect(board.call('dut', 'getField')).toBe(20);
      expect(isActive(board)).toBe(true);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});
