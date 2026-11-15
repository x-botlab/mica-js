import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import {
  GPIO_BSRR,
  GPIO_BRR,
  GPIO_MODER,
  GPIO_ODR,
  GPIO_OTYPER,
  GPIO_PUPDR,
} from '../src/devices/stm32g431rbt6/core/gpio';

/**
 * 简单推挽输出 descriptor 的行为矩阵。
 *
 * 器件只在 MODER/OTYPER 配置写时维护 `gpioSimpleOutN`；稳态 BSRR/BRR 写命中 descriptor
 * 后，intent 只由 ODR 位与当前供电决定。这里用真实器件与 JIT 运行手写 Thumb 固件，
 * 同时检查 descriptor 位图和实际引脚 intent，覆盖 word/half/byte 配置、动态重配置、
 * 开漏、上拉/下拉、输入、AF 与掉电。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', 'src', 'devices', 'stm32g431rbt6');

const [device, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
    default: (context: never) => { sync(batch: unknown): void; dispose(): void };
  }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;
const PA5_OUT = 1 << (5 * 2);
const PA5_OPEN_DRAIN = 1 << 5;
const PA5_PULL_UP = 1 << (5 * 2);
const PA5_PULL_DOWN = 2 << (5 * 2);
const PA5_SET = 1 << 5;
const PA5_CLEAR = PA5_SET << 16;

interface PinView {
  readonly intent: readonly {
    readonly to: { readonly name: string };
    readonly resistance: number;
  }[];
}

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly pins: ReadonlyMap<string, PinView>;
}

interface Snapshot {
  readonly simpleOut: number;
  readonly intent: readonly { readonly name: string; readonly resistance: number }[];
}

/** 手写 Thumb 子集；只发射本测试需要的确定编码。 */
class Thumb {
  readonly #halves: number[] = [];

  #half(value: number): this {
    this.#halves.push(value & 0xffff);

    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
  }

  movw(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.#dword(
      0xf240 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movt(rd: number, immediate: number): this {
    const value = immediate & 0xffff;

    return this.#dword(
      0xf2c0 | (((value >>> 11) & 1) << 10) | ((value >>> 12) & 0xf),
      (((value >>> 8) & 7) << 12) | (rd << 8) | (value & 0xff),
    );
  }

  movs(rd: number, immediate: number): this {
    return this.#half(0x2000 | (rd << 8) | (immediate & 0xff));
  }

  load32(rd: number, value: number): this {
    return this.movw(rd, value & 0xffff).movt(rd, value >>> 16);
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strHalf(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8a0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strByte(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf880 | rn, (rt << 12) | (offset & 0xfff));
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  build(): Uint8Array {
    const image = new Uint8Array(8 + this.#halves.length * 2);
    const view = new DataView(image.buffer);

    view.setUint32(0, 0x2000_5000, true);
    view.setUint32(4, 0x0800_0009, true);
    this.#halves.forEach((value, index) => view.setUint16(8 + index * 2, value, true));

    return image;
  }
}

function gpioBase(code: Thumb): Thumb {
  return code.movw(0, 0x0000).movt(0, 0x4800);
}

function snapshot(
  firmware: Uint8Array,
  options: { readonly execution?: 'precise' | 'throughput'; readonly powered?: boolean } = {},
): Snapshot {
  const board = createBoard(
    createDeviceLibrary([{ id: 'mcu', model, create: device.default as never }]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { firmware, clockFrequency: 1_000_000 } }],
      nets: [
        {
          id: 'vdd1',
          voltage: options.powered === false ? 0 : 3.3,
          pins: [{ instance: 'mcu', pin: 'VDD1' }],
        },
        {
          id: 'vdd',
          voltage: 3.3,
          pins: VDD.slice(1).map((pin) => ({ instance: 'mcu', pin })),
        },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
      ],
    },
    { execution: options.execution ?? 'throughput' },
  );
  const faults: string[] = [];
  const subscription = board.onDidError((error) => faults.push(error.message));

  try {
    board.runUntil(0);
    board.runUntil(1_000_000_000);

    const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
    const pin = instance.pins.get('PA5')!;

    expect(board.status).toBe('ready');
    expect(faults).toEqual([]);

    return {
      simpleOut: Number(instance.states.get('gpioSimpleOut0')) >>> 0,
      intent: pin.intent.map((branch) => ({
        name: branch.to.name,
        resistance: branch.resistance,
      })),
    };
  } finally {
    subscription.dispose();
    board.dispose();
  }
}

