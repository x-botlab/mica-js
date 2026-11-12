import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceMetadataSymbol, parseDeviceMetadata } from '@mica-js/document/schematic';
import { validateMetadata } from '@mica-js/sdk/metadata';
import { circuit, measure } from './harness.ts';

/**
 * 蓝色 LED 的行为基线。
 *
 * 电路是「电源 — 串联电阻 — LED — 地」，电气求解与 DDL 采样都走真实仿真板：默认
 * 500 Ω 等效电阻与 330 Ω 串联时，LED 分得 500/(500+330) 的电压（3.01 V），电流
 * 6.02 mA，亮度 0.30——与典型蓝色 LED 在 5 V 下的工作点接近。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'blue-led');

interface DeviceJson {
  readonly kind: string;
  readonly id: string;
  readonly displayName: string;
  readonly properties: Readonly<
    Record<string, { readonly type: string; readonly default?: unknown }>
  >;
  readonly pins: Readonly<Record<string, unknown>>;
  readonly ports: Readonly<
    Record<
      string,
      { readonly direction: string; readonly type: string; readonly delivery?: string }
    >
  >;
  readonly symbol: {
    readonly bounds: { readonly width: number; readonly height: number };
    readonly graphics: readonly unknown[];
    readonly pins: Readonly<Record<string, unknown>>;
  };
}

const metadata = (): DeviceJson =>
  JSON.parse(readFileSync(join(DEVICE_DIR, 'device.json'), 'utf8')) as DeviceJson;

describe('器件声明', () => {
  it('元数据通过 SDK 校验，ID 与目录名一致', () => {
    expect(() => validateMetadata(metadata(), 'device', 'blue-led')).not.toThrow();
  });

  it('声明阳极/阴极两根引脚、三个数值输出端口与两项属性', () => {
    const device = metadata();

    expect(device.displayName).toBe('蓝色 LED');
    expect(Object.keys(device.pins).sort()).toEqual(['anode', 'cathode']);
    expect(device.properties.forwardResistance?.default).toBe(500);
    expect(device.properties.ratedCurrent?.default).toBe(0.02);

    for (const name of ['brightness', 'current', 'voltage'])
      expect(device.ports[name]).toMatchObject({
        direction: 'output',
        type: 'number',
        delivery: 'level',
      });
  });

  it('符号覆盖两个引脚并画出发光箭头', () => {
    const device = metadata();

    expect(Object.keys(device.symbol.pins).sort()).toEqual(['anode', 'cathode']);
    expect(device.symbol.graphics.length).toBeGreaterThanOrEqual(6);
    expect(device.symbol.bounds.width).toBeGreaterThan(0);
    expect(device.symbol.bounds.height).toBeGreaterThan(0);
  });

  it('文档解析器能把符号转换成两个引脚锚点', () => {
    const definition = parseDeviceMetadata(metadata());
    const symbol = deviceMetadataSymbol(definition);

    expect(definition.id).toBe('blue-led');
    expect(Object.keys(symbol.pins).sort()).toEqual(['anode', 'cathode']);
  });
});

describe('正向导通', () => {
  it('5 V 经 330 Ω 串联：分压 3.01 V、电流 6.02 mA、亮度 0.30', async () => {
    const readings = await measure();

    expect(readings.voltage).toBeCloseTo((5 * 500) / 830, 6);
    expect(readings.current).toBeCloseTo(5 / 830, 9);
    expect(readings.brightness).toBeCloseTo(readings.current / 0.02, 9);
    // 与典型蓝色 LED 的 3.0 V / 6 mA 工作点一致。
    expect(readings.voltage).toBeCloseTo(3.0, 1);
    expect(readings.current).toBeCloseTo(0.006, 4);
  });

  it('电流越大越亮；减小串联电阻会提高亮度', async () => {
    const dim = await measure({ series: 330 });
    const mid = await measure({ series: 100 });
    const bright = await measure({ series: 10 });

    expect(dim.brightness).toBeGreaterThan(0);
    expect(mid.brightness).toBeGreaterThan(dim.brightness);
    expect(bright.brightness).toBeGreaterThan(mid.brightness);
    expect(bright.brightness).toBeLessThan(1);
  });

  it('额定电流调小后亮度饱和到 1', async () => {
    const readings = await measure({ props: { ratedCurrent: 0.005 } });

    expect(readings.current).toBeGreaterThan(0.005);
    expect(readings.brightness).toBe(1);
  });

  it('串联电阻极小时 LED 接近全部电源电压（线性模型没有正向压降）', async () => {
    const readings = await measure({ series: 1 });

    expect(readings.voltage).toBeCloseTo((5 * 500) / 501, 6);
    expect(readings.voltage).toBeGreaterThan(4.9);
    expect(readings.current).toBeCloseTo(5 / 501, 9);
  });
});

describe('反向与悬空', () => {
  it('反接时电流为负、发光为 0（线性模型不阻塞反向电流）', async () => {
    const readings = await measure({ reversed: true });

    expect(readings.voltage).toBeCloseTo(-(5 * 500) / 830, 6);
    expect(readings.current).toBeLessThan(0);
    expect(readings.brightness).toBe(0);
  });

  it('两端悬空时报零电压、零电流、零亮度', async () => {
    const readings = await measure({ floating: true });

    expect(readings.voltage).toBe(0);
    expect(readings.current).toBe(0);
    expect(readings.brightness).toBe(0);
  });
});

describe('属性', () => {
  it('ratedCurrent 改变满亮度所需的电流', async () => {
    const dim = await measure({ props: { ratedCurrent: 0.1 } });
    const bright = await measure({ props: { ratedCurrent: 0.005 } });

    expect(dim.brightness).toBeCloseTo(dim.current / 0.1, 9);
    expect(bright.brightness).toBe(1);
  });

  it('forwardResistance 改变分压比', async () => {
    const low = await measure({ props: { forwardResistance: 50 } });
    const high = await measure({ props: { forwardResistance: 1000 } });

    expect(low.voltage).toBeCloseTo((5 * 50) / 380, 6);
    expect(high.voltage).toBeCloseTo((5 * 1000) / 1330, 6);
    expect(high.current).toBeLessThan(low.current);
  });

  it('输出在引脚电压变化后更新，不需要额外的时钟驱动', async () => {
    const built = await circuit();

    try {
      built.run(1_000_000_000);
      expect(built.readings.brightness).toBeGreaterThan(0);
      // 适配器把三个输出通道发布到同名话题，数值与批次读数一致。
      expect(built.topics.brightness).toBeCloseTo(built.readings.brightness, 9);
      expect(built.topics.current).toBeCloseTo(built.readings.current, 9);
      expect(built.topics.voltage).toBeCloseTo(built.readings.voltage, 9);

      built.run(2_000_000_000);
      expect(built.readings.brightness).toBeGreaterThan(0);
    } finally {
      built.dispose();
    }
  });

  it('越界属性在创建期被拒绝', async () => {
    await expect(measure({ props: { ratedCurrent: 0 } })).rejects.toThrow(/ratedCurrent/);
    // 电阻意图在创建期先于设备断言校验，报的是电阻允许区间。
    await expect(measure({ props: { forwardResistance: 0 } })).rejects.toThrow(/0\.001/);
  });
});
