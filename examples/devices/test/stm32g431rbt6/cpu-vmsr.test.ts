import { describe, expect, it } from 'vitest';
import { decode } from '@mica-js/stm32g431rbt6-core/decode';
import {
  FPCCR_RESET,
  FP_CONTEXT_UNSUPPORTED,
  FPSCR_WRITE_MASK,
  FPU_FPCCR,
  FPU_FPSCR,
} from '@mica-js/stm32g431rbt6-core/fpu-layout';
import { regState, SCB_STATE } from '@mica-js/stm32g431rbt6-core/layout';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';
import { decode32 } from '@mica-js/stm32g431rbt6-core/thumb32';
import { createCpuRig, codeOf, readWord, writeWord } from './cpu-rig';
import { runMcu } from './mcu-harness';
import { SystemThumb } from './system-thumb';

const SP = 0x2000_1000;
const VMSR_R0 = [0xe1, 0xee, 0x10, 0x0a] as const;
const MOVS_R1_5A = [0x5a, 0x21] as const; // movs r1, #0x5a
const CPACR = SCB_STATE + 0x88;
const H_CONTROL = SCB_STATE + 0x90;
const H_MODE = SCB_STATE + 0xb0;
const H_DEPTH = SCB_STATE + 0xb4;
const H_ACTIVE_EXC = SCB_STATE + 0xb8;
const SHCSR = SCB_STATE + 0x24;
const CFSR = SCB_STATE + 0x28;

const sysWith = (entries: Readonly<Record<number, number>>): Uint8Array => {
  const sys = new Uint8Array(0x200);

  for (const [offset, value] of Object.entries(entries)) writeWord(sys, Number(offset), value);
  return sys;
};

const fpscrOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): number =>
  readWord(rig.memories.get('periph')!, FPU_FPSCR);
const fpccrOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): number =>
  readWord(rig.memories.get('periph')!, FPU_FPCCR);
const controlOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): number =>
  readWord(rig.memories.get('sys')!, H_CONTROL);
const fpcaOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): boolean =>
  (controlOf(rig) & 4) !== 0;
const ipsrOf = (rig: Awaited<ReturnType<typeof createCpuRig>>): number => {
  const sys = rig.memories.get('sys')!;

  return readWord(sys, H_DEPTH) === 0 ? 0 : readWord(sys, H_ACTIVE_EXC) & 0x1ff;
};
const setFpccr = (rig: Awaited<ReturnType<typeof createCpuRig>>, value: number): void => {
  writeWord(rig.memories.get('periph')!, FPU_FPCCR, value);
};

async function runVmsr(
  rt: number,
  options: {
    readonly value?: number | undefined;
    readonly apsr?: number | undefined;
    readonly cpacr?: number | undefined;
    readonly control?: number | undefined;
    readonly mode?: number | undefined;
  } = {},
): Promise<Awaited<ReturnType<typeof createCpuRig>>> {
  const value = options.value ?? 0x0300_0000;
  const states: Record<string, number> = { apsr: options.apsr ?? 0, [regState(rt)]: value };

  return createCpuRig({
    code: codeOf([...VMSR_R0.slice(0, 2), 0x10, ((rt << 4) | 0x0a) & 0xff, ...MOVS_R1_5A]),
    sp: SP,
    states,
    ...(options.cpacr === undefined && options.control === undefined && options.mode === undefined
      ? {}
      : {
          sys: sysWith({
            [CPACR]: options.cpacr ?? 0x00f0_0000,
            ...(options.control === undefined ? {} : { [H_CONTROL]: options.control }),
            ...(options.mode === undefined ? {} : { [H_MODE]: options.mode }),
          }),
        }),
  });
}

