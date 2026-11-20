import { describe, expect, it } from 'vitest';
import { decode } from '@mica-js/stm32g431rbt6-core/decode';
import type { KnownRegs } from '@mica-js/stm32g431rbt6-core/decode';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';
import { decode32 } from '@mica-js/stm32g431rbt6-core/thumb32';
import { createCpuRig, writeWord } from './cpu-rig';
import { runMcu } from './mcu-harness';

const FLASH = 0x0800_0000;
const SP = 0x2000_1000;

const put = (code: Uint8Array, offset: number, bytes: readonly number[]): void => {
  bytes.forEach((value, index) => {
    code[offset + index] = value & 0xff;
  });
};

const blankRegs = (): KnownRegs => Array<number | undefined>(16).fill(undefined);

describe('ADR.W / ADDW-SUBW PC alignment', () => {
  it('uses Align(pc + 4, 4) when pc % 4 == 2 for SUBW and ADDW', async () => {
    const code = new Uint8Array(0x300);
    put(code, 0x1f6, [0xaf, 0xf2, 0x09, 0x0e]); // subw lr, pc, #9
    put(code, 0x202, [0x0f, 0xf2, 0x04, 0x00]); // addw r0, pc, #4

    const subw = await createCpuRig({
      code,
      codeBase: FLASH,
      pc: FLASH + 0x1f6,
      sp: SP,
      states: { apsr: 0xf000_0000 },
    });

    try {
      subw.run(1);
      expect(subw.state('lr')).toBe(FLASH + 0x1ef);
      expect(subw.state('apsr')).toBe(0xf000_0000);
    } finally {
      subw.dispose();
    }

    const addw = await createCpuRig({
      code,
      codeBase: FLASH,
      pc: FLASH + 0x202,
      sp: SP,
      states: { apsr: 0xf000_0000 },
    });

    try {
      addw.run(1);
      expect(addw.state('r0')).toBe(FLASH + 0x208);
      expect(addw.state('apsr')).toBe(0xf000_0000);
    } finally {
      addw.dispose();
    }
  });

  it('keeps the old pc + 4 base when pc % 4 == 0', async () => {
    const code = new Uint8Array(0x300);
    put(code, 0x100, [0xaf, 0xf2, 0x09, 0x0e]); // subw lr, pc, #9
    put(code, 0x104, [0x0f, 0xf2, 0x04, 0x00]); // addw r0, pc, #4

    const sub = await createCpuRig({
      code,
      codeBase: FLASH,
      pc: FLASH + 0x100,
      sp: SP,
    });

    try {
      sub.run(1);
      expect(sub.state('lr')).toBe(FLASH + 0x0fb);
    } finally {
      sub.dispose();
    }

    const add = await createCpuRig({
      code,
      codeBase: FLASH,
      pc: FLASH + 0x104,
      sp: SP,
    });

    try {
      add.run(1);
      expect(add.state('r0')).toBe(FLASH + 0x10c);
    } finally {
      add.dispose();
    }
  });

  it('keeps Rn != PC as a normal register operand', async () => {
    const addCode = new Uint8Array(0x300);
    put(addCode, 0x202, [0x01, 0xf2, 0x04, 0x00]); // addw r0, r1, #4

    const add = await createCpuRig({
      code: addCode,
      codeBase: FLASH,
      pc: FLASH + 0x202,
      sp: SP,
      states: { r1: 0x1000, apsr: 0xf000_0000 },
    });

    try {
      add.run(1);
      expect(add.state('r0')).toBe(0x1004);
      expect(add.state('r1')).toBe(0x1000);
      expect(add.state('apsr')).toBe(0xf000_0000);
    } finally {
      add.dispose();
    }

    const subCode = new Uint8Array(0x300);
    put(subCode, 0x202, [0xa3, 0xf2, 0x04, 0x02]); // subw r2, r3, #4

    const sub = await createCpuRig({
      code: subCode,
      codeBase: FLASH,
      pc: FLASH + 0x202,
      sp: SP,
      states: { r3: 0x1004, apsr: 0xf000_0000 },
    });

    try {
      sub.run(1);
      expect(sub.state('r2')).toBe(0x1000);
      expect(sub.state('r3')).toBe(0x1004);
      expect(sub.state('apsr')).toBe(0xf000_0000);
    } finally {
      sub.dispose();
    }

    const addRegs = blankRegs();
    addRegs[1] = 0x1000;
    decode(addCode, FLASH + 0x202, addRegs, addCode.byteLength, false, {
      base: FLASH,
      size: addCode.byteLength,
    });
    expect(addRegs[0], 'decoded addw r0, r1, #4').toBe(0x1004);

    const subRegs = blankRegs();
    subRegs[3] = 0x1004;
    decode(subCode, FLASH + 0x202, subRegs, subCode.byteLength, false, {
      base: FLASH,
      size: subCode.byteLength,
    });
    expect(subRegs[2], 'decoded subw r2, r3, #4').toBe(0x1000);
  });

  it('wraps the aligned base as u32 at the 32-bit PC boundary', () => {
    const subRegs = blankRegs();
    decode32(0xf2af, 0x0e01, subRegs, 0xffff_fffe); // subw lr, pc, #1
    expect(subRegs[14]).toBe(0xffff_ffff);

    const addRegs = blankRegs();
    decode32(0xf20f, 0x0001, addRegs, 0xffff_fffe); // addw r0, pc, #1
    expect(addRegs[0]).toBe(1);
  });

  it('does not align the 16-bit MOV R0, PC read', async () => {
    const code = new Uint8Array(0x300);
    put(code, 0x202, [0x78, 0x46]); // mov r0, pc

    const rig = await createCpuRig({
      code,
      codeBase: FLASH,
      pc: FLASH + 0x202,
      sp: SP,
    });

    try {
      rig.run(1);
      expect(rig.state('r0')).toBe(FLASH + 0x206);
    } finally {
      rig.dispose();
    }
  });

  it('records the aligned value in decoded known registers and register facts', () => {
    const code = new Uint8Array(0x300);
    writeWord(code, 0, SP);
    writeWord(code, 4, FLASH + 0x1f1);
    put(code, 0x1f0, [0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf]); // nop; nop; nop
    put(code, 0x1f6, [0xaf, 0xf2, 0x09, 0x0e]); // subw lr, pc, #9
    put(code, 0x1fa, [0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf, 0x00, 0xbf]); // nop x4
    put(code, 0x202, [0x0f, 0xf2, 0x04, 0x00]); // addw r0, pc, #4
    put(code, 0x206, [0x70, 0x47]); // bx lr

    const subRegs = blankRegs();
    decode(code, FLASH + 0x1f6, subRegs, code.byteLength, false, {
      base: FLASH,
      size: code.byteLength,
    });
    expect(subRegs[14], 'decoded known LR').toBe(FLASH + 0x1ef);

    const addRegs = blankRegs();
    decode(code, FLASH + 0x202, addRegs, code.byteLength, false, {
      base: FLASH,
      size: code.byteLength,
    });
    expect(addRegs[0], 'decoded known r0').toBe(FLASH + 0x208);

    const facts = createRegisterFacts(code, code.byteLength);
    const atBranch = facts.at(FLASH + 0x206);

    expect(atBranch?.[14], 'register facts LR').toBe(FLASH + 0x1ef);
    expect(atBranch?.[0], 'register facts r0').toBe(FLASH + 0x208);
  });
});

