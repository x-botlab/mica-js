import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createDeviceBuilder, types } from '@mica-js/sdk/model';
import type { DeviceIR } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { adaptDevice } from './harness';

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
const RESULT_BASE = 0x5000;

const [module, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{ create: unknown }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

class Thumb {
  readonly #halves: number[] = [];
  readonly #labels = new Map<string, number>();
  readonly #patches: { readonly at: number; readonly label: string; readonly condition: number }[] =
    [];
  readonly #blPatches: { readonly at: number; readonly label: string }[] = [];

  #half(value: number): this {
    this.#halves.push(value & 0xffff);

    return this;
  }

  #dword(first: number, second: number): this {
    return this.#half(first).#half(second);
  }

  label(name: string): this {
    this.#labels.set(name, this.#halves.length * 2);

    return this;
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

  subs(rd: number, immediate: number): this {
    return this.#half(0x3800 | (rd << 8) | (immediate & 0xff));
  }

  lsls(rd: number, rs: number, amount: number): this {
    return this.#half(((amount & 0x1f) << 6) | ((rs & 7) << 3) | (rd & 7));
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

  ldrSp(rt: number, offset: number): this {
    return this.#half(0x9800 | (rt << 8) | ((offset >>> 2) & 0xff));
  }

  b(condition: number, label: string): this {
    this.#patches.push({ at: this.#halves.length, label, condition });
    this.#half(0xd000 | ((condition & 0xf) << 8));

    return this;
  }

  bl(label: string): this {
    this.#blPatches.push({ at: this.#halves.length, label });
    return this.#dword(0xf000, 0xd000);
  }

  bxLr(): this {
    return this.#half(0x4770);
  }

  nop(): this {
    return this.#half(0xbf00);
  }

  spin(): this {
    return this.#half(0xe7fe);
  }

  /** 裸指令字节（不含向量表），用于把主程序/中断处理程序放到不同偏移。 */
  assemble(): Uint8Array {
    this.#patch();

    const image = new Uint8Array(this.#halves.length * 2);
    const view = new DataView(image.buffer);

    this.#halves.forEach((value, index) => view.setUint16(index * 2, value, true));

    return image;
  }

  #patch(): void {
    for (const patch of this.#patches) {
      const target = this.#labels.get(patch.label);

      if (target === undefined) throw new Error(`Missing label ${patch.label}`);
      const displacement = target - (patch.at * 2 + 4);
      const half = displacement / 2;

      if (!Number.isInteger(half) || half < -128 || half > 127)
        throw new Error(`Branch to ${patch.label} out of range`);
      this.#halves[patch.at] = 0xd000 | ((patch.condition & 0xf) << 8) | (half & 0xff);
    }

    for (const patch of this.#blPatches) {
      const target = this.#labels.get(patch.label);

      if (target === undefined) throw new Error(`Missing label ${patch.label}`);
      const displacement = target - (patch.at * 2 + 4);
      const s = (displacement >>> 24) & 1;
      const i1 = (displacement >>> 23) & 1;
      const i2 = (displacement >>> 22) & 1;
      const imm10 = (displacement >>> 12) & 0x3ff;
      const imm11 = (displacement >>> 1) & 0x7ff;
      const j1 = (~(i1 ^ s)) & 1;
      const j2 = (~(i2 ^ s)) & 1;

      this.#halves[patch.at] = 0xf000 | (s << 10) | imm10;
      this.#halves[patch.at + 1] = 0xd000 | (j1 << 13) | (1 << 12) | (j2 << 11) | imm11;
    }
  }

  build(): Uint8Array {
    const code = this.assemble();
    const image = new Uint8Array(8 + code.length);
    const view = new DataView(image.buffer);

    view.setUint32(0, 0x2000_5000, true);
    view.setUint32(4, 0x0800_0009, true);
    image.set(code, 8);

    return image;
  }
}

function adc1Firmware(reloadBase = true): Uint8Array {
  const code = new Thumb()
    // GPIOB->MODER：PB12 = 11（模拟）
    .movw(0, 0x0400)
    .movt(0, 0x4800)
    .movw(1, 0x0000)
    .movt(1, 0x0300)
    .strWord(1, 0, 0)
    // ADC12_COMMON->CCR：CKMODE=1（HCLK）
    .movw(0, 0x0308)
    .movt(0, 0x5000)
    .movw(1, 0x0000)
    .movt(1, 0x0001)
    .strWord(1, 0, 0)
    // 把 ADC 基址写入 SRAM，供动态地址用例从内存加载（禁止翻译期常量事实）。
    .movw(0, 0x0000)
    .movt(0, 0x5000)
    .strSp(0, 0x10)
    // ADC1->CR = ADVREGEN | ADEN
    .movw(4, 0x0000)
    .movt(4, 0x5000)
    .movw(1, 0x0001)
    .movt(1, 0x1000)
    .strWord(1, 4, 0x08)
    // 通过子程序延时等待 ADRDY；BL 收块，服务块可以推进 ADC。
    .bl('delay');

  // 静态地址：BL 后重新加载基址，HAL 通常也从字面量重载。
  // 动态地址用例故意不重载，用来验证中央动态模块分派。
  if (reloadBase) code.movw(4, 0x0000).movt(4, 0x5000);
  else code.ldrSp(4, 0x10);

  code
    .movs(1, 0)
    .strWord(1, 4, 0x0c)
    .movw(1, 11 << 6)
    .strWord(1, 4, 0x30)
    .movw(1, 0x0005)
    .movt(1, 0x1000)
    .strWord(1, 4, 0x08)
    .bl('delay');

  if (reloadBase) code.movw(4, 0x0000).movt(4, 0x5000);
  else code.ldrSp(4, 0x10);

  return code
    .ldrWord(2, 4, 0x00)
    .strSp(2, 0x04)
    .ldrWord(2, 4, 0x08)
    .strSp(2, 0x08)
    .ldrWord(2, 4, 0x40)
    .strSp(2, 0x00)
    .spin()
    .label('delay')
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .bxLr()
    .build();
}

/** EOC 中断固件：主程序在 0x90，handler 在 0x200，向量 34 = 0x08000201。 */
function irqFirmware(enableInterrupt: boolean): Uint8Array {
  const main = new Thumb()
    .movw(0, 0x0400)
    .movt(0, 0x4800)
    .movw(1, 0x0000)
    .movt(1, 0x0300)
    .strWord(1, 0, 0)
    .movw(0, 0x0308)
    .movt(0, 0x5000)
    .movw(1, 0x0000)
    .movt(1, 0x0001)
    .strWord(1, 0, 0)
    .movw(4, 0x0000)
    .movt(4, 0x5000)
    .movw(1, 0x0001)
    .movt(1, 0x1000)
    .strWord(1, 4, 0x08)
    .bl('delay');

  if (enableInterrupt)
    main
      // IER.EOCIE
      .movs(1, 4)
      .strWord(1, 4, 0x04)
      // NVIC ISER0 bit18
      .movw(0, 0xe100)
      .movt(0, 0xe000)
      .movw(1, 0x0000)
      .movt(1, 0x0004)
      .strWord(1, 0, 0);

  const mainCode = main
    .movw(4, 0x0000)
    .movt(4, 0x5000)
    .movs(1, 0)
    .strWord(1, 4, 0x0c)
    .movw(1, 11 << 6)
    .strWord(1, 4, 0x30)
    .movw(1, 0x0005)
    .movt(1, 0x1000)
    .strWord(1, 4, 0x08)
    .spin()
    .label('delay')
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .nop().nop().nop().nop().nop().nop().nop().nop()
    .bxLr()
    .assemble();

  const handler = new Thumb()
    .movw(4, 0x0000)
    .movt(4, 0x5000)
    .movs(1, 4)
    .strWord(1, 4, 0x00)
    .movw(0, 0x5000)
    .movt(0, 0x2000)
    .movw(1, 0x1234)
    .strWord(1, 0, 0x0c)
    .bxLr()
    .assemble();
  const image = new Uint8Array(0x300);
  const view = new DataView(image.buffer);

  view.setUint32(0, 0x2000_5000, true);
  view.setUint32(4, 0x0800_0091, true);
  view.setUint32(34 * 4, 0x0800_0201, true);
  image.set(mainCode, 0x90);
  image.set(handler, 0x200);

  return image;
}

function dividerModel(name: string, top: number, bottom: number): DeviceIR {
  const builder = createDeviceBuilder({ name });

  builder.pin({
    name: 'y',
    initial: (body) =>
      body.returnValue(
        body.combineIntents(
          body.resistor('vcc', body.constant(types.number, top)),
          body.resistor('gnd', body.constant(types.number, bottom)),
        ),
      ),
  });
  builder.pin({ name: 'vcc' });
  builder.pin({ name: 'gnd' });

  return builder.finish();
}

function boardWithDivider(
  top: number,
  bottom: number,
  firmware: Uint8Array = adc1Firmware(),
): Board {
  return createBoard(
    createDeviceLibrary([
      { id: 'mcu', model, create: adaptDevice(module, { firmware }) as never },
      {
        id: 'divider',
        model: dividerModel('AdcDivider', top, bottom),
        create: () => ({ sync() {}, dispose() {} }),
      },
    ]),
    {
      instances: [
        { id: 'mcu', type: 'mcu', props: { clockFrequency: 16_000_000 } },
        { id: 'divider', type: 'divider' },
      ],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
        {
          id: 'pb12',
          pins: [
            { instance: 'mcu', pin: 'PB12' },
            { instance: 'divider', pin: 'y' },
          ],
        },
        { id: 'div_vcc', voltage: 3.3, pins: [{ instance: 'divider', pin: 'vcc' }] },
        { id: 'div_gnd', voltage: 0, pins: [{ instance: 'divider', pin: 'gnd' }] },
      ],
    },
  );
}

