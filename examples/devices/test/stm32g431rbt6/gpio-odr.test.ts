import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '@mica-js/sdk';
import type { Board } from '@mica-js/sdk';
import { compileDDL } from '@mica-js/sdk/ddl';
import { adaptDevice } from './harness';
import {
  GPIO_BSRR,
  GPIO_IDR,
  GPIO_LCKR,
  GPIO_ODR,
  GPIO_OSPEEDR,
  GPIO_OTYPER,
} from '@mica-js/stm32g431rbt6-core/gpio';
import { GPIO_STATE } from '@mica-js/stm32g431rbt6-core/layout';

/**
 * ODR 影子 state 的行为回归。
 *
 * 生产实现已经删掉 ODR 的 `periph` 镜像：ODR 的读写都走 `gpioOdr0`，BSRR/BRR 也只改
 * 这个 state。这里用真实器件、真实 JIT 运行手写 Thumb 固件，并让固件把每次读回的
 * ODR 写进 SRAM；测试从板实例的 `sram` 读取结果。静态地址和动态地址、字/半字/字节、
 * BSRR/BRR 冲突与窄写都在 precise/throughput 两种执行模式下各跑一遍。
 */

const DEVICE_DIR = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src');
/** 固件把结果写到 [SP + 0]，SP 由向量表设为 SRAM 内偏移 0x5000。 */
const RESULT_BASE = 0x5000;
/** 旧 `periph` 镜像里 GPIOA/ODR 的位置；现在必须保持为 0。 */
const PERIPH_ODR = GPIO_STATE + GPIO_ODR;

const [module, model] = await Promise.all([
  import(pathToFileURL(join(DEVICE_DIR, 'index.ts')).href) as Promise<{
    create: unknown;
  }>,
  compileDDL(readFileSync(join(DEVICE_DIR, 'model.ddl'), 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  }),
]);

const VDD = ['VDD1', 'VDD2', 'VDD3', 'VDD4', 'VDDA', 'VREFP', 'VBAT', 'PB7'] as const;
const VSS = ['VSS1', 'VSS2', 'VSS3', 'VSS4', 'VSSA'] as const;

type Execution = 'precise' | 'throughput';

interface InstanceView {
  readonly states: ReadonlyMap<string, unknown>;
  readonly memories: ReadonlyMap<string, Uint8Array>;
}

interface Snapshot {
  readonly sram: Uint8Array;
  readonly odr: number;
  readonly periphOdr: number;
}

function mcuBoard(firmware: Uint8Array, execution: Execution): Board {
  return createBoard(
    createDeviceLibrary([{ id: 'mcu', model, create: adaptDevice(module, { firmware }) as never }]),
    {
      instances: [{ id: 'mcu', type: 'mcu', props: { clockFrequency: 1_000_000 } }],
      nets: [
        { id: 'vdd', voltage: 3.3, pins: VDD.map((pin) => ({ instance: 'mcu', pin })) },
        { id: 'vss', voltage: 0, pins: VSS.map((pin) => ({ instance: 'mcu', pin })) },
      ],
    },
    { execution },
  );
}

/** 运行到固件末尾的 `b .`，并拷贝出 SRAM、ODR state 与旧 periph 镜像位置。 */
function snapshot(firmware: Uint8Array, execution: Execution): Snapshot {
  const board = mcuBoard(firmware, execution);
  const faults: string[] = [];
  const subscription = board.onDidError((error) => faults.push(error.message));

  try {
    board.runUntil(0);
    board.runUntil(1_000_000_000);

    const instance = (board as unknown as { instances: readonly InstanceView[] }).instances[0]!;
    const sram = instance.memories.get('sram')!;
    const periph = instance.memories.get('periph')!;
    const periphView = new DataView(periph.buffer, periph.byteOffset, periph.byteLength);

    expect(board.status).toBe('ready');
    expect(faults).toEqual([]);
    expect(instance.states.get('halted')).not.toBe(true);

    return {
      sram: new Uint8Array(sram),
      odr: Number(instance.states.get('gpioOdr0')) >>> 0,
      periphOdr: periphView.getUint32(PERIPH_ODR, true),
    };
  } finally {
    subscription.dispose();
    board.dispose();
  }
}

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const wordAt = (bytes: Uint8Array, offset: number): number => viewOf(bytes).getUint32(offset, true);
const halfAt = (bytes: Uint8Array, offset: number): number => viewOf(bytes).getUint16(offset, true);
const byteAt = (bytes: Uint8Array, offset: number): number => viewOf(bytes).getUint8(offset);

