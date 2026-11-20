import { describe, expect, it } from 'vitest';
import { readMetadata } from '../harness.ts';
import {
  createLm324Board,
  expectedGain,
  expectedLoadedVoltage,
  expectedRuntimeInput,
} from './harness.ts';

const US = 1_000_000;

function captureError(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('器件声明', () => {
  it('清单明确是 CT107D fused 可调放大器，而不是通用四运放', () => {
    const metadata = readMetadata('lm324');

    expect(metadata.displayName).toContain('CT107D');
    expect(metadata.displayName).toContain('融合式');
    expect(metadata.description).toContain('不是通用 14 脚 LM324');
    expect(Object.keys(metadata.pins ?? {}).sort()).toEqual([
      'gnd',
      'inMinus',
      'inPlus',
      'out',
      'vcc',
    ]);
    expect(metadata.properties?.feedbackResistance?.default).toBe(100_000);
    expect(metadata.properties?.potResistance?.default).toBe(10_000);
    expect(metadata.properties?.minPotResistance?.default).toBe(100);
    expect(metadata.properties?.initialWiper?.default).toBe(0);
    expect(metadata.properties?.outputResistance?.default).toBe(25);
    expect(metadata.properties?.outputResistance?.max).toBe(100_000);
    expect(metadata.properties?.updatePeriodUs?.default).toBe(10);

    for (const name of ['setWiper', 'getWiper', 'getGain'])
      expect(metadata.model.methods[name]).toBeDefined();
    expect(metadata.model.events.onDidSetting).toEqual({ ref: 'AmplifierSetting' });
    expect(metadata.model.types.AmplifierSetting).toMatchObject({ type: 'object' });
  });
});

describe('初始增益与差分级', () => {
  it('默认 RB4 位置 0 给出增益 21，并把 50 mV 差分放大到 1.05 V', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.05 });

    try {
      expect(await fixture.board.query('dut', 'getWiper')).toBe(0);
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(21, 12);
      expect(await fixture.output()).toBeCloseTo(0.05 * 21, 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it('反馈电阻与电位器参数共同决定增益映射', async () => {
    const props = {
      feedbackResistance: 50_000,
      potResistance: 20_000,
      minPotResistance: 200,
      initialWiper: 0.5,
    };
    const fixture = await createLm324Board({
      plusVoltage: 0.1,
      props,
    });

    try {
      const gain = expectedGain(0.5, {
        feedbackResistance: 50_000,
        potResistance: 20_000,
        minPotResistance: 200,
      });
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(gain, 12);
      expect(await fixture.output()).toBeCloseTo(0.1 * gain, 9);
    } finally {
      fixture.board.dispose();
    }
  });

  it('理想差分：共模电压不产生输出，反向差分夹到 0 V', async () => {
    const common = await createLm324Board({ plusVoltage: 0.1, minusVoltage: 0.1 });

    try {
      expect(await common.output()).toBe(0);
    } finally {
      common.board.dispose();
    }

    const reversed = await createLm324Board({ plusVoltage: 0.1, minusVoltage: 0.2 });

    try {
      expect(await reversed.output()).toBe(0);
    } finally {
      reversed.board.dispose();
    }
  });
});

describe('运行期电位器与增益', () => {
  it('setWiper 改变增益，事件发布位置与增益快照', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.05 });

    try {
      const initial = fixture.board.events.find((event) => event.name === 'onDidSetting');
      expect(initial?.value).toMatchObject({ position: 0, gain: 21 });

      fixture.board.send('dut', 'setWiper', 0.5);
      fixture.runPeriods(2);

      const gain = expectedGain(0.5);
      expect(await fixture.board.query('dut', 'getWiper')).toBe(0.5);
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(gain, 12);
      expect(await fixture.output()).toBeCloseTo(0.05 * gain, 9);

      const latest = fixture.board.events.filter((event) => event.name === 'onDidSetting').at(-1);
      expect(latest?.value).toMatchObject({ position: 0.5 });
      expect((latest?.value as { gain: number }).gain).toBeCloseTo(gain, 12);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it('位置 1 取端停电阻，增益有限；有限越界被钳位；非有限值用业务错误拒绝并可恢复', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.05 });

    try {
      fixture.board.send('dut', 'setWiper', 1);
      fixture.runPeriods(2);
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(2001, 12);

      fixture.board.send('dut', 'setWiper', -0.5);
      fixture.runPeriods(2);
      expect(await fixture.board.query('dut', 'getWiper')).toBe(0);

      fixture.board.send('dut', 'setWiper', 2);
      fixture.runPeriods(2);
      expect(await fixture.board.query('dut', 'getWiper')).toBe(1);

      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(captureError(() => fixture.board.send('dut', 'setWiper', value))).toMatchObject({
          name: 'MethodError',
          code: 'lm324/invalid-wiper',
        });
      }

      // 非法调用不改变板状态；随后合法设置仍可恢复。
      fixture.board.send('dut', 'setWiper', 0.25);
      fixture.runPeriods(2);
      expect(await fixture.board.query('dut', 'getWiper')).toBe(0.25);
      expect(await fixture.board.query('dut', 'getGain')).toBeCloseTo(expectedGain(0.25), 12);
      expect(await fixture.output()).toBeCloseTo(0.05 * expectedGain(0.25), 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it('相同位置不重复发布增益事件', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.05 });

    try {
      fixture.board.send('dut', 'setWiper', 0.5);
      fixture.runPeriods(2);
      const count = fixture.board.events.filter((event) => event.name === 'onDidSetting').length;

      fixture.board.send('dut', 'setWiper', 0.5);
      fixture.runPeriods(2);

      expect(fixture.board.events.filter((event) => event.name === 'onDidSetting')).toHaveLength(
        count,
      );
    } finally {
      fixture.board.dispose();
    }
  });
});

