import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileDDL } from '@mica-js/sdk/ddl';
import { createJitBlockBuilder, types } from '@mica-js/sdk/model';
import type { BlockIR, DeviceIR, RegionIR } from '@mica-js/sdk/model';
import { decode } from '@mica-js/stm32g431rbt6-core/decode';
import {
  APSR_T,
  APSR_Z,
  SCB_STATE,
  genericTagOffset,
  genericValueOffset,
  genericWordIndex,
} from '@mica-js/stm32g431rbt6-core/layout';
import { activateMachine } from '@mica-js/stm32g431rbt6-core/machine';
import type { Machine } from '@mica-js/stm32g431rbt6-core/machine';
import { PERIPHERALS } from '@mica-js/stm32g431rbt6-core/peripherals';
import { runMcu } from './mcu-harness';
import { createDynamicStmRig, readWord } from './stm-dynamic-rig';

const MODEL_PATH = join(import.meta.dirname, '..', '..', 'stm32g431rbt6', 'src', 'model.ddl');

let modelCache: Promise<DeviceIR> | undefined;

const model = (): Promise<DeviceIR> => {
  modelCache ??= compileDDL(readFileSync(MODEL_PATH, 'utf8'), {
    uri: 'mica:devices/stm32g431rbt6/model.ddl',
  });

  return modelCache;
};

/** 动态 STM 的编码：`stmia.w ip!, {r6,r7,r8,r11}`。 */
const STM_IP_R6_R7_R8_R11 = [0xac, 0xe8, 0xc0, 0x09] as const;
/** `stmia.w ip!, {r6}`（单字；不进入有界循环）。 */
const STM_IP_R6 = [0xac, 0xe8, 0x40, 0x00] as const;
/** `stmia.w ip!, {r0-r11,lr}`（13 words，base 不在 list）。 */
const STM_IP_R0_R11_LR = [0xac, 0xe8, 0xff, 0x4f] as const;
/** `stmia.w ip, {r6,r7}`（W=0，不回写基址）。 */
const STM_IP_NO_WRITEBACK = [0x8c, 0xe8, 0xc0, 0x00] as const;

const bytesOf = (...parts: readonly (readonly number[])[]): Uint8Array => {
  const code = new Uint8Array(0x100);
  let offset = 0;

  for (const part of parts) {
    code.set(part, offset);
    offset += part.length;
  }

  return code;
};

interface Counts {
  readonly operations: number;
  readonly stores: number;
}

const counts = (region: RegionIR): Counts => {
  let operations = 0;
  let stores = 0;
  const visit = (nested: RegionIR): void => {
    for (const operation of nested.operations) {
      operations += 1;
      if (
        operation.kind === 'store8' ||
        operation.kind === 'store16le' ||
        operation.kind === 'store16be' ||
        operation.kind === 'store32le' ||
        operation.kind === 'store32be'
      )
        stores += 1;

      switch (operation.kind) {
        case 'if':
          visit(operation.yes);
          if (operation.no) visit(operation.no);
          break;
        case 'while':
          visit(operation.test.body);
          visit(operation.body);
          break;
        case 'loop':
          visit(operation.body);
          break;
        case 'match':
          for (const arm of operation.arms) visit(arm.body);
          if (operation.otherwise) visit(operation.otherwise);
          break;
        case 'and':
        case 'or':
          visit(operation.right.body);
          break;
        case 'select':
          visit(operation.yes.body);
          visit(operation.no.body);
          break;
        case 'assert':
          if (operation.message) visit(operation.message.body);
          break;
        default:
          break;
      }
    }
  };

  visit(region);
  return { operations, stores };
};

const structuralMachine: Machine = {
  clockFrequency: 16_000_000,
  cyclePs: 1,
  alternateDrivers: [],
  peripherals: [...PERIPHERALS],
  interruptSources: PERIPHERALS.flatMap((peripheral) => peripheral.interrupts ?? []),
  profile: 'stm-dynamic-structure',
};