/** 手写 Thumb-2 子集；每条方法都只发射本测试用到的确定编码。 */
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

  /** 静态地址，字/半字/字节，12 位字节偏移。 */
  strWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8c0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrWord(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8d0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strHalf(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8a0 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrHalf(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf8b0 | rn, (rt << 12) | (offset & 0xfff));
  }

  strByte(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf880 | rn, (rt << 12) | (offset & 0xfff));
  }

  ldrByte(rt: number, rn: number, offset: number): this {
    return this.#dword(0xf890 | rn, (rt << 12) | (offset & 0xfff));
  }

  /** 基址寄存器运行期才确定：16 位 load/store，偏移固定为 0。 */
  strAt(rt: number, rn: number): this {
    return this.#half(0x6000 | (rn << 3) | rt);
  }

  ldrAt(rt: number, rn: number): this {
    return this.#half(0x6800 | (rn << 3) | rt);
  }

  strhAt(rt: number, rn: number): this {
    return this.#half(0x8000 | (rn << 3) | rt);
  }

  ldrhAt(rt: number, rn: number): this {
    return this.#half(0x8800 | (rn << 3) | rt);
  }

  strbAt(rt: number, rn: number): this {
    return this.#half(0x7000 | (rn << 3) | rt);
  }

  ldrbAt(rt: number, rn: number): this {
    return this.#half(0x7800 | (rn << 3) | rt);
  }

  ldrsbReg(rt: number, rn: number, rm: number): this {
    return this.#half(0x5600 | (rm << 6) | (rn << 3) | rt);
  }

  ldmia(rn: number, list: number): this {
    return this.#half(0xc800 | (rn << 8) | list);
  }

  strSp(rt: number, offset: number): this {
    return this.#half(0x9000 | (rt << 8) | ((offset >>> 2) & 0xff));
  }

  ldrSp(rt: number, offset: number): this {
    return this.#half(0x9800 | (rt << 8) | ((offset >>> 2) & 0xff));
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

/** GPIOA 基址 0x48000000；SRAM 结果通过 SP 写出。 */
function gpioBase(code: Thumb): Thumb {
  return code.movw(0, 0x0000).movt(0, 0x4800);
}

/** 静态 ODR：字写 → 低半字写 → 字节写，每一步都读回整字；最后读窄字段。 */
function staticOdrFirmware(): Uint8Array {
  return gpioBase(new Thumb())
    .movw(1, 0x5678)
    .movt(1, 0x1234)
    .strWord(1, 0, GPIO_ODR)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x00)
    .movw(1, 0xbeef)
    .strHalf(1, 0, GPIO_ODR)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x04)
    .movs(1, 0x5a)
    .strByte(1, 0, GPIO_ODR + 1)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x08)
    .ldrHalf(3, 0, GPIO_ODR)
    .strSp(3, 0x0c)
    .ldrByte(3, 0, GPIO_ODR + 1)
    .strSp(3, 0x10)
    .spin()
    .build();
}

/** 动态地址 ODR：基址先经 SRAM 往返，使 JIT 无法证明地址。 */
function dynamicOdrFirmware(): Uint8Array {
  return gpioBase(new Thumb())
    .strSp(0, 0x18)
    .ldrSp(4, 0x18)
    .adds(4, GPIO_ODR)
    .movw(1, 0xcdef)
    .movt(1, 0x89ab)
    .strAt(1, 4)
    .ldrAt(2, 4)
    .strSp(2, 0x00)
    .movw(1, 0xcafe)
    .ldrSp(5, 0x18)
    .adds(5, GPIO_ODR)
    .strhAt(1, 5)
    .ldrAt(2, 4)
    .strSp(2, 0x04)
    .movs(1, 0x77)
    .ldrSp(6, 0x18)
    .adds(6, GPIO_ODR + 1)
    .strbAt(1, 6)
    .ldrAt(2, 4)
    .strSp(2, 0x08)
    .ldrhAt(3, 5)
    .strSp(3, 0x0c)
    .ldrbAt(3, 6)
    .strSp(3, 0x10)
    .spin()
    .build();
}