function expectBothModes(firmware: Uint8Array, expected: Snapshot, powered = true): void {
  expect(snapshot(firmware, { execution: 'precise', powered })).toEqual(expected);
  expect(snapshot(firmware, { execution: 'throughput', powered })).toEqual(expected);
}

function configurePushPull(code: Thumb): Thumb {
  return code.movw(1, PA5_OUT).strWord(1, 0, GPIO_MODER).movs(1, 0).strWord(1, 0, GPIO_OTYPER);
}

function descriptorFirmware(moder: number, otyper: number): Uint8Array {
  return gpioBase(new Thumb())
    .load32(1, moder)
    .strWord(1, 0, GPIO_MODER)
    .load32(1, otyper)
    .strWord(1, 0, GPIO_OTYPER)
    .spin()
    .build();
}

/** 独立参考：只有 MODER 字段为 01 的脚保留，OTYPER 置位时清掉。 */
function referenceDescriptor(moder: number, otyper: number): number {
  let output = 0;

  for (let bit = 0; bit < 16; bit += 1) if (((moder >>> (bit * 2)) & 3) === 1) output |= 1 << bit;

  return output & ~otyper & 0xffff;
}

describe('GPIO simple push-pull descriptor', () => {
  it('descriptor 位图对每个 MODER bit 的四种编码与 OTYPER one-hot/mixed 与独立参考一致', () => {
    const patterns = [0x0000, 0x8001, 0xaaaa, 0xffff, 0x0001, 0x8000];
    const modes = [0, 1, 2, 3];

    for (const mode of modes) {
      let moder = 0;

      for (let bit = 0; bit < 16; bit += 1) moder = (moder | (mode << (bit * 2))) >>> 0;

      for (const otyper of patterns) {
        const firmware = descriptorFirmware(moder, otyper);
        const expected = referenceDescriptor(moder, otyper);

        for (const execution of ['precise', 'throughput'] as const) {
          expect(snapshot(firmware, { execution }).simpleOut).toBe(expected);
        }
      }
    }

    // OTYPER 每个 bit 的 one-hot 都必须清掉对应的输出脚；高半字/bit15 也包含在内。
    const pushPullModer = 0x55555555;

    for (let bit = 0; bit < 16; bit += 1) {
      const otyper = 1 << bit;
      const firmware = descriptorFirmware(pushPullModer, otyper);
      const expected = referenceDescriptor(pushPullModer, otyper);

      for (const execution of ['precise', 'throughput'] as const) {
        expect(snapshot(firmware, { execution }).simpleOut).toBe(expected);
      }
    }
  });

  it('word MODER/OTYPER 后 BSRR set/clear 只由 ODR 与供电选择 intent', () => {
    const set = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(set, { simpleOut: PA5_SET, intent: [{ name: 'VDD1', resistance: 25 }] });

    const clear = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .movw(1, PA5_CLEAR & 0xffff)
      .movt(1, PA5_CLEAR >>> 16)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(clear, { simpleOut: PA5_SET, intent: [{ name: 'VSS1', resistance: 25 }] });
  });

  it('half/byte MODER 与 half/byte OTYPER 同样维护 descriptor', () => {
    const half = gpioBase(new Thumb())
      .movw(1, PA5_OUT)
      .strHalf(1, 0, GPIO_MODER)
      .movs(1, 0)
      .strHalf(1, 0, GPIO_OTYPER)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(half, { simpleOut: PA5_SET, intent: [{ name: 'VDD1', resistance: 25 }] });

    const byte = gpioBase(new Thumb())
      .movs(1, PA5_OUT >>> 8)
      .strByte(1, 0, 1)
      .movs(1, 0)
      .strByte(1, 0, GPIO_OTYPER)
      .movs(1, PA5_SET)
      .strByte(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(byte, { simpleOut: PA5_SET, intent: [{ name: 'VDD1', resistance: 25 }] });
  });

  it('half/byte BSRR/BRR 仍走 descriptor 快路径', () => {
    const firmware = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strHalf(1, 0, GPIO_BSRR)
      .movs(1, PA5_SET)
      .strByte(1, 0, GPIO_BRR)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(firmware, { simpleOut: PA5_SET, intent: [{ name: 'VDD1', resistance: 25 }] });
  });

  it('PUPDR/AFR 在简单推挽输出下不改变 intent', () => {
    const firmware = gpioBase(new Thumb())
      .movw(1, PA5_OUT)
      .strWord(1, 0, GPIO_MODER)
      .movs(1, 0)
      .strWord(1, 0, GPIO_OTYPER)
      .movw(1, PA5_PULL_DOWN)
      .strWord(1, 0, GPIO_PUPDR)
      .movw(1, 0x0000)
      .movt(1, 0x0010)
      .strWord(1, 0, 0x20)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(firmware, { simpleOut: PA5_SET, intent: [{ name: 'VDD1', resistance: 25 }] });
  });

  it('开漏输出清空 descriptor，并按 OTYPER/PUPDR 选择完整 intent', () => {
    const openHigh = gpioBase(new Thumb())
      .movw(1, PA5_OUT)
      .strWord(1, 0, GPIO_MODER)
      .movs(1, PA5_OPEN_DRAIN)
      .strWord(1, 0, GPIO_OTYPER)
      .movw(1, PA5_PULL_UP)
      .strWord(1, 0, GPIO_PUPDR)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(openHigh, {
      simpleOut: 0,
      intent: [{ name: 'VDD1', resistance: 40_000 }],
    });

    const openLow = gpioBase(new Thumb())
      .movw(1, PA5_OUT)
      .strWord(1, 0, GPIO_MODER)
      .movs(1, PA5_OPEN_DRAIN)
      .strWord(1, 0, GPIO_OTYPER)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .movw(1, PA5_CLEAR & 0xffff)
      .movt(1, PA5_CLEAR >>> 16)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(openLow, { simpleOut: 0, intent: [{ name: 'VSS1', resistance: 25 }] });
  });

  it('输入与 AF 模式清空 descriptor，并保留完整上拉/下拉行为', () => {
    const input = gpioBase(new Thumb())
      .movs(1, 0)
      .strWord(1, 0, GPIO_MODER)
      .movw(1, PA5_PULL_DOWN)
      .strWord(1, 0, GPIO_PUPDR)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_ODR)
      .spin()
      .build();

    expectBothModes(input, { simpleOut: 0, intent: [{ name: 'VSS1', resistance: 40_000 }] });

    const alternate = gpioBase(new Thumb())
      .movw(1, 2 << (5 * 2))
      .strWord(1, 0, GPIO_MODER)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_ODR)
      .spin()
      .build();

    expectBothModes(alternate, { simpleOut: 0, intent: [] });
  });

  it('运行时从推挽输出切到输入/开漏后清除 descriptor', () => {
    const toInput = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .movs(1, 0)
      .strWord(1, 0, GPIO_MODER)
      .movw(1, PA5_PULL_DOWN)
      .strWord(1, 0, GPIO_PUPDR)
      .spin()
      .build();

    expectBothModes(toInput, {
      simpleOut: 0,
      intent: [{ name: 'VSS1', resistance: 40_000 }],
    });

    const toOpenDrain = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .movs(1, PA5_OPEN_DRAIN)
      .strWord(1, 0, GPIO_OTYPER)
      .movw(1, PA5_PULL_UP)
      .strWord(1, 0, GPIO_PUPDR)
      .spin()
      .build();

    expectBothModes(toOpenDrain, {
      simpleOut: 0,
      intent: [{ name: 'VDD1', resistance: 40_000 }],
    });

    const backToPushPull = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_OPEN_DRAIN)
      .strWord(1, 0, GPIO_OTYPER)
      .movs(1, 0)
      .strWord(1, 0, GPIO_OTYPER)
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(backToPushPull, {
      simpleOut: PA5_SET,
      intent: [{ name: 'VDD1', resistance: 25 }],
    });
  });

  it('掉电时简单推挽输出返回空 intent，descriptor 仍保留配置', () => {
    const firmware = configurePushPull(gpioBase(new Thumb()))
      .movs(1, PA5_SET)
      .strWord(1, 0, GPIO_BSRR)
      .spin()
      .build();

    expectBothModes(firmware, { simpleOut: PA5_SET, intent: [] }, false);
  });
});