describe('ADR.W through the production adapter', () => {
  it('loads a static literal through a batch resumed from register facts', async () => {
    const code = new Uint8Array(0x1000);
    writeWord(code, 0, SP);
    writeWord(code, 4, FLASH + 0x009); // reset -> nop at 0x08000008
    put(code, 0x008, [0x00, 0xbf]); // nop
    put(code, 0x00a, [0x0f, 0xf6, 0xf4, 0x60]); // addw r0, pc, #0xef4 -> 0x08000f00
    put(code, 0x00e, [0x1c, 0x49]); // ldr r1, [pc, #0x70] -> 0x08000080
    put(code, 0x010, [0x01, 0x22]); // movs r2, #1
    put(code, 0x012, [0x0a, 0x60]); // str r2, [r1] ; gpio write service
    for (let index = 0; index < 35; index += 1) put(code, 0x014 + index * 2, [0x00, 0xbf]); // nop x35
    put(code, 0x05a, [0x03, 0x68]); // ldr r3, [r0]
    put(code, 0x05c, [0x40, 0xf2, 0x00, 0x04]); // movw r4, #0
    put(code, 0x060, [0xc2, 0xf2, 0x00, 0x04]); // movt r4, #0x2000
    put(code, 0x064, [0x23, 0x60]); // str r3, [r4] -> SRAM[0]
    put(code, 0x066, [0xfe, 0xe7]); // b .
    writeWord(code, 0x080, 0x4800_0018); // GPIOA BSRR
    writeWord(code, 0x0f00, 0x1234_5678); // literal loaded through ADR.W
    writeWord(code, 0x0f04, 0xffff_ffff); // differs from the stale ADR.W target

    const view = await runMcu({ firmware: code, durationPs: 100_000_000 });

    try {
      expect(view.faults).toEqual([]);
      expect(view.u32(0)).toBe(0x1234_5678);
    } finally {
      view.dispose();
    }
  });
});