/** 静态 BSRR/BRR：同位 set/reset 冲突、半字与字节窄写。 */
function staticBsrrFirmware(): Uint8Array {
  return gpioBase(new Thumb())
    .movw(1, 0x0020)
    .movt(1, 0x0020)
    .strWord(1, 0, 0x18)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x00)
    .ldrWord(2, 0, 0x18)
    .strSp(2, 0x04)
    .movs(1, 0x20)
    .strWord(1, 0, 0x28)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x08)
    .movs(1, 0xc0)
    .strHalf(1, 0, 0x18)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x0c)
    .movs(1, 0x40)
    .strHalf(1, 0, 0x1a)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x10)
    .movs(1, 0x80)
    .strByte(1, 0, 0x28)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x14)
    .movs(1, 0x01)
    .strByte(1, 0, 0x19)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x18)
    .spin()
    .build();
}

/** 动态地址 BSRR/BRR：同样的冲突与窄写，只把基址改成运行期未知。 */
function dynamicBsrrFirmware(): Uint8Array {
  return gpioBase(new Thumb())
    .strSp(0, 0x18)
    .ldrSp(4, 0x18)
    .adds(4, 0x18)
    .movw(1, 0x0020)
    .movt(1, 0x0020)
    .strAt(1, 4)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x00)
    .ldrSp(5, 0x18)
    .adds(5, 0x28)
    .movs(1, 0x20)
    .strAt(1, 5)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x04)
    .ldrSp(6, 0x18)
    .adds(6, 0x18)
    .movs(1, 0xc0)
    .strhAt(1, 6)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x08)
    .ldrSp(7, 0x18)
    .adds(7, 0x1a)
    .movs(1, 0x40)
    .strhAt(1, 7)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x0c)
    .ldrSp(6, 0x18)
    .adds(6, 0x28)
    .movs(1, 0x80)
    .strbAt(1, 6)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x10)
    .ldrSp(6, 0x18)
    .adds(6, 0x19)
    .movs(1, 0x01)
    .strbAt(1, 6)
    .ldrWord(2, 0, GPIO_ODR)
    .strSp(2, 0x14)
    .spin()
    .build();
}

type ResultWidth = 'word' | 'half' | 'byte';

interface ExpectedResult {
  readonly offset: number;
  readonly width: ResultWidth;
  readonly value: number;
}

/** 两种执行模式必须都读完同一组 SRAM 结果，且 ODR state 与旧 periph 镜像符合预期。 */
function expectModesAgree(
  firmware: Uint8Array,
  odr: number,
  results: readonly ExpectedResult[],
): void {
  const precise = snapshot(firmware, 'precise');
  const throughput = snapshot(firmware, 'throughput');

  for (const mode of [precise, throughput]) {
    expect(mode.odr).toBe(odr >>> 0);
    // ODR 没有 periph 镜像；若读回结果正确而这里非 0，说明有代码又写回了旧位置。
    expect(mode.periphOdr).toBe(0);

    for (const { offset, width, value } of results) {
      const actual =
        width === 'word'
          ? wordAt(mode.sram, RESULT_BASE + offset)
          : width === 'half'
            ? halfAt(mode.sram, RESULT_BASE + offset)
            : byteAt(mode.sram, RESULT_BASE + offset);

      expect(actual).toBe(value >>> 0);
    }
  }

  // 两个模式的完整结果窗口一致；不比较窗口外的栈内容。
  expect(throughput.sram.subarray(RESULT_BASE, RESULT_BASE + 0x20)).toEqual(
    precise.sram.subarray(RESULT_BASE, RESULT_BASE + 0x20),
  );
}

