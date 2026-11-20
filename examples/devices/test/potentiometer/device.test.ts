import { describe, expect, it } from 'vitest';
import { readMetadata } from '../harness.ts';
import { createPotBoard, expectedVoltage, VDD } from './harness.ts';

/**
 * 电位器基线：真实电阻网络分压、运行期设位置、有限端点、外部负载、浮空与非法输入。
 * 所有电压断言都来自 `@mica-js/simulator` 的线性求解，不使用宿主注入的假电压。
 */

async function voltageOf(board: Awaited<ReturnType<typeof createPotBoard>>): Promise<number> {
  return (await board.query('dut', 'getVoltage')) as number;
}

function eventValues(board: Awaited<ReturnType<typeof createPotBoard>>, name: string): number[] {
  return board.events.filter((event) => event.name === name).map((event) => event.value as number);
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

describe('器件声明', () => {
  it('清单声明 VDD/GND/滑臂三根引脚、两个事件与三个方法', () => {
    const metadata = readMetadata('potentiometer');

    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual(['gnd', 'vdd', 'wiper']);
    expect(metadata.properties?.trackResistance?.default).toBe(10000);
    expect(metadata.properties?.endResistance?.default).toBe(10);
    expect(metadata.properties?.initialPosition?.default).toBe(0.5);

    for (const name of ['setPosition', 'getPosition', 'getVoltage'])
      expect(metadata.model.methods[name]).toBeDefined();
    for (const name of ['onDidPosition', 'onDidVoltage'])
      expect(metadata.model.events[name]).toMatchObject({ type: 'number' });
  });
});

describe('电阻分压', () => {
  it('默认 10 kΩ 轨道、50% 位置在 3.3 V 下得到约 1.65 V', async () => {
    const board = await createPotBoard();

    try {
      const voltage = await voltageOf(board);

      expect(await board.query('dut', 'getPosition')).toBe(0.5);
      expect(voltage).toBeCloseTo(expectedVoltage(0.5), 12);
      expect(voltage).toBeCloseTo(1.65, 6);
      expect(eventValues(board, 'onDidPosition')[0]).toBe(0.5);
      expect(eventValues(board, 'onDidVoltage')[0]).toBeCloseTo(voltage, 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('运行期 setPosition 立即改变两段电阻与求解电压', async () => {
    const board = await createPotBoard({ props: { initialPosition: 0.25 } });

    try {
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0.25), 12);

      board.send('dut', 'setPosition', 0.75);
      board.run(1_000_000);

      expect(await board.query('dut', 'getPosition')).toBe(0.75);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0.75), 12);
      expect(eventValues(board, 'onDidPosition').at(-1)).toBe(0.75);
      expect(eventValues(board, 'onDidVoltage').at(-1)).toBeCloseTo(expectedVoltage(0.75), 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('position 0/1 仍保留有限端点电阻，不出现 0 V 或满电源硬短路', async () => {
    const board = await createPotBoard();

    try {
      board.send('dut', 'setPosition', 0);
      board.run(1_000_000);
      const low = await voltageOf(board);

      expect(low).toBeGreaterThan(0);
      expect(low).toBeCloseTo(expectedVoltage(0), 12);

      board.send('dut', 'setPosition', 1);
      board.run(1_000_000);
      const high = await voltageOf(board);

      expect(high).toBeLessThan(VDD);
      expect(high).toBeCloseTo(expectedVoltage(1), 12);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('重复 setPosition 不发新的位置事件，也不重写电阻', async () => {
    const board = await createPotBoard();

    try {
      const positions = eventValues(board, 'onDidPosition').length;
      const voltages = eventValues(board, 'onDidVoltage').length;

      board.send('dut', 'setPosition', 0.5);
      board.run(1_000_000);

      expect(eventValues(board, 'onDidPosition')).toHaveLength(positions);
      expect(eventValues(board, 'onDidVoltage')).toHaveLength(voltages);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0.5), 12);

      board.send('dut', 'setPosition', 0.25);
      board.run(1_000_000);

      expect(eventValues(board, 'onDidPosition')).toHaveLength(positions + 1);
      expect(eventValues(board, 'onDidPosition').at(-1)).toBe(0.25);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('外部负载与电位器下半段并联，电压低于空载分压', async () => {
    const board = await createPotBoard({ loadResistance: 10_000 });

    try {
      const loaded = await voltageOf(board);

      expect(loaded).toBeCloseTo(expectedVoltage(0.5, { loadResistance: 10_000 }), 12);
      expect(loaded).toBeLessThan(expectedVoltage(0.5));
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('轨道参数改变分压比', async () => {
    const board = await createPotBoard({
      props: { trackResistance: 1000, endResistance: 1, initialPosition: 0.3 },
    });

    try {
      expect(await voltageOf(board)).toBeCloseTo(
        expectedVoltage(0.3, { trackResistance: 1000, endResistance: 1 }),
        12,
      );
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('VDD 为 0 V 时滑臂电压为 0，不叠加偏移', async () => {
    const board = await createPotBoard({ supplyVoltage: 0 });

    try {
      expect(await voltageOf(board)).toBe(0);
      expect(eventValues(board, 'onDidVoltage')).toContain(0);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });
});

describe('边界', () => {
  it('无 VDD/GND 时滑臂浮空，getVoltage 返回可恢复的 MethodError', async () => {
    const board = await createPotBoard({ connectSupply: false });

    try {
      expect(board.probe('wiperProbe')).toBe(2);
      await expect(board.query('dut', 'getVoltage')).rejects.toMatchObject({
        name: 'MethodError',
        code: 'voltage/unavailable',
      });
      expect(eventValues(board, 'onDidVoltage')).toEqual([]);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('setPosition 用 MethodError 拒绝非法值，且板保持可恢复', async () => {
    const board = await createPotBoard();

    try {
      for (const value of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY])
        expect(captureError(() => board.send('dut', 'setPosition', value))).toMatchObject({
          name: 'MethodError',
          code: 'potentiometer/invalid-position',
        });

      board.run(1_000_000);
      expect(await board.query('dut', 'getPosition')).toBe(0.5);
      expect(await voltageOf(board)).toBeCloseTo(expectedVoltage(0.5), 12);
      expect(board.faults).toEqual([]);

      board.send('dut', 'setPosition', 0.25);
      board.run(1_000_000);
      expect(await board.query('dut', 'getPosition')).toBe(0.25);
      expect(board.faults).toEqual([]);
    } finally {
      board.dispose();
    }
  });

  it('非法构造参数在创建期被拒绝', async () => {
    // DDL 的引脚初始电阻先于属性断言构造；非法位置可能先报电阻越界。
    await expect(createPotBoard({ props: { initialPosition: 2 } })).rejects.toThrow(
      /Resistance|initialPosition/,
    );
    await expect(createPotBoard({ props: { trackResistance: 0 } })).rejects.toThrow(
      /Resistance|trackResistance/,
    );
    await expect(createPotBoard({ props: { endResistance: 0 } })).rejects.toThrow(
      /Resistance|endResistance/,
    );
  });

  it('直接向 DDL 输入通道注入非法位置会使真实板 faulted', async () => {
    const board = await createPotBoard();

    try {
      board.injectInput('dut', 'setPosition', Number.NaN);
      expect(() => board.run(1_000_000)).toThrow(/setPosition/);
      expect(board.faults.join(';')).toMatch(/setPosition/);
    } finally {
      board.dispose();
    }
  });
});
