import { describe, expect, it } from 'vitest';
import { createCpuRig, codeOf } from './cpu-rig';

const SP = 0x2000_1000;
const Q = 0x0800_0000;
const GE = 0x000f_0000;

async function run(
  bytes: readonly number[],
  states: Readonly<Record<string, number | boolean>>,
): Promise<{ r0: number; r1: number; apsr: number; rig: Awaited<ReturnType<typeof createCpuRig>> }> {
  const rig = await createCpuRig({ code: codeOf(bytes), sp: SP, states });

  rig.run(1);

  return {
    r0: rig.state('r0') as number,
    r1: rig.state('r1') as number,
    apsr: rig.state('apsr') as number,
    rig,
  };
}

describe('Cortex-M4 DSP / SIMD', () => {
  it('SSAT/USAT 饱和到指定位数，Q 置位且粘滞', async () => {
    const sat = await run([0x01, 0xf3, 0x07, 0x00], { r1: 0x100 });

    try {
      expect(sat.r0).toBe(127);
      expect(sat.apsr & Q).toBe(Q); // 饱和
    } finally {
      sat.rig.dispose();
    }

    const negative = await run([0x01, 0xf3, 0x07, 0x00], { r1: 0xffff_ff38 });

    try {
      expect(negative.r0).toBe(0xffff_ff80); // -128
      expect(negative.apsr & Q).toBe(Q);
    } finally {
      negative.rig.dispose();
    }

    const unsigned = await run([0x81, 0xf3, 0x08, 0x00], { r1: 0xffff_ffff });

    try {
      expect(unsigned.r0).toBe(0);
      expect(unsigned.apsr & Q).toBe(Q);
    } finally {
      unsigned.rig.dispose();
    }

    const noSaturation = await run([0x01, 0xf3, 0x07, 0x00], { r1: 50, apsr: Q });

    try {
      expect(noSaturation.r0).toBe(50);
      expect(noSaturation.apsr & Q).toBe(Q); // Q 粘滞：不饱和也不清
    } finally {
      noSaturation.rig.dispose();
    }
  });

  it('SSAT16/USAT16 按半字饱和，lsl 移位先于饱和', async () => {
    const pair = await run([0x21, 0xf3, 0x07, 0x00], { r1: 0x7fff_7fff });

    try {
      expect(pair.r0).toBe(0x007f_007f);
      expect(pair.apsr & Q).toBe(Q);
    } finally {
      pair.rig.dispose();
    }

    const shifted = await run([0x01, 0xf3, 0x87, 0x00], { r1: 0x0000_0100 });

    try {
      // 0x100 << 2 = 0x400，仍小于 SSAT #8 的 127? 不：0x400 > 127，饱和。
      expect(shifted.r0).toBe(127);
      expect(shifted.apsr & Q).toBe(Q);
    } finally {
      shifted.rig.dispose();
    }

    const unsigned = await run([0xa1, 0xf3, 0x08, 0x00], { r1: 0x0100_0100 });

    try {
      expect(unsigned.r0).toBe(0x00ff_00ff);
      expect(unsigned.apsr & Q).toBe(Q);
    } finally {
      unsigned.rig.dispose();
    }

    const highRegister = await run([0x20, 0xf3, 0x07, 0x08], { r0: 0x7fff_7fff });

    try {
      expect(highRegister.rig.state('r8')).toBe(0x007f_007f);
      expect(highRegister.rig.state('r0')).toBe(0x7fff_7fff);
    } finally {
      highRegister.rig.dispose();
    }
  });

  it('QADD/QSUB/QDADD 使用 32 位有符号饱和并置 Q', async () => {
    const add = await run([0x82, 0xfa, 0x81, 0xf0], { r1: 0x7fff_ffff, r2: 1 });

    try {
      expect(add.r0).toBe(0x7fff_ffff);
      expect(add.apsr & Q).toBe(Q);
    } finally {
      add.rig.dispose();
    }

    const sub = await run([0x82, 0xfa, 0xa1, 0xf0], { r1: 0x8000_0000, r2: 1 });

    try {
      expect(sub.r0).toBe(0x8000_0000);
      expect(sub.apsr & Q).toBe(Q);
    } finally {
      sub.rig.dispose();
    }

    const noOverflowSub = await run([0x82, 0xfa, 0xa1, 0xf0], {
      r1: 0xffff_ffff,
      r2: 0x8000_0000,
    });

    try {
      expect(noOverflowSub.r0).toBe(0x7fff_ffff);
      expect(noOverflowSub.apsr & Q).toBe(0);
    } finally {
      noOverflowSub.rig.dispose();
    }

    const positiveSub = await run([0x82, 0xfa, 0xa1, 0xf0], {
      r1: 0,
      r2: 0x8000_0000,
    });

    try {
      expect(positiveSub.r0).toBe(0x7fff_ffff);
      expect(positiveSub.apsr & Q).toBe(Q);
    } finally {
      positiveSub.rig.dispose();
    }

    const doubleAdd = await run([0x82, 0xfa, 0x91, 0xf0], { r1: 0x7fff_ffff, r2: 1 });

    try {
      expect(doubleAdd.r0).toBe(0x7fff_ffff);
      expect(doubleAdd.apsr & Q).toBe(Q);
    } finally {
      doubleAdd.rig.dispose();
    }
  });

  it('并行加减写 GE，SEL 按 GE 逐字节选择', async () => {
    const add = await run([0x91, 0xfa, 0x02, 0xf0], { r1: 0x0001_0002, r2: 0x0002_0003 });

    try {
      expect(add.r0).toBe(0x0003_0005);
      expect(add.apsr & GE).toBe(GE); // 两个半字结果都非负
    } finally {
      add.rig.dispose();
    }

    const asx = await run([0xa1, 0xfa, 0x02, 0xf0], { r1: 0x0001_0002, r2: 0x0003_0004 });

    try {
      // low = 2 - 3 = -1，high = 1 + 4 = 5。
      expect(asx.r0).toBe(0x0005_ffff);
      expect(asx.apsr & GE).toBe(0x000c_0000);
    } finally {
      asx.rig.dispose();
    }

    const carry = await run([0x81, 0xfa, 0x42, 0xf0], { r1: 0x0000_00ff, r2: 0x0000_0001 });

    try {
      expect(carry.r0).toBe(0);
      expect(carry.apsr & GE).toBe(0x0001_0000); // 只有 byte0 有进位
    } finally {
      carry.rig.dispose();
    }

    const borrow = await run([0xc1, 0xfa, 0x42, 0xf0], { r1: 1, r2: 2 });

    try {
      expect(borrow.r0).toBe(0x0000_00ff);
      expect(borrow.apsr & GE).toBe(0x000e_0000); // byte0 借位，其余无借位
    } finally {
      borrow.rig.dispose();
    }

    const sel = await run([0xa1, 0xfa, 0x82, 0xf0], {
      r1: 0x1122_3344,
      r2: 0x5566_7788,
      apsr: 0x0100_0000 | 0x0005_0000,
    });

    try {
      expect(sel.r0).toBe(0x5522_7744);
    } finally {
      sel.rig.dispose();
    }
  });

  it('UQADD8 / SHADD16 饱和与半字减半，不覆盖 GE', async () => {
    const uq = await run([0x81, 0xfa, 0x52, 0xf0], { r1: 0x0000_00ff, r2: 0x0000_0002 });

    try {
      expect(uq.r0).toBe(0x0000_00ff);
      expect(uq.apsr & Q).toBe(0); // QADD16/UQADD16 不影响 Q
    } finally {
      uq.rig.dispose();
    }

    const sh = await run([0x91, 0xfa, 0x22, 0xf0], { r1: 0x0001_0002, r2: 0x0003_0002 });

    try {
      expect(sh.r0).toBe(0x0002_0002);
      expect(sh.apsr & Q).toBe(0);
    } finally {
      sh.rig.dispose();
    }
  });

  it('16×16 乘加与 32×32 高低位乘法', async () => {
    const smul = await run([0x11, 0xfb, 0x02, 0xf0], {
      r1: 0x0001_ffff,
      r2: 0x0002_0003,
    });

    try {
      expect(smul.r0).toBe(0xffff_fffd); // -1 * 3
    } finally {
      smul.rig.dispose();
    }

    const smlabb = await run([0x11, 0xfb, 0x02, 0x30], {
      r1: 0x0001_ffff,
      r2: 0x0002_0003,
      r3: 5,
    });

    try {
      expect(smlabb.r0).toBe(2); // -3 + 5
    } finally {
      smlabb.rig.dispose();
    }

    const smlad = await run([0x21, 0xfb, 0x02, 0x30], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
      r3: 5,
    });

    try {
      expect(smlad.r0).toBe(16); // 2*4 + 1*3 + 5
    } finally {
      smlad.rig.dispose();
    }

    const smusd = await run([0x41, 0xfb, 0x02, 0xf0], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
    });

    try {
      expect(smusd.r0).toBe(5); // 2*4 - 1*3
    } finally {
      smusd.rig.dispose();
    }

    const smmul = await run([0x51, 0xfb, 0x02, 0xf0], {
      r1: 0x0001_0000,
      r2: 0x0002_0000,
    });

    try {
      expect(smmul.r0).toBe(2); // (2^16 * 2^17) >> 32
    } finally {
      smmul.rig.dispose();
    }

    const smmla = await run([0x51, 0xfb, 0x02, 0x30], {
      r1: 0x0001_0000,
      r2: 0x0002_0000,
      r3: 5,
    });

    try {
      expect(smmla.r0).toBe(7);
    } finally {
      smmla.rig.dispose();
    }

    const smmls = await run([0x61, 0xfb, 0x02, 0x30], {
      r1: 0x0001_0000,
      r2: 0x0002_0000,
      r3: 5,
    });

    try {
      expect(smmls.r0).toBe(3);
    } finally {
      smmls.rig.dispose();
    }

    const negative = await run([0x51, 0xfb, 0x02, 0xf0], {
      r1: 0xffff_ffff,
      r2: 3,
    });

    try {
      expect(negative.r0).toBe(0xffff_ffff);
    } finally {
      negative.rig.dispose();
    }

    const rounded = await run([0x51, 0xfb, 0x12, 0xf0], {
      r1: 1,
      r2: 0x8000_0000,
    });

    try {
      // 乘积低 32 位是 0x80000000，加 0x80000000 进位到高字，高字从 -1 变 0。
      expect(rounded.r0).toBe(0);
    } finally {
      rounded.rig.dispose();
    }

    const accumulateNegative = await run([0x51, 0xfb, 0x02, 0x30], {
      r1: 0xffff_ffff,
      r2: 3,
      r3: 5,
    });

    try {
      expect(accumulateNegative.r0).toBe(4);
    } finally {
      accumulateNegative.rig.dispose();
    }

    const subtractNegative = await run([0x61, 0xfb, 0x02, 0x30], {
      r1: 0xffff_ffff,
      r2: 3,
      r3: 5,
    });

    try {
      expect(subtractNegative.r0).toBe(6);
    } finally {
      subtractNegative.rig.dispose();
    }

    const smlaOverflow = await run([0x11, 0xfb, 0x02, 0x30], {
      r1: 0x0000_7fff,
      r2: 0x0000_7fff,
      r3: 0x7fff_ffff,
    });

    try {
      expect(smlaOverflow.r0).toBe(0xbfff_0000);
      expect(smlaOverflow.apsr & Q).toBe(Q);
    } finally {
      smlaOverflow.rig.dispose();
    }

    const smlawOverflow = await run([0x31, 0xfb, 0x02, 0x30], {
      r1: 0x7fff_0000,
      r2: 4,
      r3: 0x7fff_ffff,
    });

    try {
      expect(smlawOverflow.r0).toBe(0x8001_fffb);
      expect(smlawOverflow.apsr & Q).toBe(Q);
    } finally {
      smlawOverflow.rig.dispose();
    }

    const smladOverflow = await run([0x21, 0xfb, 0x02, 0x30], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
      r3: 0x7fff_ffff,
    });

    try {
      expect(smladOverflow.r0).toBe(0x8000_000a);
      expect(smladOverflow.apsr & Q).toBe(Q);
    } finally {
      smladOverflow.rig.dispose();
    }

    const smuadNoOverflow = await run([0x21, 0xfb, 0x02, 0xf0], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
    });

    try {
      expect(smuadNoOverflow.apsr & Q).toBe(0);
    } finally {
      smuadNoOverflow.rig.dispose();
    }
  });

  it('SMLAL/SMLALD 写 64 位 RdLo:RdHi', async () => {
    const smlal = await run([0xc2, 0xfb, 0x83, 0x01], {
      r0: 1,
      r1: 0,
      r2: 0x0000_ffff, // -1 低半字
      r3: 0x0000_0002,
    });

    try {
      expect(smlal.r0).toBe(0xffff_ffff);
      expect(smlal.r1).toBe(0xffff_ffff);
    } finally {
      smlal.rig.dispose();
    }

    const smlald = await run([0xc2, 0xfb, 0xc3, 0x01], {
      r0: 1,
      r1: 0,
      r2: 0x0001_0002,
      r3: 0x0003_0004,
    });

    try {
      expect(smlald.r0).toBe(12); // 1 + 2*4 + 1*3
      expect(smlald.r1).toBe(0);
    } finally {
      smlald.rig.dispose();
    }
  });

  it('USAD8/USADA8 求字节绝对差之和', async () => {
    const usad = await run([0x71, 0xfb, 0x02, 0xf0], {
      r1: 0x0403_0201,
      r2: 0x0102_0304,
    });

    try {
      expect(usad.r0).toBe(8);
    } finally {
      usad.rig.dispose();
    }

    const usada = await run([0x71, 0xfb, 0x02, 0x30], {
      r1: 0x0403_0201,
      r2: 0x0102_0304,
      r3: 5,
    });

    try {
      expect(usada.r0).toBe(13);
    } finally {
      usada.rig.dispose();
    }
  });

  it('PKHBT/PKHTB 与 SXT/UXT 系列', async () => {
    const pkhbt = await run([0xc1, 0xea, 0x02, 0x20], {
      r1: 0x1122_3344,
      r2: 0x5566_7788,
    });

    try {
      expect(pkhbt.r0).toBe(0x6677_3344);
    } finally {
      pkhbt.rig.dispose();
    }

    const pkhtb = await run([0xc1, 0xea, 0x22, 0x20], {
      r1: 0x1122_3344,
      r2: 0x5566_7788,
    });

    try {
      expect(pkhtb.r0).toBe(0x1122_6677);
    } finally {
      pkhtb.rig.dispose();
    }

    const sxtb16 = await run([0x2f, 0xfa, 0x81, 0xf0], { r1: 0x0000_0180 });

    try {
      expect(sxtb16.r0).toBe(0x0000_ff80);
    } finally {
      sxtb16.rig.dispose();
    }

    const uxtb16 = await run([0x3f, 0xfa, 0x81, 0xf0], { r1: 0x0000_0180 });

    try {
      expect(uxtb16.r0).toBe(0x0000_0080);
    } finally {
      uxtb16.rig.dispose();
    }

    const sxtab16 = await run([0x21, 0xfa, 0x82, 0xf0], {
      r1: 0x0001_0001,
      r2: 0x0000_0180,
    });

    try {
      expect(sxtab16.r0).toBe(0x0001_ff81);
    } finally {
      sxtab16.rig.dispose();
    }

    const sxtb = await run([0x4f, 0xfa, 0x81, 0xf0], { r1: 0x0000_0080 });

    try {
      expect(sxtb.r0).toBe(0xffff_ff80);
    } finally {
      sxtb.rig.dispose();
    }

    const sxth = await run([0x0f, 0xfa, 0x81, 0xf0], { r1: 0x0000_8000 });

    try {
      expect(sxth.r0).toBe(0xffff_8000);
    } finally {
      sxth.rig.dispose();
    }

    const uxth = await run([0x1f, 0xfa, 0x81, 0xf0], { r1: 0x0000_8000 });

    try {
      expect(uxth.r0).toBe(0x0000_8000);
    } finally {
      uxth.rig.dispose();
    }
  });

  it('IT 条件对 DSP 指令生效，跳过时不写目标', async () => {
    const taken = await createCpuRig({
      code: codeOf([0x82, 0xfa, 0x81, 0xf0]),
      sp: SP,
      conditional: true,
      states: { r1: 1, r2: 2, itState: 0x08, apsr: 0x4100_0000 },
    });

    try {
      taken.run(1);
      expect(taken.state('r0')).toBe(3);
    } finally {
      taken.dispose();
    }

    const skipped = await createCpuRig({
      code: codeOf([0x82, 0xfa, 0x81, 0xf0]),
      sp: SP,
      conditional: true,
      states: { r0: 0x1111_1111, r1: 1, r2: 2, itState: 0x08, apsr: 0x0100_0000 },
    });

    try {
      skipped.run(1);
      expect(skipped.state('r0')).toBe(0x1111_1111);
    } finally {
      skipped.dispose();
    }
  });

  it('SMULW/SMLAW、SMUAD/SMLADX、SMUSDX、SMLALDx 与 QSUB/QDSUB/SSAX', async () => {
    const smulwb = await run([0x31, 0xfb, 0x02, 0xf0], { r1: 0x0001_0000, r2: 3 });

    try {
      expect(smulwb.r0).toBe(3);
    } finally {
      smulwb.rig.dispose();
    }

    const smulwt = await run([0x31, 0xfb, 0x12, 0xf0], { r1: 0x0001_0000, r2: 0x0003_0000 });

    try {
      expect(smulwt.r0).toBe(3);
    } finally {
      smulwt.rig.dispose();
    }

    const smlawb = await run([0x31, 0xfb, 0x02, 0x30], {
      r1: 0x0001_0000,
      r2: 3,
      r3: 5,
    });

    try {
      expect(smlawb.r0).toBe(8);
    } finally {
      smlawb.rig.dispose();
    }

    const smuad = await run([0x21, 0xfb, 0x02, 0xf0], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
    });

    try {
      expect(smuad.r0).toBe(11);
    } finally {
      smuad.rig.dispose();
    }

    const smladx = await run([0x21, 0xfb, 0x12, 0x30], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
      r3: 5,
    });

    try {
      expect(smladx.r0).toBe(15);
    } finally {
      smladx.rig.dispose();
    }

    const smusdx = await run([0x41, 0xfb, 0x12, 0xf0], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
    });

    try {
      expect(smusdx.r0).toBe(2);
    } finally {
      smusdx.rig.dispose();
    }

    const smlaldx = await run([0xc2, 0xfb, 0xd3, 0x01], {
      r0: 1,
      r1: 0,
      r2: 0x0001_0002,
      r3: 0x0003_0004,
    });

    try {
      expect(smlaldx.r0).toBe(11);
      expect(smlaldx.r1).toBe(0);
    } finally {
      smlaldx.rig.dispose();
    }

    const qsub = await run([0x82, 0xfa, 0xa1, 0xf0], { r1: 0x8000_0000, r2: 1 });

    try {
      expect(qsub.r0).toBe(0x8000_0000);
      expect(qsub.apsr & Q).toBe(Q);
    } finally {
      qsub.rig.dispose();
    }

    const qdsub = await run([0x82, 0xfa, 0xb1, 0xf0], { r1: 0x8000_0000, r2: 1 });

    try {
      expect(qdsub.r0).toBe(0x8000_0000);
      expect(qdsub.apsr & Q).toBe(Q);
    } finally {
      qdsub.rig.dispose();
    }

    const ssax = await run([0xe1, 0xfa, 0x02, 0xf0], { r1: 0x0001_0002, r2: 0x0003_0004 });

    try {
      expect(ssax.r0).toBe(0xfffd_0005);
      expect(ssax.apsr & GE).toBe(0x0003_0000);
    } finally {
      ssax.rig.dispose();
    }
  });

  it('QADD16/UQSUB16 按半字饱和，SXTAH/UXTAH 按半字扩展后相加', async () => {
    const qadd16 = await run([0x91, 0xfa, 0x12, 0xf0], {
      r1: 0x7fff_0001,
      r2: 0x0001_0001,
    });

    try {
      expect(qadd16.r0).toBe(0x7fff_0002);
      expect(qadd16.apsr & Q).toBe(0); // 并行饱和指令不改 Q
    } finally {
      qadd16.rig.dispose();
    }

    const uqsub16 = await run([0xd1, 0xfa, 0x52, 0xf0], {
      r1: 0x0001_0002,
      r2: 0x0003_0004,
    });

    try {
      expect(uqsub16.r0).toBe(0);
      expect(uqsub16.apsr & Q).toBe(0);
    } finally {
      uqsub16.rig.dispose();
    }

    const sxtah = await run([0x01, 0xfa, 0x82, 0xf0], {
      r1: 0x0001_0001,
      r2: 0x0000_8000,
    });

    try {
      expect(sxtah.r0).toBe(0x0000_8001);
    } finally {
      sxtah.rig.dispose();
    }

    const uxtah = await run([0x11, 0xfa, 0x82, 0xf0], {
      r1: 0x0001_0001,
      r2: 0x0000_8000,
    });

    try {
      expect(uxtah.r0).toBe(0x0001_8001);
    } finally {
      uxtah.rig.dispose();
    }
  });

  it('CLREX 是已识别 no-op，TBB/TBH 跳转到表项', async () => {
    const clrex = await createCpuRig({
      code: codeOf([0xbf, 0xf3, 0x2f, 0x8f, 0x01, 0x20]),
      sp: SP,
    });

    try {
      clrex.run(1);
      expect(clrex.state('pc')).toBe(4);
      expect(clrex.faults).toEqual([]);
    } finally {
      clrex.dispose();
    }

    const table = new Uint8Array(0x2000);
    table[2] = 3; // byte 表项：target = pc + 4 + 2*3 = 10
    const tbb = await createCpuRig({
      code: codeOf([
        0xd0, 0xe8, 0x01, 0xf0, // tbb [r0, r1]
        0x00, 0xbf,
        0x01, 0x20, // movs r2,#1 @6
        0x02, 0x22, // movs r2,#2 @8
        0x03, 0x22, // movs r2,#3 @10
      ]),
      sp: SP,
      states: { r0: 0x2000_0000, r1: 2 },
      sram: table,
      knownRegs: (() => {
        const registers = Array<number | undefined>(16).fill(undefined);

        registers[0] = 0x2000_0000;
        registers[1] = 2;
        return registers;
      })(),
    });

    try {
      tbb.run(1);
      expect(tbb.state('pc')).toBe(10);
      tbb.run(1);
      expect(tbb.state('r2')).toBe(3);
    } finally {
      tbb.dispose();
    }
  });

  it('普通 ADDS 保留 Q/GE', async () => {
    const add = await run([0x88, 0x18], { r1: 1, r2: 2, apsr: 0x0f00_0000 | 0x000f_0000 });

    try {
      expect(add.r0).toBe(3);
      expect(add.apsr & Q).toBe(Q);
      expect(add.apsr & GE).toBe(GE);
    } finally {
      add.rig.dispose();
    }
  });
});
