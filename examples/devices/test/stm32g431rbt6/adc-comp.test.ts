import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { describe, expect, it } from 'vitest';
import { adaptDevice } from './harness';

/**
 * COMP1–4 的真实 MCU 翻译/读取回归。
 *
 * 使用标准主 adapter 的生产 `PERIPHERALS`，走真实 DDL、JIT、GPIO/电气采样。
 * 固件依次写四个 COMP CSR（EN + INMSEL=7），再读回 SRAM；这能抓住输入映射引用
 * G431RBT6 不存在引脚（例如 PE7）时的翻译期错误。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');

const [module, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

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

  adds(rd: number, immediate: number): this {
    return this.#half(0x3000 | (rd << 8) | (immediate & 0xff));
  }

  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strSp(rt: number, offset: number): this {
    return this.#half(0x9000 | (rt << 8) | ((offset >>> 2) & 0xff));
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

/** 对 COMP1–4 写 EN + INMSEL=7，再读回 CSR 写入 SRAM[0x5000..0x500C]。 */
function comparatorFirmware(): Uint8Array {
  const code = new Thumb()
    .movw(4, 0x0200)
    .movt(4, 0x4001)
    .movw(1, 0x0071) // EN=1, INMSEL=7（IO2）
    .strWord(1, 4, 0x00)
    .strWord(1, 4, 0x04)
    .strWord(1, 4, 0x08)
    .strWord(1, 4, 0x0c);

  for (let index = 0; index < 4; index += 1)
    code.ldrWord(2, 4, index * 4).strSp(2, index * 4);

  return code.spin().build();
}

function board(): ReturnType<typeof createBoard> {
  return createBoard(
    createDeviceLibrary([
      {
        id: 'mcu',
        model,
        create: adaptDevice(module, { firmware: comparatorFirmware() }) as never,
      },
    ]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } }],
      nets: [
        {
          id: 'vdd',
          voltage: 3.3,
          pins: ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'].map((pin) => ({
            instance: 'mcu',
            pin,
          })),
        },
        {
          id: 'vss',
          voltage: 0,
          pins: ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'].map((pin) => ({
            instance: 'mcu',
            pin,
          })),
        },
      ],
    },
  );
}

describe('COMP 真实 MCU 回归', () => {
  it('读取 G431RBT6 的 COMP1–4 CSR 不引用未封装引脚', () => {
    const runtime = board();
    const faults: string[] = [];
    const subscription = runtime.onDidError((error) => faults.push(error.message));

    try {
      runtime.runUntil(0);
      runtime.runUntil(2_000_000_000);
      const sram = (
        runtime as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!.memories.get('sram')!;
      const view = new DataView(sram.buffer, sram.byteOffset, sram.byteLength);

      expect(faults).toEqual([]);

      for (let index = 0; index < 4; index += 1) {
        const csr = view.getUint32(0x5000 + index * 4, true);

        expect(csr & 1).toBe(1);
        expect((csr >>> 4) & 0xf).toBe(7);
      }
    } finally {
      subscription.dispose();
      runtime.dispose();
    }
  });
});