describe('运行期模拟输入', () => {
  it('外部源电平经 series/shunt 分压后，按周期采样改变输出', async () => {
    const seriesResistance = 10_000;
    const shuntResistance = 220;
    const fixture = await createLm324Board({
      runtimeInput: { seriesResistance, shuntResistance },
    });
    const setLevel = fixture.setSourceLevel;

    if (setLevel === undefined) throw new Error('runtime source is not connected');

    try {
      expect(await fixture.output()).toBe(0);

      setLevel(1);
      expect(await fixture.output()).toBe(0);
      fixture.runPeriods(3);

      const highInput = expectedRuntimeInput(1, seriesResistance, shuntResistance);
      expect(highInput).toBeGreaterThan(0);
      expect(await fixture.output()).toBeCloseTo(21 * highInput, 8);

      setLevel(0);
      fixture.runPeriods(3);
      expect(await fixture.output()).toBe(0);

      setLevel(1);
      fixture.runPeriods(3);
      expect(await fixture.output()).toBeCloseTo(21 * highInput, 8);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });
});

describe('输出饱和与供电轨', () => {
  it('正差分超过 VCC 时饱和到采样到的 VCC', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.4 });

    try {
      expect(await fixture.output()).toBeCloseTo(5, 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it('3.3 V 供电时上轨跟随 3.3 V，而不是固定 5 V', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.4, supplyVoltage: 3.3 });

    try {
      expect(await fixture.output()).toBeCloseTo(3.3, 9);
    } finally {
      fixture.board.dispose();
    }
  });

  it('负差分被 0 V 下轨夹住', async () => {
    const fixture = await createLm324Board({ plusVoltage: -0.2 });

    try {
      expect(await fixture.output()).toBe(0);
    } finally {
      fixture.board.dispose();
    }
  });
});

describe('有限输出阻抗', () => {
  it('100 kΩ 输出电阻在半电源目标仍精确表达，不误贴轨', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 2.5 / 21,
      props: { outputResistance: 100_000 },
    });

    try {
      expect(await fixture.output()).toBeCloseTo(2.5, 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it.each([0.0004, 4.9996])(
    '近轨目标 %s V 的单支路近似误差不超过 Rout×VCC/1 GΩ',
    async (target) => {
      const outputResistance = 100_000;
      const fixture = await createLm324Board({
        plusVoltage: target / 21,
        props: { outputResistance },
      });

      try {
        const actual = await fixture.output();
        const bound = (outputResistance * 5) / 1_000_000_000;

        expect(actual).toBe(target < 2.5 ? 0 : 5);
        expect(Math.abs(actual - target)).toBeLessThanOrEqual(bound);
      } finally {
        fixture.board.dispose();
      }
    },
  );

  it('25 Ω 输出电阻在 25 Ω 对地负载下产生一半空载电压', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.05,
      loadResistance: 25,
      loadTo: 'gnd',
    });

    try {
      expect(await fixture.output()).toBeCloseTo(expectedLoadedVoltage(1.05, 5, 25, 25, 'gnd'), 9);
      expect(fixture.board.faults).toEqual([]);
    } finally {
      fixture.board.dispose();
    }
  });

  it('输出电阻参数改变负载压降', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.05,
      props: { outputResistance: 100 },
      loadResistance: 100,
      loadTo: 'gnd',
    });

    try {
      expect(await fixture.output()).toBeCloseTo(
        expectedLoadedVoltage(1.05, 5, 100, 100, 'gnd'),
        9,
      );
    } finally {
      fixture.board.dispose();
    }
  });

  it('负载接 VCC 时输出被上拉，仍符合戴维南等效', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.05,
      loadResistance: 25,
      loadTo: 'vcc',
    });

    try {
      expect(await fixture.output()).toBeCloseTo(expectedLoadedVoltage(1.05, 5, 25, 25, 'vcc'), 9);
    } finally {
      fixture.board.dispose();
    }
  });

  it('饱和到 VCC 后仍受有限输出阻抗限制，重载把输出拉低', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.4,
      loadResistance: 25,
      loadTo: 'gnd',
    });

    try {
      expect(await fixture.output()).toBeCloseTo(2.5, 9);
    } finally {
      fixture.board.dispose();
    }
  });
});

