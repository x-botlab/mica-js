import { describe, expect, it } from 'vitest';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';
import { FLASH_BASE } from '@mica-js/stm32g431rbt6-core/layout';
import { createCpuRig, codeOf, readWord, writeWord } from './cpu-rig';

const SP = 0x2000_1000;
const BASE = 0x2000_0010;

async function run(
  bytes: readonly number[],
  states: Readonly<Record<string, number | boolean>>,
  sram?: Uint8Array,
  known?: readonly (number | undefined)[],
): Promise<Awaited<ReturnType<typeof createCpuRig>>> {
  const rig = await createCpuRig({
    code: codeOf(bytes),
    sp: SP,
    states,
    ...(sram === undefined ? {} : { sram }),
    ...(known === undefined ? {} : { knownRegs: known }),
  });

  rig.run(1);
  return rig;
}

const registerFacts = (values: Readonly<Record<number, number>>): (number | undefined)[] => {
  const registers = Array<number | undefined>(16).fill(undefined);

  for (const [index, value] of Object.entries(values)) registers[Number(index)] = value;
  return registers;
};

describe('Thumb-2 访存与乘加修正', () => {
  it('LDR/STR T4 负偏移、前索引、后索引按 P/U/W 解释', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    writeWord(sram, offset - 4, 0x1234_5678);
    const loadNegative = await run([0x51, 0xf8, 0x04, 0x0c], { r1: BASE }, sram, registerFacts({ 1: BASE }));

    try {
      expect(loadNegative.state('r0')).toBe(0x1234_5678);
      expect(loadNegative.state('r1')).toBe(BASE);
    } finally {
      loadNegative.dispose();
    }

    const store = new Uint8Array(0x2000);
    const storeNegative = await run([0x41, 0xf8, 0x04, 0x0c], { r0: 0xdead_beef, r1: BASE }, store, registerFacts({ 0: 0xdead_beef, 1: BASE }));

    try {
      expect(readWord(storeNegative.memories.get('sram')!, offset - 4)).toBe(0xdead_beef);
    } finally {
      storeNegative.dispose();
    }

    const pre = new Uint8Array(0x2000);
    writeWord(pre, offset + 4, 0x1122_3344);
    const preIndexed = await run([0x51, 0xf8, 0x04, 0x0f], { r1: BASE }, pre, registerFacts({ 1: BASE }));

    try {
      expect(preIndexed.state('r0')).toBe(0x1122_3344);
      expect(preIndexed.state('r1')).toBe(BASE + 4);
    } finally {
      preIndexed.dispose();
    }

    const post = new Uint8Array(0x2000);
    writeWord(post, offset, 0x5566_7788);
    const postIndexed = await run([0x51, 0xf8, 0x04, 0x0b], { r1: BASE }, post, registerFacts({ 1: BASE }));

    try {
      expect(postIndexed.state('r0')).toBe(0x5566_7788);
      expect(postIndexed.state('r1')).toBe(BASE + 4);
    } finally {
      postIndexed.dispose();
    }
  });

  it('LDRB/LDRH/LDRSB/LDRSH 负偏移与寄存器偏移', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    sram[offset - 1] = 0x80;
    sram[offset - 2] = 0x34;
    sram[offset - 3] = 0x7f;
    const byte = await run([0x11, 0xf8, 0x01, 0x0c], { r1: BASE }, sram, registerFacts({ 1: BASE }));

    try {
      expect(byte.state('r0')).toBe(0x80);
    } finally {
      byte.dispose();
    }

    const signedByte = await run([0x11, 0xf9, 0x01, 0x0c], { r1: BASE }, sram, registerFacts({ 1: BASE }));

    try {
      expect(signedByte.state('r0')).toBe(0xffff_ff80);
    } finally {
      signedByte.dispose();
    }

    const half = await run([0x31, 0xf8, 0x02, 0x0c], { r1: BASE }, sram, registerFacts({ 1: BASE }));

    try {
      expect(half.state('r0')).toBe(0x0000_8034);
    } finally {
      half.dispose();
    }

    const register = await run([0x31, 0xf9, 0x22, 0x00], { r1: BASE - 2, r2: 0 }, sram, registerFacts({ 1: BASE - 2, 2: 0 }));

    try {
      expect(register.state('r0')).toBe(0xffff_8034);
    } finally {
      register.dispose();
    }
  });

  it('LDRD/STRD 正确区分 L/W/P 位并处理前后索引', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    writeWord(sram, offset + 8, 0x1111_1111);
    writeWord(sram, offset + 12, 0x2222_2222);
    const load = await run([0xd2, 0xe9, 0x02, 0x01], { r2: BASE }, sram, registerFacts({ 2: BASE }));

    try {
      expect(load.state('r0')).toBe(0x1111_1111);
      expect(load.state('r1')).toBe(0x2222_2222);
      expect(load.state('r2')).toBe(BASE);
    } finally {
      load.dispose();
    }

    const pre = await run([0xf2, 0xe9, 0x02, 0x01], { r2: BASE }, sram, registerFacts({ 2: BASE }));

    try {
      expect(pre.state('r2')).toBe(BASE + 8);
    } finally {
      pre.dispose();
    }

    const postSram = new Uint8Array(0x2000);
    writeWord(postSram, offset, 0x3333_3333);
    writeWord(postSram, offset + 4, 0x4444_4444);
    const post = await run([0xf2, 0xe8, 0x02, 0x01], { r2: BASE }, postSram, registerFacts({ 2: BASE }));

    try {
      expect(post.state('r0')).toBe(0x3333_3333);
      expect(post.state('r1')).toBe(0x4444_4444);
      expect(post.state('r2')).toBe(BASE + 8);
    } finally {
      post.dispose();
    }

    const store = new Uint8Array(0x2000);
    const stored = await run(
      [0xe2, 0xe9, 0x02, 0x01],
      { r0: 0xaaaa_aaaa, r1: 0xbbbb_bbbb, r2: BASE },
      store,
      registerFacts({ 0: 0xaaaa_aaaa, 1: 0xbbbb_bbbb, 2: BASE }),
    );

    try {
      expect(readWord(stored.memories.get('sram')!, offset + 8)).toBe(0xaaaa_aaaa);
      expect(readWord(stored.memories.get('sram')!, offset + 12)).toBe(0xbbbb_bbbb);
      expect(stored.state('r2')).toBe(BASE + 8);
    } finally {
      stored.dispose();
    }

    const postStore = new Uint8Array(0x2000);
    const postStored = await run(
      [0xe2, 0xe8, 0x02, 0x01],
      { r0: 0xcccc_cccc, r1: 0xdddd_dddd, r2: BASE },
      postStore,
      registerFacts({ 0: 0xcccc_cccc, 1: 0xdddd_dddd, 2: BASE }),
    );

    try {
      const memory = postStored.memories.get('sram')!;

      expect(readWord(memory, offset)).toBe(0xcccc_cccc);
      expect(readWord(memory, offset + 4)).toBe(0xdddd_dddd);
      expect(postStored.state('r2')).toBe(BASE + 8);
    } finally {
      postStored.dispose();
    }
  });

  it('LDREX/STREX 与 LDREXB/H、STREXB/H 不再与 TBB 混淆', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    writeWord(sram, offset + 4, 0x1234_5678);
    const word = await run([0x51, 0xe8, 0x01, 0x0f], { r1: BASE }, sram, registerFacts({ 1: BASE }));

    try {
      expect(word.state('r0')).toBe(0x1234_5678);
    } finally {
      word.dispose();
    }

    const wordStore = new Uint8Array(0x2000);
    const stored = await run(
      [0x51, 0xe8, 0x01, 0x0f, 0x41, 0xe8, 0x01, 0x20],
      { r1: BASE, r2: 0xcafe_babe },
      wordStore,
      registerFacts({ 1: BASE, 2: 0xcafe_babe }),
    );

    try {
      stored.run(1);
      expect(readWord(stored.memories.get('sram')!, offset + 4)).toBe(0xcafe_babe);
      expect(stored.state('r0')).toBe(0);
    } finally {
      stored.dispose();
    }

    const byteSram = new Uint8Array(0x2000);
    byteSram[offset] = 0x80;
    const byte = await run([0xd1, 0xe8, 0x4f, 0x0f], { r1: BASE }, byteSram, registerFacts({ 1: BASE }));

    try {
      expect(byte.state('r0')).toBe(0x80);
    } finally {
      byte.dispose();
    }

    const halfSram = new Uint8Array(0x2000);
    halfSram[offset] = 0x01;
    halfSram[offset + 1] = 0x80;
    const half = await run([0xd1, 0xe8, 0x5f, 0x0f], { r1: BASE }, halfSram, registerFacts({ 1: BASE }));

    try {
      expect(half.state('r0')).toBe(0x0000_8001);
    } finally {
      half.dispose();
    }

    const byteStore = new Uint8Array(0x2000);
    const byteStored = await run(
      [0xd1, 0xe8, 0x4f, 0x3f, 0xc1, 0xe8, 0x40, 0x2f],
      { r1: BASE, r2: 0x1234_56aa },
      byteStore,
      registerFacts({ 1: BASE, 2: 0x1234_56aa }),
    );
    byteStored.run(1);

    try {
      expect(byteStored.memories.get('sram')![offset]).toBe(0xaa);
      expect(byteStored.state('r0')).toBe(0);
    } finally {
      byteStored.dispose();
    }

    const halfStore = new Uint8Array(0x2000);
    const halfStored = await run(
      [0xd1, 0xe8, 0x5f, 0x3f, 0xc1, 0xe8, 0x50, 0x2f],
      { r1: BASE, r2: 0x1234_abcd },
      halfStore,
      registerFacts({ 1: BASE, 2: 0x1234_abcd }),
    );
    halfStored.run(1);

    try {
      const memory = halfStored.memories.get('sram')!;

      expect(memory[offset]).toBe(0xcd);
      expect(memory[offset + 1]).toBe(0xab);
      expect(halfStored.state('r0')).toBe(0);
    } finally {
      halfStored.dispose();
    }
  });

  it('MLA/MLS 使用精确低 32 位乘积', async () => {
    const mla = await run([0x01, 0xfb, 0x02, 0x30], {
      r1: 0x7fff_ffff,
      r2: 0x7fff_ffff,
      r3: 0,
    });

    try {
      expect(mla.state('r0')).toBe(1);
    } finally {
      mla.dispose();
    }

    const mls = await run([0x01, 0xfb, 0x12, 0x30], {
      r1: 0x7fff_ffff,
      r2: 0x7fff_ffff,
      r3: 2,
    });

    try {
      expect(mls.state('r0')).toBe(1);
    } finally {
      mls.dispose();
    }
  });

  it('PLD/PLI 作为预取提示，不写 PC/寄存器', async () => {
    const cases: readonly { readonly bytes: readonly number[]; readonly known?: (number | undefined)[] }[] =
      [
        { bytes: [0x90, 0xf8, 0x00, 0xf0] }, // pld [r0]
        { bytes: [0x10, 0xf8, 0x01, 0xf0], known: registerFacts({ 0: BASE, 1: 0 }) },
        { bytes: [0x90, 0xf9, 0x00, 0xf0] }, // pli [r0]
        { bytes: [0x10, 0xf9, 0x01, 0xf0], known: registerFacts({ 0: BASE, 1: 0 }) },
      ];

    for (const { bytes, known } of cases) {
      const rig = await createCpuRig({
        code: codeOf([...bytes, 0x01, 0x22]),
        sp: SP,
        states: { r0: BASE, r1: 0 },
        ...(known === undefined ? {} : { knownRegs: known }),
      });

      try {
        rig.run(1);
        expect(rig.state('pc'), bytes.join(',')).toBe(4);
        expect(rig.faults, bytes.join(',')).toEqual([]);
        rig.run(1);
        expect(rig.state('r2')).toBe(1);
        expect(rig.state('r0'), bytes.join(',')).toBe(BASE);
      } finally {
        rig.dispose();
      }
    }
  });

  it('REV.W / REV16.W / RBIT / REVSH.W', async () => {
    const rev = await run([0x91, 0xfa, 0x81, 0xf0], { r1: 0x1234_5678 });

    try {
      expect(rev.state('r0')).toBe(0x7856_3412);
    } finally {
      rev.dispose();
    }

    const rev16 = await run([0x91, 0xfa, 0x91, 0xf0], { r1: 0x1234_5678 });

    try {
      expect(rev16.state('r0')).toBe(0x3412_7856);
    } finally {
      rev16.dispose();
    }

    const rbit = await run([0x91, 0xfa, 0xa1, 0xf0], { r1: 1 });

    try {
      expect(rbit.state('r0')).toBe(0x8000_0000);
    } finally {
      rbit.dispose();
    }

    const revsh = await run([0x91, 0xfa, 0xb1, 0xf0], { r1: 0x0000_80ff });

    try {
      expect(revsh.state('r0')).toBe(0xffff_ff80);
    } finally {
      revsh.dispose();
    }
  });

  it('寄存器移位与 SXT/UXT 共享 h1 时按 h2 的 op nibble 区分', async () => {
    const shift = await run([0x01, 0xfa, 0x02, 0xf0], { r1: 1, r2: 3 });

    try {
      expect(shift.state('r0')).toBe(8);
    } finally {
      shift.dispose();
    }

    const extend = await run([0x0f, 0xfa, 0x81, 0xf0], { r1: 0x0000_8000 });

    try {
      expect(extend.state('r0')).toBe(0xffff_8000);
    } finally {
      extend.dispose();
    }
  });
});

