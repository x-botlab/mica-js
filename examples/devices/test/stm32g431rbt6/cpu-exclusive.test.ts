import { describe, expect, it } from 'vitest';
import { createCpuRig, codeOf, readWord, writeWord } from './cpu-rig';

const SRAM_BASE = 0x2000_0000;
const BASE = SRAM_BASE + 0x10;
const SP = SRAM_BASE + 0x1000;

const known = (): (number | undefined)[] => {
  const registers = Array<number | undefined>(16).fill(undefined);

  registers[1] = BASE;
  registers[3] = 0x1111_1111;
  registers[6] = 0x22;
  registers[7] = 0x7777_7777;

  return registers;
};

const sramOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): Uint8Array =>
  rig.memories.get('sram')!;

describe('Cortex-M4 local exclusive monitor', () => {
  it('LDREX + matching STREX succeeds once; second STREX fails', async () => {
    const sram = new Uint8Array(0x2000);
    const rig = await createCpuRig({
      code: codeOf([
        0x51, 0xe8, 0x00, 0x0f, // ldrex r0,[r1]
        0x41, 0xe8, 0x00, 0x32, // strex r2,r3,[r1]
        0x41, 0xe8, 0x00, 0x32, // strex r2,r3,[r1]
      ]),
      sp: SP,
      sram,
      knownRegs: known(),
      states: { r3: 0x1111_1111, r6: 0x22, r7: 0x7777_7777 },
    });

    try {
      rig.run(1); // ldrex
      rig.run(1); // strex success
      expect(rig.state('r2')).toBe(0);
      expect(readWord(sramOf(rig), BASE - SRAM_BASE)).toBe(0x1111_1111);

      rig.run(1); // strex no monitor
      expect(rig.state('r2')).toBe(1);
      expect(readWord(sramOf(rig), BASE - SRAM_BASE)).toBe(0x1111_1111);
    } finally {
      rig.dispose();
    }
  });

  it('CLREX and width mismatch clear/fail the monitor', async () => {
    const sram = new Uint8Array(0x2000);
    const rig = await createCpuRig({
      code: codeOf([
        0x51, 0xe8, 0x00, 0x0f, // ldrex r0,[r1]
        0xbf, 0xf3, 0x2f, 0x8f, // clrex
        0x41, 0xe8, 0x00, 0x32, // strex r2,r3,[r1]
      ]),
      sp: SP,
      sram,
      knownRegs: known(),
      states: { r3: 0x1111_1111, r6: 0x22, r7: 0x7777_7777 },
    });

    try {
      rig.run(1); // ldrex
      rig.run(1); // clrex
      rig.run(1); // strex -> fail
      expect(rig.state('r2')).toBe(1);
      expect(readWord(sramOf(rig), BASE - SRAM_BASE)).toBe(0);
    } finally {
      rig.dispose();
    }

    const width = await createCpuRig({
      code: codeOf([
        0x51, 0xe8, 0x00, 0x0f, // ldrex r0,[r1]
        0xc1, 0xe8, 0x45, 0x6f, // strexb r5,r6,[r1]
      ]),
      sp: SP,
      sram,
      knownRegs: known(),
      states: { r3: 0x1111_1111, r6: 0x22, r7: 0x7777_7777 },
    });

    try {
      width.run(1);
      width.run(1);
      expect(width.state('r5')).toBe(1);
      expect(sramOf(width)[BASE - SRAM_BASE]).toBe(0);
    } finally {
      width.dispose();
    }
  });

  it('normal store overlapping the monitor address clears it', async () => {
    const sram = new Uint8Array(0x2000);
    const rig = await createCpuRig({
      code: codeOf([
        0x51, 0xe8, 0x00, 0x0f, // ldrex r0,[r1]
        0x0f, 0x60, // str r7,[r1]
        0x41, 0xe8, 0x00, 0x32, // strex r2,r3,[r1]
      ]),
      sp: SP,
      sram,
      knownRegs: known(),
      states: { r3: 0x1111_1111, r6: 0x22, r7: 0x7777_7777 },
    });

    try {
      rig.run(1);
      rig.run(1);
      rig.run(1);
      expect(readWord(sramOf(rig), BASE - SRAM_BASE)).toBe(0x7777_7777);
      expect(rig.state('r2')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('exception entry clears the monitor (SVC path)', async () => {
    const code = codeOf([
      0x51, 0xe8, 0x00, 0x0f, // ldrex r0,[r1]
      0x00, 0xdf, // svc #0
      0x00, 0xbf,
      0x41, 0xe8, 0x00, 0x32, // strex r2,r3,[r1]
    ]);
    const handler = 0x40;

    writeWord(code, 11 * 4, handler | 1);
    code[handler] = 0x70; // bx lr
    code[handler + 1] = 0x47;
    const rig = await createCpuRig({ code, sp: SP, knownRegs: known() });

    try {
      rig.run(1); // ldrex
      rig.run(1); // svc -> handler
      rig.run(1); // bx lr
      rig.run(1); // nop
      rig.run(1); // strex -> fail
      expect(rig.state('r2')).toBe(1);
    } finally {
      rig.dispose();
    }
  });
});