describe('production VMSR FPSCR', () => {
  it('writes FPSCR[31:28,26:22,7,4:0], keeps GPR/APSR, and reaches the next instruction', async () => {
    const rig = await runVmsr(0, {
      value: 0xffff_ffff,
      apsr: 0xf000_0000,
      cpacr: 0x00f0_0000,
    });

    try {
      rig.run(1);
      expect(fpscrOf(rig)).toBe(FPSCR_WRITE_MASK);
      expect(rig.state('r0')).toBe(0xffff_ffff);
      expect(rig.state('apsr')).toBe(0xf000_0000);
      expect(fpcaOf(rig)).toBe(true);

      rig.run(1);
      expect(rig.state('r1')).toBe(0x5a);
      expect(rig.state('pc')).toBe(6);
      expect(fpscrOf(rig)).toBe(FPSCR_WRITE_MASK);
    } finally {
      rig.dispose();
    }
  });

  it.each([0, 1, 12, 14])('accepts legal source register r%i', async (rt) => {
    const rig = await runVmsr(rt, { value: 0x0300_0000, cpacr: 0x00f0_0000 });

    try {
      rig.run(1);
      expect(fpscrOf(rig)).toBe(0x0300_0000);
    } finally {
      rig.dispose();
    }
  });

  it('clears reserved FPSCR bits instead of carrying them through a write', async () => {
    const rig = await runVmsr(0, { value: 0, cpacr: 0x00f0_0000 });
    const periph = new Uint8Array(0x1000);

    writeWord(periph, FPU_FPSCR, 0xffff_ffff);
    try {
      rig.memories.get('periph')!.set(periph);
      rig.run(1);
      expect(fpscrOf(rig)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('decodes as a serviceable, non-terminating boundary with GPR facts preserved', () => {
    const regs = Array<number | undefined>(16).fill(undefined);

    regs[5] = 0x1234_5678;
    regs[9] = 0x9abc_def0;
    const decoded = decode32(0xeee1, 0x0a10, regs, 0x0800_1000);

    expect(decoded.terminates).not.toBe(true);
    expect(decoded.mayService).toBe(true);
    expect(decoded.boundaryAfter).toBe(true);
    expect(decoded.dynamicMemory).toBe(false);
    expect(regs[5]).toBe(0x1234_5678);
    expect(regs[9]).toBe(0x9abc_def0);

    const code = codeOf([...VMSR_R0, ...MOVS_R1_5A]);

    expect(decode(code, 0, regs, code.byteLength).endsBatch).toBe(true);
  });

  it('keeps register facts across the VMSR batch boundary', () => {
    const firmware = new Uint8Array([
      0x00,
      0x10,
      0x00,
      0x20, // initial SP
      0x09,
      0x00,
      0x00,
      0x08, // reset = 0x08000009
      0x12,
      0x25, // movs r5, #0x12
      ...VMSR_R0,
      0x34,
      0x26, // movs r6, #0x34
      0x70,
      0x47, // bx lr
    ]);
    const facts = createRegisterFacts(firmware, firmware.byteLength);

    expect(facts.at(0xe)?.[5]).toBe(0x12);
  });

  it('leaves VMRS, reserved VMSR forms, and other VFP encodings unsupported', async () => {
    // VMRS FPSCR, Rt；VMSR Rt=13/15；错误协处理器字段；VADD。
    for (const [h1, h2] of [
      [0xeef1, 0x0a10],
      [0xeee1, 0xda10],
      [0xeee1, 0xfa10],
      [0xeee1, 0x0a11],
      [0xee30, 0x1a20],
    ] as const) {
      expect(decode32(h1, h2).terminates, `${h1.toString(16)} ${h2.toString(16)}`).toBe(true);
    }

    const rig = await createCpuRig({
      code: codeOf([0xf1, 0xee, 0x10, 0x0a, ...MOVS_R1_5A]), // vmrs r0, fpscr
      sp: SP,
      states: { r0: 0x0300_0000 },
    });

    try {
      rig.run(1);
      expect(rig.faults).toEqual([0x20]);
      expect(fpscrOf(rig)).toBe(0);
      expect(rig.state('r1')).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});

describe('FPCCR/FPCA contract', () => {
  it('starts with FPCCR reset C0000000, FPSCR 0, and FPCA 0', async () => {
    const rig = await createCpuRig({
      code: codeOf([...VMSR_R0, ...MOVS_R1_5A]),
      sp: SP,
      states: { r0: 0x0300_0000 },
    });

    try {
      expect(fpccrOf(rig)).toBe(FPCCR_RESET);
      expect(fpscrOf(rig)).toBe(0);
      expect(fpcaOf(rig)).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it('exposes FPCCR ASPEN/LSPEN through privileged MMIO and reads back writes', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    address(0, 0xe000_ef34);
    t.ldrWord(1, 0, 0);
    address(2, 0x2000_0000);
    t.strWord(1, 2, 0);
    address(1, 0x4000_0000); // ASPEN=0, LSPEN=1
    t.strWord(1, 0, 0);
    t.ldrWord(1, 0, 0);
    t.strWord(1, 2, 4);
    address(1, 1); // attempt to fake hardware LSPACT
    t.strWord(1, 0, 0);
    t.ldrWord(1, 0, 0);
    t.strWord(1, 2, 8);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 20_000_000 });

    try {
      expect(view.u32(0)).toBe(FPCCR_RESET);
      expect(view.u32(4)).toBe(0x4000_0000);
      expect(view.u32(8)).toBe(0); // LSPACT is read-only and stays 0
    } finally {
      view.dispose();
    }
  });

  it('ignores unprivileged FPCCR writes and reads as zero without a PPB BusFault model', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.mark('start');
    t.movs(0, 1);
    t.msr(0, 20); // CONTROL.nPRIV=1
    address(0, 0xe000_ef34);
    t.movs(1, 0);
    t.strWord(1, 0, 0);
    t.ldrWord(1, 0, 0);
    address(2, 0x2000_0000);
    t.strWord(1, 2, 0);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 20_000_000 });

    try {
      expect(view.u32(0)).toBe(0);
      expect(readWord(view.memory('periph'), FPU_FPCCR)).toBe(FPCCR_RESET);
    } finally {
      view.dispose();
    }
  });

  it('keeps FPCA unchanged when ASPEN=0 and preserves nPRIV/SPSEL when activating', async () => {
    const aspenOff = await runVmsr(0, {
      value: 0x0300_0000,
      cpacr: 0x00f0_0000,
      control: 3, // nPRIV=1, SPSEL=1, FPCA=0
    });

    try {
      setFpccr(aspenOff, 0x4000_0000); // ASPEN=0, LSPEN=1
      aspenOff.run(1);
      expect(fpscrOf(aspenOff)).toBe(0x0300_0000);
      expect(fpcaOf(aspenOff)).toBe(false);
      expect(controlOf(aspenOff)).toBe(3);
    } finally {
      aspenOff.dispose();
    }

    const activating = await runVmsr(0, {
      value: 0x0300_0000,
      cpacr: 0x00f0_0000,
      control: 3, // nPRIV=1, SPSEL=1, FPCA=0
    });

    try {
      activating.run(1);
      expect(fpscrOf(activating)).toBe(0x0300_0000);
      expect(controlOf(activating)).toBe(7); // only bit2 added
    } finally {
      activating.dispose();
    }

    const alreadyActive = await runVmsr(0, {
      value: 0x0300_0000,
      cpacr: 0x00f0_0000,
      control: 7, // nPRIV=1, SPSEL=1, FPCA=1
    });

    try {
      alreadyActive.run(1);
      expect(fpscrOf(alreadyActive)).toBe(0x0300_0000);
      expect(controlOf(alreadyActive)).toBe(7);
    } finally {
      alreadyActive.dispose();
    }
  });

  it('stops at VMSR with 0x21 when LSPACT=1 and does not write FPSCR/FPCA', async () => {
    const rig = await runVmsr(0, { value: 0x0300_0000, cpacr: 0x00f0_0000 });

    try {
      setFpccr(rig, 0xc000_0001);
      rig.run(1);
      expect(rig.faults).toEqual([FP_CONTEXT_UNSUPPORTED]);
      expect(rig.state('pc')).toBe(0);
      expect(fpscrOf(rig)).toBe(0);
      expect(fpcaOf(rig)).toBe(false);
      expect(fpccrOf(rig)).toBe(0xc000_0001);
    } finally {
      rig.dispose();
    }
  });

  it('takes NOCP before the LSPACT=1 FP-context stop when CPACR denies access', async () => {
    const rig = await runVmsr(0, { value: 0x0300_0000, cpacr: 0 });

    try {
      setFpccr(rig, 0xc000_0001);
      rig.run(1);
      expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(1 << 19);
      expect(rig.faults).toEqual([]);
      expect(fpscrOf(rig)).toBe(0);
      expect(fpcaOf(rig)).toBe(false);
    } finally {
      rig.dispose();
    }
  });
});

describe('VMSR CPACR privilege and NOCP', () => {
  it.each([
    ['CPACR=00', 0x0000_0000, 0, undefined, 'nocp'],
    ['CPACR=10', 0x00a0_0000, 0, undefined, 'unsupported'],
    ['CPACR mismatch', 0x00b0_0000, 0, undefined, 'unsupported'],
    ['CPACR=01 privileged thread', 0x0050_0000, 0, undefined, 'write'],
    ['CPACR=01 unprivileged thread', 0x0050_0000, 1, undefined, 'nocp'],
    ['CPACR=01 handler', 0x0050_0000, 1, 1, 'write'],
    ['CPACR=11 unprivileged thread', 0x00f0_0000, 1, undefined, 'write'],
  ] as const)(
    '%s: permission follows CP10/CP11 and current privilege',
    async (_name, cpacr, control, mode, expected) => {
      const rig = await runVmsr(0, { value: 0x0300_0000, cpacr, control, mode });

      try {
        rig.run(1);
        if (expected === 'write') {
          expect(fpscrOf(rig)).toBe(0x0300_0000);
          expect(fpcaOf(rig)).toBe(true);
        } else {
          expect(fpscrOf(rig)).toBe(0);
          expect(fpcaOf(rig)).toBe(false);
          if (expected === 'nocp') {
            expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(1 << 19);
            expect(rig.faults).toEqual([]);
          } else {
            expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(0);
            expect(rig.faults).toEqual([0x20]);
          }
        }
      } finally {
        rig.dispose();
      }
    },
  );

  it('records NOCP and leaves the faulting PC pointing at VMSR', async () => {
    const code = codeOf([...VMSR_R0, ...MOVS_R1_5A]);

    const sys = sysWith({ [CPACR]: 0, [SHCSR]: 1 << 16 });
    const rig = await createCpuRig({
      code,
      sp: SP,
      pc: 0,
      states: { r0: 0x0300_0000 },
      sys,
    });

    try {
      rig.run(1);
      expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(1 << 19);
      expect(rig.state('r1')).toBe(0);
      expect(rig.state('pc')).toBe(0); // faulting PC, not the sequential successor
    } finally {
      rig.dispose();
    }
  });

  it('does not write FPSCR or raise NOCP when IT makes VMSR conditional-false', async () => {
    const code = codeOf([0x08, 0xbf, ...VMSR_R0, ...MOVS_R1_5A]); // it eq; vmsr; movs
    const periph = new Uint8Array(0x1000);

    writeWord(periph, FPU_FPSCR, 0x1234_5678);
    const rig = await createCpuRig({
      code,
      sp: SP,
      states: { r0: 0x0300_0000, apsr: 0 },
      sys: sysWith({ [CPACR]: 0 }),
      conditional: true,
    });

    // createCpuRig applies `sys`; use the periph image via the same instance below.
    try {
      rig.memories.get('periph')!.set(periph);
      rig.run(1); // it eq
      rig.run(1); // condition false: vmsr skipped
      rig.run(1); // sentinel
      expect(fpscrOf(rig)).toBe(0x1234_5678);
      expect(fpcaOf(rig)).toBe(false);
      expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(0);
      expect(rig.faults).toEqual([]);
      expect(rig.state('r1')).toBe(0x5a);
    } finally {
      rig.dispose();
    }
  });

  it('writes FPSCR and sets FPCA when IT makes VMSR conditional-true', async () => {
    const code = codeOf([0x08, 0xbf, ...VMSR_R0, ...MOVS_R1_5A]); // it eq; vmsr; movs
    const rig = await createCpuRig({
      code,
      sp: SP,
      states: { r0: 0x0300_0000, apsr: 0x4000_0000 },
      sys: sysWith({ [CPACR]: 0x00f0_0000 }),
      conditional: true,
    });

    try {
      rig.run(1);
      rig.run(1);
      rig.run(1);
      expect(fpscrOf(rig)).toBe(0x0300_0000);
      expect(fpcaOf(rig)).toBe(true);
      expect(rig.faults).toEqual([]);
      expect(rig.state('r1')).toBe(0x5a);
    } finally {
      rig.dispose();
    }
  });

  it('raises NOCP without activating FPCA when IT-true VMSR hits CPACR=0', async () => {
    const code = codeOf([0x08, 0xbf, ...VMSR_R0, ...MOVS_R1_5A]); // it eq; vmsr; movs
    const rig = await createCpuRig({
      code,
      sp: SP,
      states: { r0: 0x0300_0000, apsr: 0x4000_0000 },
      sys: sysWith({ [CPACR]: 0 }),
      conditional: true,
    });

    try {
      rig.run(1);
      rig.run(1);
      expect(fpscrOf(rig)).toBe(0);
      expect(fpcaOf(rig)).toBe(false);
      expect(readWord(rig.memories.get('sys')!, CFSR) & (1 << 19)).toBe(1 << 19);
      expect(rig.state('r1')).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});

describe('FP exception context boundary', () => {
  it('halts before any stack write when SVC entry sees FPCA=1', async () => {
    const code = codeOf([...VMSR_R0, 0x00, 0xdf, ...MOVS_R1_5A]); // vmsr; svc #0; movs
    const sram = new Uint8Array(0x2000).fill(0xa5);
    const rig = await createCpuRig({
      code,
      sp: SP,
      states: { r0: 0x0300_0000 },
      sys: sysWith({ [CPACR]: 0x00f0_0000 }),
      sram,
    });

    try {
      const before = Array.from(rig.memories.get('sram')!);

      rig.run(1);
      expect(fpcaOf(rig)).toBe(true);
      const sp = rig.state('sp');

      rig.run(1); // svc
      expect(rig.faults).toEqual([(6 << 8) | FP_CONTEXT_UNSUPPORTED]);
      expect(rig.state('pc')).toBe(6); // exception boundary returnPc, not the SVC opcode
      expect(rig.state('sp')).toBe(sp);
      expect(Array.from(rig.memories.get('sram')!)).toEqual(before); // no frame bytes anywhere
      expect(rig.state('r1')).toBe(0);
      expect(fpscrOf(rig)).toBe(0x0300_0000);
      expect(readWord(rig.memories.get('sys')!, H_MODE)).toBe(0);
      expect(readWord(rig.memories.get('sys')!, H_DEPTH)).toBe(0);
      expect(ipsrOf(rig)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('halts before unstacking an extended EXC_RETURN when no FP hooks exist', async () => {
    const rig = await createCpuRig({
      code: codeOf([0x70, 0x47, ...MOVS_R1_5A]), // bx lr
      sp: SP,
      states: { r0: 0x1234_5678, lr: 0xffff_ffe9 },
    });

    try {
      rig.run(1);
      expect(rig.faults).toEqual([FP_CONTEXT_UNSUPPORTED]);
      expect(rig.state('pc')).toBe(0); // current return instruction, not an unstacked PC
      expect(rig.state('sp')).toBe(SP);
      expect(rig.state('r0')).toBe(0x1234_5678);
      expect(rig.state('r1')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('clears FPCA on a basic exception return', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.vector(11, 'svc');
    t.mark('start');
    address(0, 0xe000_ed88);
    address(1, 0x00f0_0000);
    t.strWord(1, 0, 0);
    t.svc(0);
    address(2, 0x2000_0000);
    t.movs(3, 0x77);
    t.strWord(3, 2, 0);
    t.spin();

    t.mark('svc');
    address(0, 0x0200_0000);
    t.dword(0xeee1, 0x0a10); // VMSR sets FPCA=1 in the basic-frame handler
    t.bx(14);

    const view = await runMcu({ firmware: t.build(), durationPs: 50_000_000 });

    try {
      expect(view.u32(0)).toBe(0x77);
      expect(readWord(view.memory('periph'), FPU_FPSCR)).toBe(0x0200_0000);
      expect(readWord(view.memory('sys'), H_CONTROL) & 4).toBe(0);
    } finally {
      view.dispose();
    }
  });
});

describe('VMSR through the production MCU adapter', () => {
  it('enables CPACR, writes FPSCR, and reaches a firmware sentinel', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.mark('start');
    address(0, 0xe000_ed88); // CPACR
    address(1, 0x00f0_0000); // CP10/CP11 full
    t.strWord(1, 0, 0);
    t.dword(0xf3bf, 0x8f4f); // dsb
    t.dword(0xf3bf, 0x8f6f); // isb
    t.dword(0xf04f, 0x7040); // mov.w r0, #0x03000000
    t.dword(0xeee1, 0x0a10); // vmsr fpscr, r0
    address(2, 0x2000_0000);
    t.movs(3, 0x5a);
    t.strWord(3, 2, 0);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 20_000_000 });

    try {
      expect(view.faults).toEqual([]);
      expect(view.u32(0)).toBe(0x5a);
      expect(readWord(view.memory('periph'), FPU_FPSCR)).toBe(0x0300_0000);
      expect(readWord(view.memory('sys'), H_CONTROL) & 4).toBe(4);
    } finally {
      view.dispose();
    }
  });

  it('escalates NOCP to HardFault when USGFAULTENA is clear', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.vector(3, 'hardfault');
    t.mark('start');
    t.dword(0xf04f, 0x7040); // mov.w r0, #0x03000000; CPACR stays 0
    t.dword(0xeee1, 0x0a10); // vmsr fpscr, r0 -> NOCP -> HardFault
    address(2, 0x2000_0000);
    t.movs(3, 0x11);
    t.strWord(3, 2, 0);
    t.spin();

    t.mark('hardfault');
    address(0, 0xe000_ed28); // CFSR
    t.ldrWord(1, 0, 0);
    address(2, 0x2000_0000);
    t.strWord(1, 2, 8);
    t.movs(3, 0x44);
    t.strWord(3, 2, 0xc);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 50_000_000 });

    try {
      expect(view.u32(0)).toBe(0);
      expect(view.u32(0x8) & (1 << 19)).toBe(1 << 19);
      expect(view.u32(0xc)).toBe(0x44);
      expect(readWord(view.memory('sys'), SCB_STATE + 0x2c) & (1 << 30)).toBe(1 << 30);
    } finally {
      view.dispose();
    }
  });

  it('halts before stack for a service-dispatched NMI when FPCA=1', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.mark('start');
    address(0, 0xe000_ed88);
    address(1, 0x00f0_0000);
    t.strWord(1, 0, 0);
    t.dword(0xf04f, 0x7040); // mov.w r0, #0x03000000
    t.dword(0xeee1, 0x0a10); // FPCA=1
    address(0, 0xe000_ed04); // ICSR
    address(1, 0x8000_0000); // NMIPENDSET
    t.strWord(1, 0, 0);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 50_000_000 });

    try {
      expect(
        view.faults.map(Number).some((value) => (value & 0xff) === FP_CONTEXT_UNSUPPORTED),
      ).toBe(true);
      expect(view.state('halted')).toBe(true);
      expect(view.state('sp')).toBe(0x2000_5800);
      expect(readWord(view.memory('sys'), H_MODE)).toBe(0);
      expect(readWord(view.memory('sys'), H_DEPTH)).toBe(0);
    } finally {
      view.dispose();
    }
  });

  it('restores FPCCR reset, clears FPSCR, and clears FPCA across SYSRESETREQ', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.mark('start');
    address(2, 0x2000_0000);
    t.ldrWord(4, 2, 0x10);
    t.cmp(4, 1);
    t.bcond(0, 'after'); // marker set: second boot

    address(0, 0xe000_ed88);
    address(1, 0x00f0_0000);
    t.strWord(1, 0, 0);
    t.dword(0xf04f, 0x7040); // mov.w r0, #0x03000000
    t.dword(0xeee1, 0x0a10); // VMSR, FPCA=1
    t.movs(3, 1);
    t.strWord(3, 2, 0x10); // SRAM marker survives reset
    address(0, 0xe000_ed0c); // AIRCR
    address(1, 0x05fa_0004); // SYSRESETREQ
    t.strWord(1, 0, 0);
    t.spin();

    t.mark('after');
    address(0, 0xe000_ef34);
    t.ldrWord(1, 0, 0);
    t.strWord(1, 2, 0);
    t.mrs(1, 20); // CONTROL
    t.strWord(1, 2, 4);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 100_000_000 });

    try {
      expect(view.u32(0)).toBe(FPCCR_RESET);
      expect(view.u32(4) & 4).toBe(0);
      expect(readWord(view.memory('periph'), FPU_FPSCR)).toBe(0);
    } finally {
      view.dispose();
    }
  });

  it('takes a precise UsageFault NOCP and lets a privileged handler execute VMSR', async () => {
    const t = new SystemThumb();
    const address = (register: number, value: number): void => {
      t.movw(register, value & 0xffff).movt(register, value >>> 16);
    };

    t.vector(6, 'usage');
    t.mark('start');
    address(0, 0xe000_ed24); // SHCSR
    address(1, 1 << 16); // USGFAULTENA
    t.strWord(1, 0, 0);
    address(0, 0xe000_ed88); // CPACR
    address(1, 0x0050_0000); // CP10/CP11 = 01, privileged only
    t.strWord(1, 0, 0);
    t.movs(0, 1);
    t.msr(0, 20); // CONTROL.nPRIV = 1
    address(0, 0x0300_0000);
    const faultPc = 0x0800_0500 + t.offset;

    t.dword(0xeee1, 0x0a10); // unprivileged VMSR -> NOCP
    address(2, 0x2000_0000);
    t.movs(3, 0x11);
    t.strWord(3, 2, 0);
    t.spin();

    t.mark('usage');
    t.ldrSp(1, 24); // stacked return PC
    address(2, 0x2000_0000);
    t.strWord(1, 2, 8);
    address(0, 0x0200_0000);
    t.dword(0xeee1, 0x0a10); // handler is privileged; CPACR=01 must allow this
    t.movs(3, 0x33);
    t.strWord(3, 2, 0xc);
    t.spin();

    const view = await runMcu({ firmware: t.build(), durationPs: 50_000_000 });

    try {
      expect(view.u32(0)).toBe(0); // sentinel after faulting VMSR is not reached
      expect(view.u32(8)).toBe(faultPc); // stacked return PC is the VMSR itself
      expect(view.u32(0xc)).toBe(0x33);
      expect(readWord(view.memory('sys'), CFSR) & (1 << 19)).toBe(1 << 19);
      expect(readWord(view.memory('periph'), FPU_FPSCR)).toBe(0x0200_0000);
      expect(readWord(view.memory('sys'), H_CONTROL) & 4).toBe(4);
    } finally {
      view.dispose();
    }
  });
});