async function translate(groups: readonly (readonly number[])[]): Promise<BlockIR> {
  const device = await model();
  const code = bytesOf(...groups);

  return activateMachine(structuralMachine, () => {
    const builder = createJitBlockBuilder({ device });
    const regs = Array<number | undefined>(16).fill(undefined);
    let cursor = 0;

    builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
      for (let index = 0; index < groups.length; index += 1) {
        const instruction = decode(code, cursor, regs, code.byteLength);

        instruction.emit(body, cursor);
        cursor = (cursor + instruction.size) >>> 0;
      }
      body.elapse(body.constant(types.number, 1));
    });

    return builder.finish();
  });
}

const blockCounts = (block: BlockIR): Counts => {
  let operations = 0;
  let stores = 0;

  for (const instruction of block.instructions) {
    const counted = counts(instruction.body);

    operations += counted.operations;
    stores += counted.stores;
  }

  return { operations, stores };
};

const stateNumber = (rig: { state(name: string): unknown }, name: string): number =>
  rig.state(name) as number;

describe('动态多寄存器 STM 的 IR 体积', () => {
  it('每个 word 不再复制一份完整写树', async () => {
    const single = blockCounts(await translate([STM_IP_R6]));
    const four = blockCounts(await translate([STM_IP_R6_R7_R8_R11]));
    const wide = blockCounts(await translate([STM_IP_R0_R11_LR]));

    expect(single.stores).toBeGreaterThan(0);
    expect(four.stores, '4-word STM 只发射一份写树').toBe(single.stores);
    expect(wide.stores, '13-word STM 仍只发射一份写树').toBe(single.stores);
    expect(wide.operations, '宽 list 只增加索引选择，不按 word 复制写树').toBeLessThan(
      single.operations * 2,
    );
  });

  it('四条动态 STM 的块保持四条独立写树，而不是十六条', async () => {
    const singleWord = blockCounts(await translate([STM_IP_R6]));
    const batch = blockCounts(
      await translate([
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
      ]),
    );

    // 修复前 4 word × 4 条 = 16 份写树；修复后每条一份，共 4 份。
    expect(batch.stores).toBe(singleWord.stores * 4);
    expect(batch.operations).toBeLessThan(singleWord.operations * 8);
  });
});

