import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeVfp32, isVfpEncoding, vfpMnemonic } from '@mica-js/stm32g431rbt6-core/fpu';
import { createFpuRig, codeOf, f32 } from './fpu-rig';

const SP = 0x2000_1000;
const BASE = 0x2000_0010;
/** QEMU MPS2-AN386 + Cortex-M4 参考结果；只取结果位型，不依赖运行时 QEMU。 */
const QEMU = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'fpu-qemu-vectors.json'), 'utf8'),
) as Record<string, { readonly bits: number; readonly fpscr: number }>;
const q = (name: string): number => QEMU[name]!.bits;
const VADD = [0x30, 0xee, 0x20, 0x1a] as const;
const VSUB = [0x30, 0xee, 0x60, 0x1a] as const;
const VMUL = [0x20, 0xee, 0x20, 0x1a] as const;
const VDIV = [0x80, 0xee, 0x20, 0x1a] as const;
const VSQRT = [0xb1, 0xee, 0xc0, 0x1a] as const;

const FPSCR_RP = 1 << 22;
const FPSCR_RM = 2 << 22;
const FPSCR_RZ = 3 << 22;
const FPSCR_FZ = 1 << 24;
const FPSCR_DN = 1 << 25;

async function execute(
  bytes: readonly number[],
  options: {
    readonly sRegisters?: Readonly<Record<number, number>>;
    readonly fpscr?: number;
    readonly states?: Readonly<Record<string, number | boolean>>;
    readonly sram?: Uint8Array;
    readonly cpacr?: number;
  } = {},
): Promise<Awaited<ReturnType<typeof createFpuRig>>> {
  const rig = await createFpuRig({
    code: codeOf(bytes),
    sp: SP,
    ...options,
  });

  rig.run(1);

  return rig;
}

/** 常用 VFP 编码；用于检查译码覆盖与真实 IR 执行。 */
const VFP_ENCODINGS: readonly { readonly bytes: readonly number[]; readonly name: string }[] = [
  { bytes: [0x90, 0xed, 0x00, 0x0a], name: 'vldr s0, [r0]' },
  { bytes: [0x80, 0xed, 0x01, 0x0a], name: 'vstr s0, [r0, #4]' },
  { bytes: [0xb0, 0xee, 0x60, 0x0a], name: 'vmov s0, s1' },
  { bytes: [0x10, 0xee, 0x10, 0x0a], name: 'vmov r0, s0' },
  { bytes: [0x00, 0xee, 0x10, 0x0a], name: 'vmov s0, r0' },
  { bytes: [0x30, 0xee, 0x81, 0x0a], name: 'vadd.f32 s0, s1, s2' },
  { bytes: [0x30, 0xee, 0xc1, 0x0a], name: 'vsub.f32 s0, s1, s2' },
  { bytes: [0x20, 0xee, 0x81, 0x0a], name: 'vmul.f32 s0, s1, s2' },
  { bytes: [0x80, 0xee, 0x81, 0x0a], name: 'vdiv.f32 s0, s1, s2' },
  { bytes: [0xb4, 0xee, 0x60, 0x0a], name: 'vcmp.f32 s0, s1' },
  { bytes: [0xb8, 0xee, 0xe0, 0x0a], name: 'vcvt.f32.s32 s0, s1' },
  { bytes: [0xf1, 0xee, 0x10, 0x0a], name: 'vmrs r0, fpscr' },
];

const halfwords = (bytes: readonly number[]): readonly [number, number] => [
  (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8),
  (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8),
];

describe('Cortex-M4F VFP 译码', () => {
  it('常用 VFP 编码全部识别为 0xEC00–0xEFFF 空间', () => {
    for (const { bytes } of VFP_ENCODINGS) {
      const [h1, h2] = halfwords(bytes);

      expect(isVfpEncoding(h1, h2), bytes.join(',')).toBe(true);
      expect(vfpMnemonic(h1, h2), bytes.join(',')).toBeDefined();
      expect(decodeVfp32(h1, h2).terminates, bytes.join(',')).not.toBe(true);
    }
  });

  it('未实现的 VFP 编码在 decodeVfp32 中显式终止', () => {
    // 0xEF00 落在 0xEC00–0xEFFF 空间，但不是 FPv4-SP-D16 的已实现编码。
    expect(decodeVfp32(0xef00, 0x0000).terminates).toBe(true);
    // VFMA 是融合乘加，不能以两次 f32 舍入近似，显式 fault。
    expect(decodeVfp32(0xeea0, 0x0a81).terminates).toBe(true);
  });
});

