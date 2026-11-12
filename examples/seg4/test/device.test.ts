import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceMetadataSymbol, parseDeviceMetadata } from '@mica-js/document/schematic';
import { validateMetadata } from '@mica-js/sdk/metadata';
import { circuit, readDigits } from './harness.ts';

/**
 * 共阴四位七段数码管的行为基线。
 *
 * 电路由 12 个数字源直接驱动：段脚 a–dp 与位脚 com1–com4。电气求解、DDL 采样与通道
 * 都走真实仿真板。段码按 bit0=a…bit7=dp 编码。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'seg4');
const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;
const COMMONS = ['com1', 'com2', 'com3', 'com4'] as const;

/** a=1、b=2、c=4、d=8、e=16、f=32、g=64、dp=128。 */
const A = 1;
const B = 2;
const G = 64;
const DP = 128;

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
    readonly pins: Readonly<Record<string, { readonly position: readonly [number, number] }>>;
  };
}

const metadata = (): DeviceJson =>
  JSON.parse(readFileSync(join(DEVICE_DIR, 'device.json'), 'utf8')) as DeviceJson;

describe('器件声明', () => {
  it('元数据通过 SDK 校验，ID 与目录名一致', () => {
    expect(() => validateMetadata(metadata(), 'device', 'seg4')).not.toThrow();
  });

  it('声明 8 段 + 4 位共 12 根引脚、四个段码端口与一项属性', () => {
    const device = metadata();

    expect(device.displayName).toBe('四位数码管');
    expect(Object.keys(device.pins).sort()).toEqual([...SEGMENTS, ...COMMONS].sort());
    expect(device.properties.forwardResistance?.default).toBe(500);

    for (const name of ['digit1', 'digit2', 'digit3', 'digit4'])
      expect(device.ports[name]).toMatchObject({
        direction: 'output',
        type: 'number',
        delivery: 'level',
      });
  });

  it('符号把段脚放在左侧、位脚放在右侧，并画出四位数字轮廓', () => {
    const device = metadata();

    expect(Object.keys(device.symbol.pins).sort()).toEqual([...SEGMENTS, ...COMMONS].sort());
    for (const pin of SEGMENTS) expect(device.symbol.pins[pin]?.position[0]).toBeLessThan(0);
    for (const pin of COMMONS) expect(device.symbol.pins[pin]?.position[0]).toBeGreaterThan(0);
    // 每位 7 段 + 1 个小数点。
    expect(device.symbol.graphics.length).toBe(32);
    expect(device.symbol.bounds.width).toBeGreaterThan(0);
    expect(device.symbol.bounds.height).toBeGreaterThan(0);
  });

  it('文档解析器能把符号转换成 12 个引脚锚点', () => {
    const definition = parseDeviceMetadata(metadata());
    const symbol = deviceMetadataSymbol(definition);

    expect(definition.id).toBe('seg4');
    expect(Object.keys(symbol.pins).sort()).toEqual([...SEGMENTS, ...COMMONS].sort());
  });
});

describe('静态显示', () => {
  it('上电时四位都是 0（段脚与位脚悬空）', async () => {
    const built = await circuit();

    try {
      built.run(1_000_000_000);
      expect([1, 2, 3, 4].map((index) => built.outputs[`digit${index}`])).toEqual([0, 0, 0, 0]);
    } finally {
      built.dispose();
    }
  });

  it('全部段脚为高、选中第 1 位：只有 digit1 是 0xFF', async () => {
    expect(await readDigits(0xff, [0])).toEqual([0xff, 0, 0, 0]);
  });

  it('段码按 a=bit0 … dp=bit7 编码', async () => {
    expect(await readDigits(A + G, [1])).toEqual([0, A + G, 0, 0]);
    expect(await readDigits(DP, [3])).toEqual([0, 0, 0, DP]);
  });

  it('同时选中两位时，两位显示同一份段码', async () => {
    expect(await readDigits(A + B, [0, 2])).toEqual([A + B, 0, A + B, 0]);
  });

  it('段码为 0 的位显示为全灭', async () => {
    expect(await readDigits(0, [0, 1, 2, 3])).toEqual([0, 0, 0, 0]);
  });

  it('位脚为高时不选中该位', async () => {
    const built = await circuit();

    try {
      built.show(0xff, [0]);
      built.run(1_000_000_000);
      expect(built.outputs.digit1).toBe(0xff);

      // 只改段码、不选中任何位：显示内容保持。
      built.show(0x00, []);
      built.run(1_000_000_000);
      expect(built.outputs.digit1).toBe(0xff);
    } finally {
      built.dispose();
    }
  });
});

describe('扫描保持', () => {
  it('按位依次扫描后，每位保留自己选中时的段码', async () => {
    const built = await circuit();

    try {
      built.show(0x06, [0]); // 第 1 位：b、c
      built.run(1_000_000_000);
      built.show(0x5b, [1]); // 第 2 位：a、b、d、e、g
      built.run(1_000_000_000);
      built.show(0x7f, [2]); // 第 3 位：a–g
      built.run(1_000_000_000);

      expect([1, 2, 3, 4].map((index) => built.outputs[`digit${index}`])).toEqual([
        0x06, 0x5b, 0x7f, 0,
      ]);
    } finally {
      built.dispose();
    }
  });

  it('取消选中后内容保持，重新选中时再跟随新段码', async () => {
    const built = await circuit();

    try {
      built.show(0x06, [0]);
      built.run(1_000_000_000);
      built.show(0xff, []); // 位脚全部为高，段码变化被忽略
      built.run(1_000_000_000);
      expect(built.outputs.digit1).toBe(0x06);

      built.show(0x00, [0]); // 重新选中并写 0：该位熄灭
      built.run(1_000_000_000);
      expect(built.outputs.digit1).toBe(0);
    } finally {
      built.dispose();
    }
  });

  it('位脚释放（悬空）时保持而不清屏', async () => {
    const built = await circuit();

    try {
      built.show(0x09, [3]);
      built.run(1_000_000_000);
      expect(built.outputs.digit4).toBe(0x09);

      for (const pin of COMMONS) built.set(pin, 2);
      built.run(1_000_000_000);
      expect(built.outputs.digit4).toBe(0x09);
    } finally {
      built.dispose();
    }
  });

  it('适配器把四位段码发布到同名话题', async () => {
    const built = await circuit();

    try {
      built.show(0x45, [1]);
      built.run(1_000_000_000);

      expect(built.topics.digit2).toBe(0x45);
      expect(built.history.digit2?.at(-1)).toBe(0x45);
      // 未变化的位不重复发布。
      expect(built.topics.digit1).toBe(0);
    } finally {
      built.dispose();
    }
  });
});

describe('属性与创建期校验', () => {
  it('forwardResistance 改变段与位之间的等效电阻，但不影响段码', async () => {
    expect(await readDigits(0xff, [0], { forwardResistance: 1500 })).toEqual([0xff, 0, 0, 0]);
  });

  it('越界属性在创建期被拒绝', async () => {
    await expect(readDigits(0, [0], { forwardResistance: 0 })).rejects.toThrow(/0\.001/);
  });
});