describe('Thumb-2 访存静态事实', () => {
  it('负偏移/写回基址在 register-facts 中正确保留或清除', () => {
    const code = new Uint8Array(0x100);

    writeWord(code, 0, 0x2000_1000);
    writeWord(code, 4, FLASH_BASE + 9); // reset | 1
    // movw r1, #0x0000; movt r1, #0x2000; ldr.w r0, [r1, #-4]; adds r2, r0, #1
    [0x40, 0xf2, 0x00, 0x01].forEach((value, index) => (code[8 + index] = value));
    [0xc2, 0xf2, 0x00, 0x01].forEach((value, index) => (code[12 + index] = value));
    [0x51, 0xf8, 0x04, 0x0c].forEach((value, index) => (code[16 + index] = value));
    [0x01, 0x1c].forEach((value, index) => (code[20 + index] = value));

    const facts = createRegisterFacts(code, code.byteLength);
    const registers = facts.at(FLASH_BASE + 0x14);

    expect(registers?.[1], 'r1 base literal').toBe(0x2000_0000);
    expect(registers?.[0], 'r0 load result').toBeUndefined();
  });

  it('DSP 目标寄存器在 facts 中被清除，不保留旧常量', () => {
    const code = new Uint8Array(0x100);

    writeWord(code, 0, 0x2000_1000);
    writeWord(code, 4, FLASH_BASE + 9);
    // movs r2, #1; ssat r2, #8, r0
    [0x01, 0x22].forEach((value, index) => (code[8 + index] = value));
    [0x00, 0xf3, 0x07, 0x02].forEach((value, index) => (code[10 + index] = value));

    const facts = createRegisterFacts(code, code.byteLength);
    const registers = facts.at(FLASH_BASE + 0x0e);

    expect(registers?.[2], 'ssat writes r2').toBeUndefined();
  });
});