describe('VFP 真实 IR 执行：VMOV 与 f32 加法', () => {
  it('零路径不触发 IR_SCOPE', async () => {
    const code = codeOf([0x30, 0xee, 0x20, 0x1a]);
    const rig = await createFpuRig({
      code,
      sp: 0x2000_1000,
      sRegisters: { 0: 0, 1: 0 },
    });

    try {
      rig.run(1);
      expect(rig.readS(2)).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('预先装好的两个 f32 寄存器相加', async () => {
    const code = codeOf([
      0x30,
      0xee,
      0x20,
      0x1a, // vadd.f32 s2, s0, s1
      0x11,
      0xee,
      0x10,
      0x0a, // vmov r0, s2
    ]);
    const rig = await createFpuRig({
      code,
      sp: 0x2000_1000,
      sRegisters: { 0: f32(1.5), 1: f32(2.25) },
    });

    try {
      rig.run(1);
      expect(rig.readS(2)).toBe(f32(3.75));
      rig.run(1);
      expect(rig.state('r0')).toBe(f32(3.75));
    } finally {
      rig.dispose();
    }
  });

  it('softfloat IR 能被 direct JIT 编译执行', async () => {
    const rig = await createFpuRig({
      code: codeOf([...VADD, 0xfe, 0xe7]),
      sp: SP,
      sRegisters: { 0: f32(1.5), 1: f32(2.25) },
      execution: 'throughput',
    });

    try {
      rig.run(3);
      expect(rig.direct()).toBe(true);
      expect(rig.readS(2)).toBe(q('add'));
    } finally {
      rig.dispose();
    }
  });

  it('VMOV core↔S、VMOV imm，1.5 + 2.25 = 3.75', async () => {
    const code = codeOf([
      0xb7,
      0xee,
      0x08,
      0x0a, // vmov.f32 s0, #1.5
      0xf0,
      0xee,
      0x02,
      0x0a, // vmov.f32 s1, #2.25
      0x30,
      0xee,
      0x20,
      0x1a, // vadd.f32 s2, s0, s1
      0x11,
      0xee,
      0x10,
      0x0a, // vmov r0, s2
    ]);
    const rig = await createFpuRig({ code, sp: 0x2000_1000 });

    try {
      rig.run(1);
      expect(rig.readS(0)).toBe(f32(1.5));
      rig.run(1);
      expect(rig.readS(1)).toBe(f32(2.25));
      rig.run(1);
      expect(rig.readS(2)).toBe(f32(3.75));
      rig.run(1);
      expect(rig.state('r0')).toBe(f32(3.75));
      expect(rig.readFpscr() & 0x1f).toBe(0);
      expect(rig.fpuActive()).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('f32 加减乘除、sqrt 与 FPSCR 标志', async () => {
    const cases: readonly {
      readonly name: string;
      readonly bytes: readonly number[];
      readonly a: number;
      readonly b?: number;
      readonly expected: number;
      readonly flags: number;
    }[] = [
      { name: 'add', bytes: VADD, a: 1.5, b: 2.25, expected: q('add'), flags: 0 },
      { name: 'sub', bytes: VSUB, a: 1.5, b: 2.25, expected: q('sub'), flags: 0 },
      { name: 'mul', bytes: VMUL, a: 1.5, b: 2.25, expected: q('mul'), flags: 0 },
      { name: 'div', bytes: VDIV, a: 1.5, b: 2.25, expected: q('div'), flags: 0x10 },
      { name: 'sqrt2', bytes: VSQRT, a: 2, expected: f32(Math.fround(Math.sqrt(2))), flags: 0x10 },
    ];

    for (const testCase of cases) {
      const rig = await execute(testCase.bytes, {
        sRegisters: {
          0: f32(testCase.a),
          ...(testCase.b === undefined ? {} : { 1: f32(testCase.b) }),
        },
      });

      try {
        expect(rig.readS(2), testCase.name).toBe(testCase.expected);
        expect(rig.readFpscr() & 0x1f, testCase.name).toBe(testCase.flags);
      } finally {
        rig.dispose();
      }
    }
  });

  it('RNE ties-to-even 与 RP/RM/RZ 舍入', async () => {
    const halfUlp = f32(2 ** -24);
    const tie = await execute(VADD, { sRegisters: { 0: f32(1), 1: halfUlp } });
    const oddTie = await execute(VADD, {
      sRegisters: { 0: f32(1), 1: f32(3 * 2 ** -24) },
    });
    const rp = await execute(VADD, {
      sRegisters: { 0: f32(1), 1: halfUlp },
      fpscr: FPSCR_RP,
    });
    const rmNegative = await execute(VADD, {
      sRegisters: { 0: f32(-1), 1: f32(-(2 ** -24)) },
      fpscr: FPSCR_RM,
    });
    const rzNegative = await execute(VADD, {
      sRegisters: { 0: f32(-1), 1: f32(-(3 * 2 ** -24)) },
      fpscr: FPSCR_RZ,
    });

    try {
      expect(tie.readS(2)).toBe(q('tie_rne'));
      expect(tie.readFpscr() & 0x10).toBe(0x10);
      expect(oddTie.readS(2)).toBe(q('tie3_rne'));
      expect(rp.readS(2)).toBe(q('tie_rp'));
      expect(rmNegative.readS(2)).toBe(q('ntie_rm'));
      expect(rzNegative.readS(2)).toBe(0xbf80_0001);
    } finally {
      tie.dispose();
      oddTie.dispose();
      rp.dispose();
      rmNegative.dispose();
      rzNegative.dispose();
    }
  });

  it('±0、NaN、Inf、subnormal 与 FZ/DN', async () => {
    const positiveZeroAdd = await execute(VADD, { sRegisters: { 0: 0, 1: 0x8000_0000 } });
    const negativeZeroAdd = await execute(VADD, {
      sRegisters: { 0: 0x8000_0000, 1: 0x8000_0000 },
    });
    const cancel = await execute(VSUB, { sRegisters: { 0: f32(1), 1: f32(1) } });
    const cancelTiny = await execute(VSUB, {
      sRegisters: { 0: f32(1), 1: 0x3f7f_ffff },
    });
    const cancelRm = await execute(VSUB, {
      sRegisters: { 0: f32(1), 1: f32(1) },
      fpscr: FPSCR_RM,
    });
    const infAdd = await execute(VADD, {
      sRegisters: { 0: 0x7f80_0000, 1: 0x3f80_0000 },
    });
    const infMinusInf = await execute(VADD, {
      sRegisters: { 0: 0x7f80_0000, 1: 0xff80_0000 },
    });
    const nanPropagation = await execute(VADD, {
      sRegisters: { 0: 0x7fc0_0001, 1: 0x3f80_0000 },
    });
    const signalingNan = await execute(VADD, {
      sRegisters: { 0: 0x7f80_0001, 1: 0x3f80_0000 },
    });
    const defaultNan = await execute(VADD, {
      sRegisters: { 0: 0x7f80_0001, 1: 0x3f80_0000 },
      fpscr: FPSCR_DN,
    });
    const subnormalAdd = await execute(VADD, { sRegisters: { 0: 1, 1: 1 } });
    const subnormalFlush = await execute(VADD, {
      sRegisters: { 0: 1, 1: 0 },
      fpscr: FPSCR_FZ,
    });
    const normalInput = await execute(VMUL, {
      sRegisters: { 0: f32(2 ** -126), 1: f32(0.5) },
    });
    const underflowOutput = await execute(VMUL, {
      sRegisters: { 0: f32(2 ** -126), 1: f32(0.5) },
      fpscr: FPSCR_FZ,
    });
    const underflowInexact = await execute(VMUL, {
      sRegisters: { 0: f32(2 ** -126), 1: f32(0.5 + 2 ** -24) },
      fpscr: FPSCR_FZ,
    });
    const zeroTimesInfinity = await execute(VMUL, {
      sRegisters: { 0: 0, 1: 0x7f80_0000 },
    });
    const divideByZero = await execute(VDIV, { sRegisters: { 0: f32(1), 1: 0 } });
    const zeroOverZero = await execute(VDIV, { sRegisters: { 0: 0, 1: 0 } });
    const sqrtNegative = await execute(VSQRT, { sRegisters: { 0: f32(-1) } });
    const sqrtNegativeZero = await execute(VSQRT, { sRegisters: { 0: 0x8000_0000 } });
    const overflow = await execute(VADD, {
      sRegisters: { 0: 0x7f7f_ffff, 1: 0x7f7f_ffff },
    });
    const overflowRz = await execute(VADD, {
      sRegisters: { 0: 0x7f7f_ffff, 1: 0x7f7f_ffff },
      fpscr: FPSCR_RZ,
    });

    try {
      expect(positiveZeroAdd.readS(2)).toBe(0);
      expect(negativeZeroAdd.readS(2)).toBe(0x8000_0000);
      expect(cancel.readS(2)).toBe(0);
      expect(cancelTiny.readS(2)).toBe(f32(2 ** -24));
      expect(cancelRm.readS(2)).toBe(q('cancel_rm'));
      expect(infAdd.readS(2)).toBe(0x7f80_0000);
      expect(infMinusInf.readS(2)).toBe(q('infm'));
      expect(infMinusInf.readFpscr() & 1).toBe(1);
      expect(nanPropagation.readS(2)).toBe(q('qnan'));
      expect(nanPropagation.readFpscr() & 1).toBe(0);
      expect(signalingNan.readS(2)).toBe(q('qnan'));
      expect(signalingNan.readFpscr() & 1).toBe(1);
      expect(defaultNan.readS(2)).toBe(q('qnan_dn'));
      expect(subnormalAdd.readS(2)).toBe(q('subadd'));
      expect(subnormalFlush.readS(2)).toBe(0);
      expect(subnormalFlush.readFpscr() & 0x80).toBe(0x80);
      expect(normalInput.readS(2)).toBe(q('under'));
      expect(underflowOutput.readS(2)).toBe(q('under_fz'));
      expect(underflowOutput.readFpscr() & 0x18).toBe(0x08);
      expect(underflowInexact.readS(2)).toBe(0);
      expect(underflowInexact.readFpscr() & 0x18).toBe(0x18);
      expect(zeroTimesInfinity.readS(2)).toBe(q('zerinf'));
      expect(zeroTimesInfinity.readFpscr() & 1).toBe(1);
      expect(divideByZero.readS(2)).toBe(q('divzero'));
      expect(divideByZero.readFpscr() & 2).toBe(2);
      expect(zeroOverZero.readS(2)).toBe(q('0div0'));
      expect(zeroOverZero.readFpscr() & 1).toBe(1);
      expect(sqrtNegative.readS(2)).toBe(0x7fc0_0000);
      expect(sqrtNegative.readFpscr() & 1).toBe(1);
      expect(sqrtNegativeZero.readS(2)).toBe(0x8000_0000);
      expect(overflow.readS(2)).toBe(q('ovf'));
      expect(overflow.readFpscr() & 0x14).toBe(0x14);
      expect(overflowRz.readS(2)).toBe(q('ovf_rz'));
    } finally {
      for (const rig of [
        positiveZeroAdd,
        negativeZeroAdd,
        cancel,
        cancelTiny,
        cancelRm,
        infAdd,
        infMinusInf,
        nanPropagation,
        signalingNan,
        defaultNan,
        subnormalAdd,
        subnormalFlush,
        normalInput,
        underflowOutput,
        underflowInexact,
        zeroTimesInfinity,
        divideByZero,
        zeroOverZero,
        sqrtNegative,
        sqrtNegativeZero,
        overflow,
        overflowRz,
      ])
        rig.dispose();
    }
  });

  it('VCVT 转换与范围检查', async () => {
    const vcvtToS32 = [0xbd, 0xee, 0x40, 0x1a] as const;
    const vcvtToU32 = [0xbc, 0xee, 0x40, 0x1a] as const;
    const vcvtFromS32 = [0xb8, 0xee, 0xc0, 0x1a] as const;
    const vcvtFromU32 = [0xb8, 0xee, 0x40, 0x1a] as const;

    const truncated = await execute(vcvtToS32, { sRegisters: { 0: f32(1.5) } });
    const rounded = await execute(vcvtToS32, { sRegisters: { 0: f32(2.5) } });
    const roundedRz = await execute(vcvtToS32, {
      sRegisters: { 0: f32(2.5) },
      fpscr: FPSCR_RZ,
    });
    const negative = await execute(vcvtToS32, { sRegisters: { 0: f32(-5) } });
    const tooLarge = await execute(vcvtToS32, { sRegisters: { 0: f32(1e20) } });
    const tooLargeNegative = await execute(vcvtToS32, {
      sRegisters: { 0: f32(-1e20) },
    });
    const tooLargeUnsigned = await execute(vcvtToU32, {
      sRegisters: { 0: f32(4294967296) },
    });
    const unsignedNegative = await execute(vcvtToU32, { sRegisters: { 0: f32(-1) } });
    const unsignedNearZero = await execute(vcvtToU32, { sRegisters: { 0: f32(-0.5) } });
    const signedNearZero = await execute(vcvtToS32, { sRegisters: { 0: f32(-0.5) } });
    const fromSigned = await execute(vcvtFromS32, { sRegisters: { 0: 0xffff_fffb } });
    const fromUnsigned = await execute(vcvtFromU32, { sRegisters: { 0: 0xffff_ffff } });

    try {
      expect(truncated.readS(2)).toBe(q('cvt_s32'));
      expect(rounded.readS(2)).toBe(2);
      expect(roundedRz.readS(2)).toBe(2);
      expect(negative.readS(2)).toBe(0xffff_fffb);
      expect(tooLarge.readS(2)).toBe(q('s32_big'));
      expect(tooLarge.readFpscr() & 1).toBe(1);
      expect(tooLargeNegative.readS(2)).toBe(q('s32_nbig'));
      expect(tooLargeNegative.readFpscr() & 1).toBe(1);
      expect(tooLargeUnsigned.readS(2)).toBe(q('u32_big'));
      expect(tooLargeUnsigned.readFpscr() & 1).toBe(1);
      expect(unsignedNegative.readS(2)).toBe(q('u32_m15'));
      expect(unsignedNegative.readFpscr() & 1).toBe(1);
      expect(unsignedNearZero.readS(2)).toBe(q('u32_m05'));
      expect(unsignedNearZero.readFpscr() & 1).toBe(0);
      expect(unsignedNearZero.readFpscr() & 0x10).toBe(0x10);
      expect(signedNearZero.readS(2)).toBe(q('s32_m05'));
      expect(signedNearZero.readFpscr() & 1).toBe(0);
      expect(signedNearZero.readFpscr() & 0x10).toBe(0x10);
      expect(fromSigned.readS(2)).toBe(0xc0a0_0000);
      expect(fromUnsigned.readS(2)).toBe(0x4f80_0000);
    } finally {
      for (const rig of [
        truncated,
        rounded,
        roundedRz,
        negative,
        tooLarge,
        tooLargeNegative,
        tooLargeUnsigned,
        unsignedNegative,
        unsignedNearZero,
        signedNearZero,
        fromSigned,
        fromUnsigned,
      ])
        rig.dispose();
    }
  });

  it('VCMP/VCMPE 与 VMRS APSR_nzcv', async () => {
    const vcmp = [0xb4, 0xee, 0x60, 0x0a] as const;
    const vcmpe = [0xb4, 0xee, 0xe0, 0x0a] as const;
    const vmrsApsr = [0xf1, 0xee, 0x10, 0xfa] as const;

    const less = await execute(vcmp, { sRegisters: { 0: f32(1), 1: f32(2) } });
    const greater = await execute(vcmp, { sRegisters: { 0: f32(2), 1: f32(1) } });
    const equal = await execute(vcmp, { sRegisters: { 0: f32(1), 1: f32(1) } });
    const unordered = await execute(vcmp, { sRegisters: { 0: 0x7fc0_0000, 1: f32(1) } });
    const unorderedSignal = await execute(vcmpe, {
      sRegisters: { 0: 0x7fc0_0000, 1: f32(1) },
    });
    const negativeGreater = await execute(vcmp, {
      sRegisters: { 0: f32(-1), 1: f32(-2) },
    });
    const negativeLess = await execute(vcmp, {
      sRegisters: { 0: f32(-2), 1: f32(-1) },
    });
    const vmrs = await execute([...vcmp, ...vmrsApsr], {
      sRegisters: { 0: f32(1), 1: f32(2) },
    });

    try {
      expect((less.readFpscr() & 0xf000_0000) >>> 0).toBe(0x8000_0000);
      expect((greater.readFpscr() & 0xf000_0000) >>> 0).toBe(0x2000_0000);
      expect((equal.readFpscr() & 0xf000_0000) >>> 0).toBe(0x6000_0000);
      expect((unordered.readFpscr() & 0xf000_0000) >>> 0).toBe(0x3000_0000);
      expect((negativeGreater.readFpscr() & 0xf000_0000) >>> 0).toBe(0x2000_0000);
      expect((negativeLess.readFpscr() & 0xf000_0000) >>> 0).toBe(0x8000_0000);
      expect(unordered.readFpscr() & 1).toBe(0);
      expect(unorderedSignal.readFpscr() & 1).toBe(1);
      vmrs.run(1);
      expect((vmrs.state('apsr') as number) >>> 0).toBe(0x8100_0000);
    } finally {
      for (const rig of [
        less,
        greater,
        equal,
        unordered,
        unorderedSignal,
        negativeGreater,
        negativeLess,
        vmrs,
      ])
        rig.dispose();
    }
  });

  it('VLDR/VSTR、VLDM/VSTM、VPUSH/VPOP、VMOV D pair', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    sram[offset] = 0x00;
    sram[offset + 1] = 0x00;
    sram[offset + 2] = 0xc0;
    sram[offset + 3] = 0x3f;
    const load = await createFpuRig({
      code: codeOf([0x91, 0xed, 0x00, 0x0a]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sram,
    });

    const store = await createFpuRig({
      code: codeOf([0x81, 0xed, 0x00, 0x0a]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sRegisters: { 0: f32(1.5) },
      sram: new Uint8Array(0x2000),
    });

    const stm = await createFpuRig({
      code: codeOf([0xa1, 0xec, 0x04, 0x0a]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sRegisters: { 0: f32(1), 1: f32(2), 2: f32(3), 3: f32(4) },
      sram: new Uint8Array(0x2000),
    });
    const ldm = await createFpuRig({
      code: codeOf([0x92, 0xec, 0x04, 0x0a]),
      sp: SP,
      states: { r2: BASE },
      knownRegs: [undefined, undefined, BASE],
      sram,
    });

    const push = await createFpuRig({
      code: codeOf([0x2d, 0xed, 0x04, 0x0a]),
      sp: SP,
      sRegisters: { 0: f32(1), 1: f32(2), 2: f32(3), 3: f32(4) },
      sram: new Uint8Array(0x2000),
    });
    const popSram = new Uint8Array(0x2000);
    const stackOffset = SP - 16 - 0x2000_0000;

    popSram[stackOffset] = 0x00;
    popSram[stackOffset + 1] = 0x00;
    popSram[stackOffset + 2] = 0xc0;
    popSram[stackOffset + 3] = 0x3f;
    const pop = await createFpuRig({
      code: codeOf([0xbd, 0xec, 0x04, 0x0a]),
      sp: SP - 16,
      sram: popSram,
    });
    const moveD = await createFpuRig({
      code: codeOf([0x42, 0xec, 0x10, 0x1b]),
      sp: SP,
      states: { r1: 0x1122_3344, r2: 0x5566_7788 },
    });
    const moveDOut = await createFpuRig({
      code: codeOf([0x52, 0xec, 0x10, 0x1b]),
      sp: SP,
      sRegisters: { 0: 0x1122_3344, 1: 0x5566_7788 },
    });

    try {
      load.run(1);
      expect(load.readS(0)).toBe(0x3fc0_0000);

      store.run(1);
      const stored = store.memories.get('sram')!;
      expect(stored[offset]).toBe(0);
      expect(stored[offset + 1]).toBe(0);
      expect(stored[offset + 2]).toBe(0xc0);
      expect(stored[offset + 3]).toBe(0x3f);

      stm.run(1);
      const stmMemory = stm.memories.get('sram')!;
      expect(stm.state('r1')).toBe(BASE + 16);
      expect([0, 1, 2, 3].map((index) => stmMemory[offset + index * 4])).toEqual([0, 0, 0, 0]);

      ldm.run(1);
      expect(ldm.readS(0)).toBe(0x3fc0_0000);

      push.run(1);
      expect(push.state('sp')).toBe(SP - 16);
      pop.run(1);
      expect(pop.state('sp')).toBe(SP);
      expect(pop.readS(0)).toBe(0x3fc0_0000);

      moveD.run(1);
      expect(moveD.readS(0)).toBe(0x1122_3344);
      expect(moveD.readS(1)).toBe(0x5566_7788);
      moveDOut.run(1);
      expect(moveDOut.state('r1')).toBe(0x1122_3344);
      expect(moveDOut.state('r2')).toBe(0x5566_7788);
    } finally {
      for (const rig of [load, store, stm, ldm, push, pop, moveD, moveDOut]) rig.dispose();
    }
  });

  it('真实 arm-none-eabi-gcc -mfloat-abi=hard 固件经 JIT 执行', async () => {
    const firmware = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'fpu-smoke.bin')),
    );
    const sram = new Uint8Array(0x2000);

    sram.set(
      Uint8Array.of(
        f32(1.5) & 0xff,
        (f32(1.5) >>> 8) & 0xff,
        (f32(1.5) >>> 16) & 0xff,
        (f32(1.5) >>> 24) & 0xff,
        f32(2.25) & 0xff,
        (f32(2.25) >>> 8) & 0xff,
        (f32(2.25) >>> 16) & 0xff,
        (f32(2.25) >>> 24) & 0xff,
      ),
      0x100,
    );
    const rig = await createFpuRig({
      code: firmware,
      sp: SP,
      sram,
      knownRegs: Array<number | undefined>(16).fill(undefined),
    });

    try {
      rig.run(200);

      const out = rig.memories.get('sram')!;
      const word = (index: number): number =>
        ((out[index * 4] ?? 0) |
          ((out[index * 4 + 1] ?? 0) << 8) |
          ((out[index * 4 + 2] ?? 0) << 16) |
          ((out[index * 4 + 3] ?? 0) << 24)) >>>
        0;

      expect(word(0)).toBe(0x4070_0000); // 3.75
      expect(word(1)).toBe(0xbf40_0000); // -0.75
      expect(word(2)).toBe(0x4058_0000); // 3.375
      expect(word(3)).toBe(0x3f2a_aaab); // 0.6666667
      expect(word(4)).toBe(1); // vcvt.s32.f32 1.5 向零截断为 1
      expect(word(5)).toBe(0xc0a0_0000); // -5.0f
      expect(word(6)).toBe(1); // a < b
      expect(word(7)).toBe(0); // a == b
      expect(word(8)).toBe(2); // (int)2.25 -> 2（VFP 位型搬运）
      expect(word(9)).toBe(0x4000_0000); // (float)2
    } finally {
      rig.dispose();
    }
  });

  it('VMLA/VMLS 非融合乘加', async () => {
    const vmla = await execute([0x00, 0xee, 0x20, 0x1a], {
      sRegisters: { 0: f32(2), 1: f32(3), 2: f32(1) },
    });
    const vmls = await execute([0x00, 0xee, 0x60, 0x1a], {
      sRegisters: { 0: f32(2), 1: f32(3), 2: f32(10) },
    });

    try {
      expect(vmla.readS(2)).toBe(f32(7));
      expect(vmls.readS(2)).toBe(f32(4));
    } finally {
      vmla.dispose();
      vmls.dispose();
    }
  });

  it('VMSR 修改 FPSCR 后影响后续舍入，VMRS 读回', async () => {
    const rig = await createFpuRig({
      code: codeOf([
        0xe1,
        0xee,
        0x10,
        0x0a, // vmsr fpscr, r0
        0x30,
        0xee,
        0x20,
        0x1a, // vadd.f32 s2, s0, s1
        0xf1,
        0xee,
        0x10,
        0x0a, // vmrs r0, fpscr
      ]),
      sp: SP,
      states: { r0: FPSCR_RP },
      sRegisters: { 0: f32(1), 1: f32(2 ** -24) },
    });

    try {
      rig.run(1);
      rig.run(1);
      expect(rig.readS(2)).toBe(q('tie_rp'));
      rig.run(1);
      expect((rig.state('r0') as number) >>> 0).toBe(FPSCR_RP | 0x10);
    } finally {
      rig.dispose();
    }
  });

  it('VABS/VNEG 与 D 寄存器 64 位搬运', async () => {
    const sram = new Uint8Array(0x2000);
    const offset = BASE - 0x2000_0000;

    sram[offset] = 0x44;
    sram[offset + 1] = 0x33;
    sram[offset + 2] = 0x22;
    sram[offset + 3] = 0x11;
    sram[offset + 4] = 0x88;
    sram[offset + 5] = 0x77;
    sram[offset + 6] = 0x66;
    sram[offset + 7] = 0x55;
    const dLoad = await createFpuRig({
      code: codeOf([0x91, 0xed, 0x00, 0x0b]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sram,
    });
    const dStore = await createFpuRig({
      code: codeOf([0x81, 0xed, 0x00, 0x0b]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sRegisters: { 0: 0x1122_3344, 1: 0x5566_7788 },
      sram: new Uint8Array(0x2000),
    });
    const dStm = await createFpuRig({
      code: codeOf([0xa1, 0xec, 0x04, 0x0b]),
      sp: SP,
      states: { r1: BASE },
      knownRegs: [undefined, BASE],
      sRegisters: { 0: 0x0302_0100, 1: 0x0706_0504, 2: 0x0b0a_0908, 3: 0x0f0e_0d0c },
      sram: new Uint8Array(0x2000),
    });
    const dLdm = await createFpuRig({
      code: codeOf([0x92, 0xec, 0x04, 0x0b]),
      sp: SP,
      states: { r2: BASE },
      knownRegs: [undefined, undefined, BASE],
      sram,
    });
    const pushD = await createFpuRig({
      code: codeOf([0x2d, 0xed, 0x04, 0x0b]),
      sp: SP,
      sRegisters: { 0: 0x1122_3344, 1: 0x5566_7788 },
      sram: new Uint8Array(0x2000),
    });
    const popDStack = new Uint8Array(0x2000);
    const stackOffset = SP - 16 - 0x2000_0000;

    for (let index = 0; index < 16; index += 1) popDStack[stackOffset + index] = index + 1;
    const popD = await createFpuRig({
      code: codeOf([0xbd, 0xec, 0x04, 0x0b]),
      sp: SP - 16,
      sram: popDStack,
    });
    const absNegative = await execute([0xb0, 0xee, 0xc0, 0x1a], {
      sRegisters: { 0: f32(-1.5) },
    });
    const negPositive = await execute([0xb1, 0xee, 0x40, 0x1a], {
      sRegisters: { 0: f32(1.5) },
    });

    try {
      dLoad.run(1);
      expect(dLoad.readS(0)).toBe(0x1122_3344);
      expect(dLoad.readS(1)).toBe(0x5566_7788);

      dStore.run(1);
      expect([...dStore.memories.get('sram')!.subarray(offset, offset + 8)]).toEqual([
        0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55,
      ]);

      dStm.run(1);
      expect(dStm.state('r1')).toBe(BASE + 16);
      expect([...dStm.memories.get('sram')!.subarray(offset, offset + 16)]).toEqual([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f,
      ]);

      dLdm.run(1);
      expect(dLdm.readS(0)).toBe(0x1122_3344);
      expect(dLdm.readS(1)).toBe(0x5566_7788);

      pushD.run(1);
      expect(pushD.state('sp')).toBe(SP - 16);
      popD.run(1);
      expect(popD.state('sp')).toBe(SP);
      expect(popD.readS(0)).toBe(0x0403_0201);
      expect(popD.readS(1)).toBe(0x0807_0605);

      expect(absNegative.readS(2)).toBe(f32(1.5));
      expect(negPositive.readS(2)).toBe(f32(-1.5));
    } finally {
      for (const rig of [dLoad, dStore, dStm, dLdm, pushD, popD, absNegative, negPositive])
        rig.dispose();
    }
  });

  it('CPACR 关闭时走 NOCP，不执行 FP 指令', async () => {
    const rig = await createFpuRig({
      code: codeOf([0x30, 0xee, 0x20, 0x1a]),
      sp: SP,
      sRegisters: { 0: f32(1), 1: f32(2) },
      cpacr: 0,
    });

    try {
      rig.run(1);
      expect(rig.readS(2)).toBe(0);
      expect(rig.state('pc')).toBe(0);
      // CFSR.NOCP = bit19；请求的是 UsageFault（本 rig 未使能异常入口，仍应置位）。
      expect(rig.readWord(0x128) & (1 << 19)).toBe(1 << 19);
    } finally {
      rig.dispose();
    }
  });

  it('VMOV s,s 与 VMOV core→S 保持位型', async () => {
    const code = codeOf([
      0x00,
      0xee,
      0x10,
      0x0a, // vmov s0, r0
      0xf0,
      0xee,
      0x40,
      0x0a, // vmov.f32 s1, s0
    ]);
    const rig = await createFpuRig({
      code,
      sp: 0x2000_1000,
      states: { r0: 0x3fc0_0000 },
    });

    try {
      rig.run(1);
      expect(rig.readS(0)).toBe(0x3fc0_0000);
      rig.run(1);
      expect(rig.readS(1)).toBe(0x3fc0_0000);
    } finally {
      rig.dispose();
    }
  });
});
