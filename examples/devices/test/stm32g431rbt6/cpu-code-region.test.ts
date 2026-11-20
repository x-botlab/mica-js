import { describe, expect, it } from 'vitest';
import { createCpuRig, codeOf, writeWord } from './cpu-rig';

/**
 * 显式 logical codeBase / region 取指合同。
 *
 * `code` 是 region-local 视图，`pc` 保持 logical；literal 的 actual load 必须用
 * `atAddress(logicalTarget)`，不能用 Flash 的 `atCode`/`0x1ffff` 掩码。
 */
describe('logical code region fetch', () => {
  it('fetches a Flash-alias PC-relative literal from the region-local view', async () => {
    const code = new Uint8Array(0x14);
    code.set([0x03, 0x48]); // ldr r0,[pc,#12] -> logical 0x08000010
    writeWord(code, 0x10, 0x1234_5678);

    const rig = await createCpuRig({
      code,
      codeBase: 0x0800_0000,
      pc: 0x0800_0000,
      sp: 0x2000_1000,
    });

    try {
      rig.run(1);
      expect(rig.state('r0')).toBe(0x1234_5678);
      expect(rig.state('pc')).toBe(0x0800_0002);
    } finally {
      rig.dispose();
    }
  });

  it('loads an SRAM literal through logical atAddress, not the Flash mask', async () => {
    const code = codeOf([0x03, 0x48], 2); // ldr r0,[pc,#12] -> 0x20000010
    const sram = new Uint8Array(0x40);
    writeWord(sram, 0x10, 0x2000_00aa);

    const rig = await createCpuRig({
      code,
      codeBase: 0x2000_0000,
      pc: 0x2000_0000,
      sp: 0x2000_1000,
      sram,
    });

    try {
      rig.run(1);
      expect(rig.state('r0')).toBe(0x2000_00aa);
    } finally {
      rig.dispose();
    }
  });

  it('loads a CCM literal through logical atAddress', async () => {
    const code = codeOf([0x03, 0x48], 2); // ldr r0,[pc,#12] -> 0x10000010
    const ccm = new Uint8Array(0x40);
    writeWord(ccm, 0x10, 0x1000_00bb);

    const rig = await createCpuRig({
      code,
      codeBase: 0x1000_0000,
      pc: 0x1000_0000,
      sp: 0x2000_1000,
      ccm,
    });

    try {
      rig.run(1);
      expect(rig.state('r0')).toBe(0x1000_00bb);
    } finally {
      rig.dispose();
    }
  });

  it('keeps branch and BL/BX targets logical in an SRAM region', async () => {
    const flashBranch = await createCpuRig({
      code: codeOf([0x02, 0xe0]), // b +8
      codeBase: 0x0800_0000,
      pc: 0x0800_0000,
      sp: 0x2000_1000,
    });

    try {
      flashBranch.run(1);
      expect(flashBranch.state('pc')).toBe(0x0800_0008);
    } finally {
      flashBranch.dispose();
    }

    const branch = await createCpuRig({
      code: codeOf([0x02, 0xe0]), // b +8
      codeBase: 0x2000_0000,
      pc: 0x2000_0000,
      sp: 0x2000_1000,
    });

    try {
      branch.run(1);
      expect(branch.state('pc')).toBe(0x2000_0008);
    } finally {
      branch.dispose();
    }

    const link = await createCpuRig({
      code: codeOf([
        0x00, 0xf0, 0x02, 0xf8, // bl 0x20000008
        0x01, 0x20, // movs r0,#1
        0x00, 0xe0, // b 0x2000000a
        0x70, 0x47, // bx lr
      ]),
      codeBase: 0x2000_0000,
      pc: 0x2000_0000,
      sp: 0x2000_1000,
    });

    try {
      link.run(1);
      expect(link.state('pc')).toBe(0x2000_0008);
      expect(((link.state('lr') as number) >>> 0) & 0x1).toBe(1);
      expect(((link.state('lr') as number) >>> 0) & ~1).toBe(0x2000_0004);

      link.run(1); // bx lr
      expect(link.state('pc')).toBe(0x2000_0004);

      link.run(1); // movs r0,#1
      expect(link.state('r0')).toBe(1);
    } finally {
      link.dispose();
    }
  });
});