describe('GPIO ODR 影子 state', () => {
  it('静态地址的字/半字/字节 ODR 读写回读一致', () => {
    expectModesAgree(staticOdrFirmware(), 0x12345aef, [
      { offset: 0x00, width: 'word', value: 0x12345678 },
      { offset: 0x04, width: 'word', value: 0x1234beef },
      { offset: 0x08, width: 'word', value: 0x12345aef },
      { offset: 0x0c, width: 'half', value: 0x5aef },
      { offset: 0x10, width: 'byte', value: 0x5a },
    ]);
  });

  it('动态地址的字/半字/字节 ODR 读写回读一致', () => {
    expectModesAgree(dynamicOdrFirmware(), 0x89ab77fe, [
      { offset: 0x00, width: 'word', value: 0x89abcdef },
      { offset: 0x04, width: 'word', value: 0x89abcafe },
      { offset: 0x08, width: 'word', value: 0x89ab77fe },
      { offset: 0x0c, width: 'half', value: 0x77fe },
      { offset: 0x10, width: 'byte', value: 0x77 },
    ]);
  });

  it('静态 BSRR/BRR 的冲突与窄写按位生效', () => {
    expectModesAgree(staticBsrrFirmware(), 0x100, [
      { offset: 0x00, width: 'word', value: 0x20 },
      { offset: 0x04, width: 'word', value: 0 },
      { offset: 0x08, width: 'word', value: 0 },
      { offset: 0x0c, width: 'word', value: 0xc0 },
      { offset: 0x10, width: 'word', value: 0x80 },
      { offset: 0x14, width: 'word', value: 0 },
      { offset: 0x18, width: 'word', value: 0x100 },
    ]);
  });

  it('动态地址 BSRR/BRR 的冲突与窄写按位生效', () => {
    expectModesAgree(dynamicBsrrFirmware(), 0x100, [
      { offset: 0x00, width: 'word', value: 0x20 },
      { offset: 0x04, width: 'word', value: 0 },
      { offset: 0x08, width: 'word', value: 0xc0 },
      { offset: 0x0c, width: 'word', value: 0x80 },
      { offset: 0x10, width: 'word', value: 0 },
      { offset: 0x14, width: 'word', value: 0x100 },
    ]);
  });
});

it('动态 GPIOB 读覆盖延迟 IDR 符号扩展、内联 LDM、锁定副作用和空端口', () => {
  const firmware = new Thumb()
    .movw(0, 0x400)
    .movt(0, 0x4800)
    .movs(1, 0x80)
    .strWord(1, 0, GPIO_OSPEEDR)
    .strWord(1, 0, GPIO_ODR)
    .strSp(0, 0x20)
    .ldrSp(4, 0x20)
    .movs(5, GPIO_IDR)
    .ldrsbReg(2, 4, 5)
    .strSp(2, 0)
    .adds(4, GPIO_OSPEEDR)
    .ldrbAt(2, 4)
    .strSp(2, 4)
    .adds(4, GPIO_IDR - GPIO_OSPEEDR)
    .ldmia(4, (1 << 2) | (1 << 3))
    .strSp(2, 8)
    .strSp(3, 12)
    .ldrSp(4, 0x20)
    .adds(4, GPIO_BSRR)
    .ldrAt(2, 4)
    .strSp(2, 16)
    .movw(1, 1)
    .movt(1, 1)
    .strWord(1, 0, GPIO_LCKR)
    .movs(1, 1)
    .strWord(1, 0, GPIO_LCKR)
    .movt(1, 1)
    .strWord(1, 0, GPIO_LCKR)
    .adds(4, GPIO_LCKR - GPIO_BSRR)
    .ldrAt(2, 4)
    .strSp(2, 20)
    .movs(1, 3)
    .strWord(1, 0, GPIO_OTYPER)
    .ldrWord(2, 0, GPIO_OTYPER)
    .strSp(2, 24)
    .movw(0, 0x1400 + GPIO_IDR)
    .movt(0, 0x4800)
    .strSp(0, 0x20)
    .ldrSp(4, 0x20)
    .ldrAt(2, 4)
    .strSp(2, 28)
    .spin()
    .build();

  expectModesAgree(
    firmware,
    0,
    [0xffff_ff80, 0x80, 0x80, 0x80, 0, 0x1_0001, 2, 0].map((value, index) => ({
      offset: 4 * index,
      width: 'word',
      value,
    })),
  );
});