describe('ADC 固件端到端（真实 MCU）', () => {
  it('动态地址（BL 后不重载基址）仍能访问 ADC', () => {
    const board = boardWithDivider(10_000, 10_000, adc1Firmware(false));
    const faults: string[] = [];
    const subscription = board.onDidError((error) => faults.push(error.message));

    try {
      board.runUntil(0);
      board.runUntil(1_000_000_000);
      const sram = (
        board as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!.memories.get('sram')!;
      const code = new DataView(sram.buffer, sram.byteOffset, sram.byteLength).getUint32(
        RESULT_BASE,
        true,
      );

      expect(faults).toEqual([]);
      expect(code).toBe(2048);
    } finally {
      subscription.dispose();
      board.dispose();
    }
  });

  it('PB12 电位器分压 → ADC1_IN11 → SRAM 码值约 2048', () => {
    const board = boardWithDivider(10_000, 10_000);
    const faults: string[] = [];
    const subscription = board.onDidError((error) => faults.push(error.message));

    try {
      board.runUntil(0);
      board.runUntil(1_000_000_000);
      const instance = (
        board as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!;
      const sram = instance.memories.get('sram')!;
      const view = new DataView(sram.buffer, sram.byteOffset, sram.byteLength);
      const code = view.getUint32(RESULT_BASE, true);
      const isr = view.getUint32(RESULT_BASE + 4, true);

      expect(faults).toEqual([]);
      // 3.3 V 参考、等阻分压 1.65 V：round(1.65 / 3.3 × 4095) = 2048。
      expect(code).toBe(2048);
      expect(isr & (1 << 2)).toBe(1 << 2);
    } finally {
      subscription.dispose();
      board.dispose();
    }
  });

  it('EOCIE + NVIC 使能时进入 ADC1_2 向量 34，handler 清 EOC 并写 SRAM', () => {
    const board = boardWithDivider(10_000, 10_000, irqFirmware(true));
    const faults: string[] = [];
    const subscription = board.onDidError((error) => faults.push(error.message));

    try {
      board.runUntil(0);
      board.runUntil(1_000_000_000);
      const sram = (
        board as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!.memories.get('sram')!;
      const magic = new DataView(sram.buffer, sram.byteOffset, sram.byteLength).getUint32(
        RESULT_BASE + 0x0c,
        true,
      );

      expect(faults).toEqual([]);
      expect(magic).toBe(0x1234);
    } finally {
      subscription.dispose();
      board.dispose();
    }
  });

  it('IER=0 时 ADC 转换完成但不进入中断', () => {
    const board = boardWithDivider(10_000, 10_000, irqFirmware(false));
    const faults: string[] = [];
    const subscription = board.onDidError((error) => faults.push(error.message));

    try {
      board.runUntil(0);
      board.runUntil(1_000_000_000);
      const sram = (
        board as unknown as {
          readonly instances: readonly { readonly memories: ReadonlyMap<string, Uint8Array> }[];
        }
      ).instances[0]!.memories.get('sram')!;
      const magic = new DataView(sram.buffer, sram.byteOffset, sram.byteLength).getUint32(
        RESULT_BASE + 0x0c,
        true,
      );

      expect(faults).toEqual([]);
      expect(magic).toBe(0);
    } finally {
      subscription.dispose();
      board.dispose();
    }
  });
});