describe('动态多寄存器 STM 的执行语义', () => {
  it('同一条 entry 的四条 STM 全部写入，ip/SP/LR/APSR 保持合同', async () => {
    const base = 0x2000_0100;
    const values = [0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444];
    const rig = await createDynamicStmRig({
      code: bytesOf(
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
        STM_IP_R6_R7_R8_R11,
      ),
      count: 4,
      states: {
        r12: base,
        r6: values[0]!,
        r7: values[1]!,
        r8: values[2]!,
        r11: values[3]!,
        sp: 0x2000_0800,
        lr: 0xbbbb_aaaa,
        apsr: APSR_T,
      },
    });

    try {
      rig.run(1);

      const sram = rig.memory('sram');
      const offset = base - 0x2000_0000;

      for (let block = 0; block < 4; block += 1)
        for (let word = 0; word < 4; word += 1)
          expect(readWord(sram, offset + block * 16 + word * 4)).toBe(values[word]);

      expect(stateNumber(rig, 'r12')).toBe(base + 64);
      expect(stateNumber(rig, 'sp')).toBe(0x2000_0800);
      expect(stateNumber(rig, 'lr')).toBe(0xbbbb_aaaa);
      expect(stateNumber(rig, 'apsr')).toBe(APSR_T);
      expect(rig.faults).toEqual([]);

      const block = rig.block();

      expect(block).toBeDefined();
      expect(blockCounts(block!).operations).toBeLessThan(250_000);
    } finally {
      rig.dispose();
    }
  });

  it('W=0 写两个 word 但不回写基址', async () => {
    const base = 0x2000_0120;
    const rig = await createDynamicStmRig({
      code: bytesOf(STM_IP_NO_WRITEBACK),
      count: 1,
      states: { r12: base, r6: 0xaaaa_aaaa, r7: 0xbbbb_bbbb },
    });

    try {
      rig.run(1);

      const sram = rig.memory('sram');
      const offset = base - 0x2000_0000;

      expect(readWord(sram, offset)).toBe(0xaaaa_aaaa);
      expect(readWord(sram, offset + 4)).toBe(0xbbbb_bbbb);
      expect(stateNumber(rig, 'r12')).toBe(base);
      expect(rig.faults).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('13-word list 按寄存器顺序写入', async () => {
    const base = 0x2000_0140;
    const rig = await createDynamicStmRig({
      code: bytesOf(STM_IP_R0_R11_LR),
      count: 1,
      states: {
        r12: base,
        r0: 0x1000_0000,
        r1: 0x1000_0001,
        r2: 0x1000_0002,
        r3: 0x1000_0003,
        r4: 0x1000_0004,
        r5: 0x1000_0005,
        r6: 0x1000_0006,
        r7: 0x1000_0007,
        r8: 0x1000_0008,
        r9: 0x1000_0009,
        r10: 0x1000_000a,
        r11: 0x1000_000b,
        lr: 0x1000_000c,
      },
    });

    try {
      rig.run(1);

      const sram = rig.memory('sram');
      const offset = base - 0x2000_0000;

      for (let word = 0; word < 12; word += 1)
        expect(readWord(sram, offset + word * 4)).toBe(0x1000_0000 + word);

      expect(readWord(sram, offset + 12 * 4)).toBe(0x1000_000c);
      expect(stateNumber(rig, 'r12')).toBe(base + 52);
      expect(rig.faults).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('跨 SRAM/CCM 尾部仍按 word 分派，越界 word 被忽略', async () => {
    const sramBase = 0x2000_57fc;
    const sramRig = await createDynamicStmRig({
      code: bytesOf(STM_IP_R6_R7_R8_R11),
      count: 1,
      states: {
        r12: sramBase,
        r6: 0x1111_1111,
        r7: 0x2222_2222,
        r8: 0x3333_3333,
        r11: 0x4444_4444,
      },
    });

    try {
      sramRig.run(1);

      const sram = sramRig.memory('sram');

      expect(readWord(sram, 0x57fc)).toBe(0x1111_1111);
      expect(stateNumber(sramRig, 'r12')).toBe(sramBase + 16);
      expect(sramRig.faults).toEqual([]);
    } finally {
      sramRig.dispose();
    }

    const ccmBase = 0x1000_27fc;
    const ccmRig = await createDynamicStmRig({
      code: bytesOf(STM_IP_NO_WRITEBACK),
      count: 1,
      states: { r12: ccmBase, r6: 0x5555_5555, r7: 0x6666_6666 },
    });

    try {
      ccmRig.run(1);

      const ccm = ccmRig.memory('ccm');

      expect(readWord(ccm, 0x27fc)).toBe(0x5555_5555);
      expect(stateNumber(ccmRig, 'r12')).toBe(ccmBase);
      expect(ccmRig.faults).toEqual([]);
    } finally {
      ccmRig.dispose();
    }
  });

  it('未建模外设的多 word 写全部落到独立槽位', async () => {
    const base = 0x4001_0000;
    const values = [0xdeda_0001, 0xdeda_0002, 0xdeda_0003, 0xdeda_0004];
    const rig = await createDynamicStmRig({
      code: bytesOf(STM_IP_R6_R7_R8_R11),
      count: 1,
      states: {
        r12: base,
        r6: values[0]!,
        r7: values[1]!,
        r8: values[2]!,
        r11: values[3]!,
      },
    });

    try {
      rig.run(1);

      const generic = rig.memory('generic');

      for (let word = 0; word < values.length; word += 1) {
        const address = base + word * 4;
        const slot = genericWordIndex(address);

        expect(readWord(generic, genericTagOffset(slot))).toBe(address);
        expect(readWord(generic, genericValueOffset(slot))).toBe(values[word]);
      }

      expect(stateNumber(rig, 'r12')).toBe(base + 16);
      expect(rig.faults).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('普通多字 store 与 local exclusive monitor 重叠时清除监视器', async () => {
    // ldrex r0, [r1]; stmia.w r1!, {r6,r7}
    const overlap = await createDynamicStmRig({
      code: bytesOf([0x51, 0xe8, 0x00, 0x0f], [0xa1, 0xe8, 0xc0, 0x00]),
      count: 2,
      states: { r1: 0x2000_0100, r6: 0xaaaa_aaaa, r7: 0xbbbb_bbbb },
    });

    try {
      overlap.run(1);

      const sys = overlap.memory('sys');

      expect(readWord(sys, SCB_STATE + 0x40)).toBe(0);
      expect(readWord(overlap.memory('sram'), 0x100)).toBe(0xaaaa_aaaa);
      expect(readWord(overlap.memory('sram'), 0x104)).toBe(0xbbbb_bbbb);
      expect(overlap.faults).toEqual([]);
    } finally {
      overlap.dispose();
    }

    // ldrex r0, [r1, #0x40]; stmia.w r1!, {r6,r7} 不重叠，监视器保持。
    const disjoint = await createDynamicStmRig({
      code: bytesOf([0x51, 0xe8, 0x10, 0x0f], [0xa1, 0xe8, 0xc0, 0x00]),
      count: 2,
      states: { r1: 0x2000_0100, r6: 0xaaaa_aaaa, r7: 0xbbbb_bbbb },
    });

    try {
      disjoint.run(1);

      expect(readWord(disjoint.memory('sys'), SCB_STATE + 0x40)).toBe(1);
      expect(disjoint.faults).toEqual([]);
    } finally {
      disjoint.dispose();
    }
  });

  it('IT 覆盖的四条 STM 在条件真/假两侧都逐条执行', async () => {
    const code = bytesOf(
      [0x01, 0xbf], // itttt eq：覆盖 4 条，条件 EQ
      STM_IP_R6_R7_R8_R11,
      STM_IP_R6_R7_R8_R11,
      STM_IP_R6_R7_R8_R11,
      STM_IP_R6_R7_R8_R11,
    );

    for (const [label, apsr, active] of [
      ['EQ 成立', APSR_T | APSR_Z, true],
      ['EQ 不成立', APSR_T, false],
    ] as const) {
      const base = 0x2000_0180;
      const rig = await createDynamicStmRig({
        code,
        count: 5,
        states: {
          r12: base,
          r6: 0x1111_1111,
          r7: 0x2222_2222,
          r8: 0x3333_3333,
          r11: 0x4444_4444,
          apsr,
        },
      });

      try {
        rig.run(1);

        const sram = rig.memory('sram');
        const offset = base - 0x2000_0000;
        const values = [0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444];

        for (let word = 0; word < 16; word += 1)
          expect(readWord(sram, offset + word * 4), `${label} word ${word}`).toBe(
            active ? values[word % values.length] : 0,
          );

        expect(stateNumber(rig, 'r12'), `${label} ip`).toBe(active ? base + 64 : base);
        // 本核用左移掩码表示剩余 IT：四条耗尽后为 0x10，低 nibble 为 0 即无活动 IT。
        expect(stateNumber(rig, 'itState'), `${label} itState`).toBe(0x10);
        expect(stateNumber(rig, 'itState') & 0xf, `${label} active IT`).toBe(0);
        expect(stateNumber(rig, 'apsr'), `${label} apsr`).toBe(apsr);
        expect(rig.faults, label).toEqual([]);
      } finally {
        rig.dispose();
      }
    }
  });
});

describe('真实 adapter 入口的四条动态 STM', () => {
  it('原 batch 规模下 generator 可创建并执行到 sentinel', async () => {
    /*
     * 与失败 entry 同形：先经 `ldr.w r5, [sp]` 取得未知指针，再由 `mov ip, r5`
     * 保持 ip 不可证明，随后同一批四条 `stmia.w ip!, {r6,r7,r8,fp}`。
     * 常量来自 hand-assembled 自包含 fixture（不读 dist/ 固件）：
     * reset 建立 unknown ip，四次 STM 写 0x20000100，sentinel 写 0x20000200。
     */
    const firmware = Uint8Array.from([
      0x00, 0x08, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x40, 0xf2, 0x00, 0x10, 0xc2, 0xf2, 0x00,
      0x00, 0xcd, 0xf8, 0x00, 0x00, 0xdd, 0xf8, 0x00, 0x50, 0xac, 0x46, 0x4a, 0xf6, 0xaa, 0x2e,
      0xcb, 0xf6, 0xbb, 0x3e, 0x11, 0x26, 0x22, 0x27, 0x5f, 0xf0, 0x33, 0x08, 0x44, 0xf2, 0x55,
      0x4b, 0xac, 0xe8, 0xc0, 0x09, 0xac, 0xe8, 0xc0, 0x09, 0xac, 0xe8, 0xc0, 0x09, 0xac, 0xe8,
      0xc0, 0x09, 0x40, 0xf2, 0x00, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x5a, 0x22, 0xc0, 0xf8, 0x00,
      0x20, 0xfe, 0xe7,
    ]);
    const view = await runMcu({ firmware, durationPs: 20_000_000 });

    try {
      for (let block = 0; block < 4; block += 1) {
        expect(view.u32(0x100 + block * 16)).toBe(0x0000_0011);
        expect(view.u32(0x100 + block * 16 + 4)).toBe(0x0000_0022);
        expect(view.u32(0x100 + block * 16 + 8)).toBe(0x0000_0033);
        expect(view.u32(0x100 + block * 16 + 12)).toBe(0x0000_4455);
      }

      expect(view.u32(0x200)).toBe(0x5a);
      expect(view.state('r12')).toBe(0x2000_0140);
      expect(view.state('sp')).toBe(0x2000_0800);
      expect(view.state('lr')).toBe(0xbbbb_aaaa);
      expect(view.state('apsr')).toBe(APSR_T);
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });

  it('跨 generic 直写与 GPIO 服务写的多 word STM 不丢写', async () => {
    /*
     * base = 0x47FFFFF8：前两个 word 落在未建模外设后备区（树内 select/yield 直写），
     * 第三个 word 落在 GPIOA_MODER（markService + 服务块写）。同一条动态 STM 内既有
     * 直写又有延迟服务，用来确认循环下标/源值不会被续体重放或跳过。
     */
    const firmware = Uint8Array.from([
      0x00, 0x08, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x4f, 0xf6, 0xf8, 0x70, 0xc4, 0xf2, 0xff,
      0x70, 0xcd, 0xf8, 0x00, 0x00, 0xdd, 0xf8, 0x00, 0x50, 0xac, 0x46, 0x41, 0xf2, 0x11, 0x16,
      0xc1, 0xf2, 0x11, 0x16, 0x42, 0xf2, 0x22, 0x27, 0xc2, 0xf2, 0x22, 0x27, 0x5f, 0xf0, 0x01,
      0x08, 0xac, 0xe8, 0xc0, 0x01, 0x40, 0xf2, 0x00, 0x20, 0xc2, 0xf2, 0x00, 0x00, 0x5a, 0x22,
      0xc0, 0xf8, 0x00, 0x20, 0xfe, 0xe7,
    ]);
    const view = await runMcu({ firmware, durationPs: 20_000_000 });

    try {
      const generic = view.memory('generic');
      const base = 0x47ff_fff8;

      for (const [address, value] of [
        [base, 0x1111_1111],
        [base + 4, 0x2222_2222],
      ] as const) {
        const slot = genericWordIndex(address);

        expect(readWord(generic, genericTagOffset(slot))).toBe(address);
        expect(readWord(generic, genericValueOffset(slot))).toBe(value);
      }

      expect(view.state('gpioModer0')).toBe(1);
      expect(view.u32(0x200)).toBe(0x5a);
      expect(view.state('r12')).toBe(base + 12);
      expect(view.state('sp')).toBe(0x2000_0800);
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });
});