describe('边界与时间语义', () => {
  it('输入浮空时输出释放，外部上拉决定网络电压', async () => {
    const fixture = await createLm324Board({
      connectInputs: false,
      pullUpResistance: 1_000_000,
      pullUpVoltage: 5,
    });

    try {
      expect(await fixture.output()).toBeCloseTo(5, 6);
    } finally {
      fixture.board.dispose();
    }
  });

  it('VCC 或 GND 未连接时输出释放', async () => {
    const noVcc = await createLm324Board({
      plusVoltage: 0.05,
      connectVcc: false,
      pullUpResistance: 1_000_000,
      pullUpVoltage: 5,
    });

    try {
      expect(await noVcc.output()).toBeCloseTo(5, 6);
    } finally {
      noVcc.board.dispose();
    }

    const noGnd = await createLm324Board({
      plusVoltage: 0.05,
      connectGnd: false,
      pullUpResistance: 1_000_000,
      pullUpVoltage: 5,
    });

    try {
      expect(await noGnd.output()).toBeCloseTo(5, 6);
    } finally {
      noGnd.board.dispose();
    }
  });

  it('VCC 不高于 GND 时输出释放', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.05,
      supplyVoltage: 0,
      groundVoltage: 0,
      pullUpResistance: 1_000_000,
      pullUpVoltage: 5,
    });

    try {
      expect(await fixture.output()).toBeCloseTo(5, 6);
    } finally {
      fixture.board.dispose();
    }
  });

  it('增益变化最多延迟一个 updatePeriod 才反映到输出电压', async () => {
    const fixture = await createLm324Board({
      plusVoltage: 0.05,
      props: { updatePeriodUs: 100 },
    });

    try {
      expect(await fixture.output()).toBeCloseTo(1.05, 9);

      fixture.board.send('dut', 'setWiper', 0.5);
      fixture.board.run(50 * US);
      expect(await fixture.output()).toBeCloseTo(1.05, 9);

      fixture.board.run(100 * US);
      expect(await fixture.output()).toBeCloseTo(0.05 * expectedGain(0.5), 9);
    } finally {
      fixture.board.dispose();
    }
  });

  it.each([
    ['updatePeriodUs=0', { updatePeriodUs: 0 }, /updatePeriodUs/],
    [
      'minPotResistance>potResistance',
      { potResistance: 1000, minPotResistance: 2000 },
      /minPotResistance/,
    ],
    ['outputResistance=0', { outputResistance: 0 }, /outputResistance/],
    ['outputResistance 超上限', { outputResistance: 100_001 }, /outputResistance/],
    ['feedbackResistance=0', { feedbackResistance: 0 }, /feedbackResistance/],
    ['initialWiper=2', { initialWiper: 2 }, /initialWiper/],
  ])('创建期拒绝 %s', async (_name, props, pattern) => {
    await expect(createLm324Board({ props })).rejects.toThrow(pattern);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.1])(
    '直接向 DDL 输入通道注入 %s 会使真实板 faulted',
    async (value) => {
      const fixture = await createLm324Board({ plusVoltage: 0.05 });

      try {
        fixture.board.injectInput('dut', 'setWiper', value);
        expect(() => fixture.board.run(10 * US)).toThrow(/setWiper/);
        expect(fixture.board.faults.join(';')).toMatch(/setWiper/);
      } finally {
        fixture.board.dispose();
      }
    },
  );

  it('销毁后不残留故障，运行时不产生整板 fault', async () => {
    const fixture = await createLm324Board({ plusVoltage: 0.05 });

    fixture.board.send('dut', 'setWiper', 0.25);
    fixture.runPeriods(2);
    expect(fixture.board.faults).toEqual([]);
    fixture.board.dispose();
  });
});
