import { describe, expect, it } from 'vitest';
import { createBoardWith, loadSourceDevice, readMetadata } from './harness.ts';
import type { DeviceIR } from '@mica-js/sdk/model';

/**
 * 21 个简单统一器件的清单、DDL 与适配器接口一致性。
 *
 * 本轮只交付仿真内核：不要求 `view2d`、几何或展示入口。这里不重新实现 SDK 校验，
 * 只覆盖跨文件合同：清单引脚 == 模型 IR 引脚，每个输入通道有该器件显式声明的公共
 * 方法，每个输出通道有 `onDidXxx` 事件，且旧的 `ports` / `symbol` 不再出现在清单中。
 */

const IDS = [
  '74hc02',
  '74hc138',
  '74hc14',
  '74hc573',
  'at24c02',
  'blue-led',
  'buzzer',
  'cx20106a',
  'ds1302',
  'ds18b20',
  'jumper',
  'jumper-2x3',
  'lm386',
  'ne555',
  'pcf8591',
  'push-button',
  'relay',
  'uart-probe',
  'uln2003',
  'ultrasonic',
  'vs1838',
] as const;

const cap = (value: string): string => `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
/** 通道名与业务事件名不同的显式映射；其余按 onDid<Channel> 约定。 */
const OUTPUT_EVENTS: Readonly<Record<string, string>> = { pressed: 'onDidPress' };
/**
 * 每个器件的 DDL 输入通道到公共方法名的显式映射。测试不按通道名跨器件猜语义。
 */
const INPUT_METHODS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cx20106a: { carrier: 'setCarrier' },
  ds18b20: { temperature: 'setTemperature' },
  jumper: { control: 'setClosed' },
  'jumper-2x3': { control2: 'selectVs1838' },
  pcf8591: { ain0: 'setAin0', ain1: 'setAin1', ain2: 'setAin2', ain3: 'setAin3' },
  'push-button': { press: 'press' },
  'uart-probe': { send: 'send' },
  vs1838: { carrier: 'setCarrier' },
};

function irDeclarations(model: DeviceIR): readonly {
  readonly kind: string;
  readonly name: string;
  readonly direction?: 'input' | 'output';
}[] {
  return model.declarations as never;
}

describe.each(IDS)('统一器件 %s', (id) => {
  it('清单身份与模型引脚完全一致，且不含旧清单字段', async () => {
    const manifest = readMetadata(id);
    const device = await loadSourceDevice(id);
    const raw = manifest as unknown as Record<string, unknown>;

    expect(raw.ports).toBeUndefined();
    expect(raw.symbol).toBeUndefined();
    expect(raw.id).toBeUndefined();
    expect(manifest.publisher).toBe('example');
    expect(manifest.name).toBe(id);
    expect(manifest.engines.mica).toBe('^0.3.0');
    expect(manifest.model.entry).toBe('model.js');

    const modelPins = irDeclarations(device.model)
      .filter((declaration) => declaration.kind === 'pin')
      .map((declaration) => declaration.name)
      .sort();
    const manifestPins = Object.keys(manifest.pins ?? {}).sort();

    expect(manifestPins).toEqual(modelPins);
  });

  it('每个输入通道有公共方法，每个输出通道有 onDidXxx 事件', async () => {
    const manifest = readMetadata(id);
    const device = await loadSourceDevice(id);
    const channels = irDeclarations(device.model).filter(
      (declaration) => declaration.kind === 'channel',
    );

    for (const channel of channels) {
      if (channel.direction === 'input') {
        const method = INPUT_METHODS[id]?.[channel.name];
        expect(
          method,
          `${id}: input ${channel.name} needs an explicit public method`,
        ).toBeDefined();
        expect(manifest.model.methods[method as string]).toBeDefined();
      } else if (channel.direction === 'output') {
        const event = OUTPUT_EVENTS[channel.name] ?? `onDid${cap(channel.name)}`;
        expect(
          manifest.model.events[event],
          `${id}: output ${channel.name} needs ${event}`,
        ).toBeDefined();
      }
    }
  });
});

describe('测试夹具事件出口', () => {
  it('访问清单未声明的 onDid 事件会立即失败，拼错事件不能静默通过', async () => {
    const device = await loadSourceDevice('push-button');
    const typo = {
      ...device,
      create: (context: { readonly events: Record<string, unknown> }) => {
        void context.events.onDidPrez;
        return { sync() {}, dispose() {} };
      },
    };

    await expect(
      createBoardWith([{ id: 'dut', type: 'push-button', device: typo as never }], { nets: [] }),
    ).rejects.toThrow(/onDidPrez/);
  });
});
