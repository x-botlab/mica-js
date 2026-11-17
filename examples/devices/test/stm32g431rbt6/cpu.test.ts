import { describe, expect, it } from 'vitest';
import { decode } from '@mica-js/stm32g431rbt6-core/decode';
import { CPU_HIDDEN_EVENT } from '@mica-js/stm32g431rbt6-core/exclusive';
import { WAIT_ACTIVE, WAIT_NEXT, WAIT_PC } from '@mica-js/stm32g431rbt6-core/wait';
import { createCpuRig, codeOf, readWord, writeWord } from './cpu-rig';

const SRAM_BASE = 0x2000_0000;
const SP = SRAM_BASE + 0x1000;

const sysWord = (
  rig: Awaited<ReturnType<typeof createCpuRig>>,
  offset: number,
): number => readWord(rig.memories.get('sys')!, offset);

const runOne = async (
  bytes: readonly number[],
  states: Record<string, number | boolean> = {},
): Promise<Awaited<ReturnType<typeof createCpuRig>>> => {
  const rig = await createCpuRig({ code: codeOf(bytes), sp: SP, states });

  rig.run(1);
  return rig;
};

describe('Thumb-16 修正与系统指令', () => {
  it('REV / REV16 / REVSH 在 0xBAxx 编码上执行', async () => {
    const cases: readonly { bytes: readonly number[]; input: number; expected: number }[] = [
      { bytes: [0x08, 0xba], input: 0x1234_5678, expected: 0x7856_3412 }, // rev r0, r1
      { bytes: [0x48, 0xba], input: 0x1234_5678, expected: 0x3412_7856 }, // rev16 r0, r1
      { bytes: [0xc8, 0xba], input: 0x0000_80ff, expected: 0xffff_ff80 }, // revsh r0, r1
    ];

    for (const { bytes, input, expected } of cases) {
      const rig = await runOne(bytes, { r1: input });

      try {
        expect(rig.state('r0'), bytes.join(',')).toBe(expected >>> 0);
        expect(rig.state('halted')).toBe(false);
      } finally {
        rig.dispose();
      }
    }
  });

  it('未分配的 0xB7xx 编码显式 fault，不再静默穿透', async () => {
    const rig = await createCpuRig({ code: codeOf([0x00, 0xb7, 0x01, 0x20]), sp: SP });

    try {
      rig.run(1);
      expect(rig.faults.length).toBe(1);
      expect((rig.faults[0]! >>> 8) & 0xffff).toBe(0);
      expect(rig.state('halted')).toBe(true);
      expect(rig.state('r0')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('SETEND / 未分配 0xB6xx 显式 fault', async () => {
    for (const half of [0xb650, 0xb663]) {
      const rig = await createCpuRig({ code: codeOf([half & 0xff, half >>> 8]), sp: SP });

      try {
        rig.run(1);
        expect(rig.faults.length, half.toString(16)).toBe(1);
        expect(rig.state('halted')).toBe(true);
      } finally {
        rig.dispose();
      }
    }
  });

  // NVIC 代理当前在 enterSvc 的 allowedByBasepri 里于 lazy select 回调中调用
  // groupShift(b)（读 AIRCR），触发 IR_SCOPE；修复后本用例应恢复为执行 SVC 并检查
  // 8 字帧、IPSR 与异常返回。这里保留 decode 侧的控制流断言，避免把 NVIC 阻塞
  // 误报成 CPU 译码失败。
  it('SVC 编码被识别为同步异常控制流（执行入口由 NVIC 代理维护）', () => {
    const code = codeOf([0x00, 0xdf]);

    const instruction = decode(code, 0, undefined, code.byteLength);

    expect(instruction.size).toBe(2);
    expect(instruction.endsBatch).toBe(true);
  });

  it('SVC 走 NVIC 的同步异常入口并压 8 字帧', async () => {
    const code = codeOf([0x00, 0xdf, 0x01, 0x20]);
    const handler = 0x40;

    writeWord(code, 11 * 4, handler | 1);
    // handler: mrs r3, ipsr; bx lr
    [0xef, 0xf3, 0x05, 0x83, 0x70, 0x47].forEach((value, index) => {
      code[handler + index] = value;
    });

    const rig = await createCpuRig({ code, sp: SP });

    try {
      rig.run(1);
      const frame = SP - 32;

      expect(rig.state('pc')).toBe(handler);
      expect(rig.state('sp')).toBe(frame);
      expect(rig.state('lr')).toBe(0xffff_fff9);
      expect(readWord(rig.memories.get('sram')!, frame - SRAM_BASE + 24)).toBe(2);

      rig.run(1); // mrs r3, ipsr
      expect(rig.state('r3')).toBe(11);

      rig.run(1); // bx lr -> exception return
      expect(rig.state('pc')).toBe(2);
      expect(rig.state('sp')).toBe(SP);
      expect(rig.state('lr')).toBe(0xffff_ffff);

      rig.run(1); // movs r0, #1
      expect(rig.state('r0')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('POP {pc} 先写回 SP 再装 PC', async () => {
    const code = codeOf([0x80, 0xbd]); // pop {r7, pc}
    const sram = new Uint8Array(0x2000);
    const top = SP - SRAM_BASE;

    writeWord(sram, top, 0x7777_7777); // r7
    writeWord(sram, top + 4, 0x0000_0200); // pc
    const rig = await createCpuRig({ code, sp: SP, sram });

    try {
      rig.run(1);
      expect(rig.state('pc')).toBe(0x200);
      expect(rig.state('sp')).toBe(SP + 8);
      expect(rig.state('r7')).toBe(0x7777_7777);
    } finally {
      rig.dispose();
    }
  });

  it('POP {pc} 装载 EXC_RETURN 时执行异常返回', async () => {
    const code = codeOf([0x00, 0xbd]); // pop {pc}
    const sram = new Uint8Array(0x2000);
    const start = SP - 4; // POP 后 SP=SP，满足异常帧 8 字节对齐
    const top = start - SRAM_BASE;

    writeWord(sram, top, 0xffff_fff9); // pop 取出的 PC
    writeWord(sram, top + 4, 0x1111_1111); // r0
    writeWord(sram, top + 8, 0x2222_2222); // r1
    writeWord(sram, top + 12, 0x3333_3333); // r2
    writeWord(sram, top + 16, 0x4444_4444); // r3
    writeWord(sram, top + 20, 0x5555_5555); // r12
    writeWord(sram, top + 24, 0x6666_6666); // lr
    writeWord(sram, top + 28, 0x0000_0200); // pc
    writeWord(sram, top + 32, 0x0100_0000); // xpsr
    const rig = await createCpuRig({ code, sp: start, sram });

    try {
      rig.run(1);
      expect(rig.state('pc')).toBe(0x200);
      expect((rig.state('sp') as number) >>> 0).toBeGreaterThanOrEqual(SP + 32);
      expect(rig.state('r0')).toBe(0x1111_1111);
      expect(rig.state('r1')).toBe(0x2222_2222);
      expect(rig.state('r12')).toBe(0x5555_5555);
      expect(rig.state('lr')).toBe(0x6666_6666);
    } finally {
      rig.dispose();
    }
  });

  it('MRS/MSR APSR、PRIMASK、MSP、PSP、CONTROL、BASEPRI、FAULTMASK 与 IPSR', async () => {
    const apsr = await createCpuRig({
      code: codeOf([
        0x80, 0xf3, 0x00, 0x88, // msr apsr_nzcvq, r0
        0x88, 0xf3, 0x00, 0x84, // msr apsr_g, r8
        0xef, 0xf3, 0x00, 0x81, // mrs r1, apsr
      ]),
      sp: SP,
      states: { r0: 0xf800_0000, r8: 0x000f_0000 },
    });

    try {
      apsr.run(3);
      expect((apsr.state('apsr') as number) >>> 0).toBe(0xf90f_0000);
      expect((apsr.state('r1') as number) >>> 0).toBe(0xf80f_0000);
    } finally {
      apsr.dispose();
    }

    const primask = await createCpuRig({
      code: codeOf([
        0x80, 0xf3, 0x10, 0x88, // msr primask, r0
        0xef, 0xf3, 0x10, 0x81, // mrs r1, primask
      ]),
      sp: SP,
      states: { r0: 1 },
    });

    try {
      primask.run(2);
      expect(primask.state('primask')).toBe(1);
      expect(primask.state('r1')).toBe(1);
    } finally {
      primask.dispose();
    }

    const banks = await createCpuRig({
      code: codeOf([
        0x87, 0xf3, 0x09, 0x88, // msr psp, r7
        0xef, 0xf3, 0x09, 0x88, // mrs r8, psp
        0xef, 0xf3, 0x08, 0x86, // mrs r6, msp (thread MSP -> 当前 SP)
        0x83, 0xf3, 0x14, 0x88, // msr control, r3
        0xef, 0xf3, 0x14, 0x84, // mrs r4, control
        0x85, 0xf3, 0x08, 0x88, // msr msp, r5
        0xef, 0xf3, 0x08, 0x86, // mrs r6, msp (thread PSP -> 隐藏 MSP)
        0x82, 0xf3, 0x11, 0x88, // msr basepri, r2
        0xef, 0xf3, 0x11, 0x86, // mrs r6, basepri
        0x80, 0xf3, 0x13, 0x88, // msr faultmask, r0
        0xef, 0xf3, 0x13, 0x87, // mrs r7, faultmask
      ]),
      sp: SP,
      states: {
        r7: 0x2000_2000,
        r3: 2,
        r5: 0x2000_3000,
        r2: 0xf0,
        r0: 1,
      },
    });

    try {
      banks.run(1); // msr psp
      banks.run(1); // mrs psp -> r8
      expect(banks.state('r8')).toBe(0x2000_2000);

      banks.run(1); // mrs r6, msp -> 当前 SP
      expect(banks.state('r6')).toBe(SP);

      banks.run(1); // msr control, #2: thread 从 MSP 切到 PSP
      expect(banks.state('sp')).toBe(0x2000_2000);
      banks.run(1); // mrs control -> r4
      expect(banks.state('r4')).toBe(2);

      banks.run(1); // msr msp, r5（SPSEL=1，写隐藏 MSP）
      banks.run(1); // mrs r6, msp -> 新 MSP
      expect(banks.state('r6')).toBe(0x2000_3000);

      banks.run(1); // msr basepri
      banks.run(1); // mrs r6, basepri
      expect(banks.state('r6')).toBe(0xf0);

      banks.run(1); // msr faultmask
      banks.run(1); // mrs r7, faultmask
      expect(banks.state('r7')).toBe(1);
    } finally {
      banks.dispose();
    }

    const ipsr = await createCpuRig({
      code: codeOf([0xef, 0xf3, 0x05, 0x80]), // mrs r0, ipsr
      sp: SP,
    });

    try {
      ipsr.run(1);
      expect(ipsr.state('r0')).toBe(0);
    } finally {
      ipsr.dispose();
    }
  });

  it('CPSID f / CPSIE f 通过 nvic 的 FAULTMASK 隐藏状态生效', async () => {
    const rig = await createCpuRig({
      code: codeOf([
        0x71, 0xb6, // cpsid f
        0xef, 0xf3, 0x13, 0x80, // mrs r0, faultmask
        0x61, 0xb6, // cpsie f
        0xef, 0xf3, 0x13, 0x81, // mrs r1, faultmask
      ]),
      sp: SP,
    });

    try {
      rig.run(1);
      rig.run(1);
      expect(rig.state('r0')).toBe(1);
      rig.run(1);
      rig.run(1);
      expect(rig.state('r1')).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('DMB/DSB/ISB/NOP.W 是已识别的顺序屏障，SEV/YIELD 是 hint', async () => {
    const rig = await createCpuRig({
      code: codeOf([
        0xbf, 0xf3, 0x5f, 0x8f, // dmb sy
        0xbf, 0xf3, 0x4f, 0x8f, // dsb sy
        0xbf, 0xf3, 0x6f, 0x8f, // isb sy
        0xaf, 0xf3, 0x00, 0x80, // nop.w
        0x40, 0xbf, // sev
        0x10, 0xbf, // yield
        0x01, 0x20, // movs r0, #1
      ]),
      sp: SP,
    });

    try {
      for (let step = 0; step < 6; step += 1) rig.run(1);
      expect(rig.state('pc')).toBe(20);
      rig.run(1);
      expect(rig.state('r0')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('SEV 置 event、WFE 消费；irqDirty 只触发扫描，不单独唤醒', async () => {
    const signaled = await createCpuRig({
      code: codeOf([0x40, 0xbf, 0x20, 0xbf, 0x01, 0x22]),
      sp: SP,
      states: { tickPs: 100 },
    });

    try {
      signaled.run(1); // sev
      signaled.run(1); // wfe consumes event, no sleep
      expect(signaled.state('pc')).toBe(4);
      expect(sysWord(signaled, CPU_HIDDEN_EVENT)).toBe(0);
      expect(sysWord(signaled, WAIT_ACTIVE)).toBe(0);
      signaled.run(1);
      expect(signaled.state('r2')).toBe(1);
    } finally {
      signaled.dispose();
    }

    const sleeping = await createCpuRig({
      code: codeOf([0x20, 0xbf, 0x01, 0x22]),
      sp: SP,
      states: { tickPs: 100, irqDirty: false },
    });

    try {
      sleeping.run(1);
      expect(sleeping.state('pc')).toBe(0);
      expect(sleeping.state('r2')).toBe(0);
      expect(sysWord(sleeping, WAIT_ACTIVE)).toBe(1);
      expect(sysWord(sleeping, WAIT_PC)).toBe(0);
      expect(sysWord(sleeping, WAIT_NEXT)).toBe(2);
    } finally {
      sleeping.dispose();
    }

    const dirty = await createCpuRig({
      code: codeOf([0x20, 0xbf, 0x01, 0x22]),
      sp: SP,
      states: { irqDirty: true },
    });

    try {
      dirty.run(1);
      // dirty 只是“需要扫描”，不能把 PC 推到下一条；由 DISPATCH 判定真实 IRQ。
      expect(dirty.state('pc')).toBe(0);
      expect(dirty.state('r2')).toBe(0);
      expect(((dirty.state('serviceMask') as number) & 16) >>> 0).toBe(16);
      expect(sysWord(dirty, WAIT_ACTIVE)).toBe(1);
      expect(sysWord(dirty, WAIT_NEXT)).toBe(2);
    } finally {
      dirty.dispose();
    }
  });

  it('WFI 无 pending 时停在当前 PC；irqDirty 不单独唤醒', async () => {
    const sleeping = await createCpuRig({
      code: codeOf([0x30, 0xbf, 0x01, 0x20]),
      sp: SP,
      states: { tickPs: 100, irqDirty: false },
    });

    try {
      sleeping.run(1);
      expect(sleeping.state('pc')).toBe(0);
      expect(sleeping.state('r0')).toBe(0);
      expect(sysWord(sleeping, WAIT_ACTIVE)).toBe(1);
      expect(sysWord(sleeping, WAIT_PC)).toBe(0);
      expect(sysWord(sleeping, WAIT_NEXT)).toBe(2);
    } finally {
      sleeping.dispose();
    }

    const dirty = await createCpuRig({
      code: codeOf([0x30, 0xbf, 0x01, 0x20]),
      sp: SP,
      states: { irqDirty: true },
    });

    try {
      dirty.run(1);
      expect(dirty.state('pc')).toBe(0);
      expect(dirty.state('r0')).toBe(0);
      expect(((dirty.state('serviceMask') as number) & 16) >>> 0).toBe(16);
      expect(sysWord(dirty, WAIT_ACTIVE)).toBe(1);
      expect(sysWord(dirty, WAIT_NEXT)).toBe(2);
    } finally {
      dirty.dispose();
    }
  });

  it('post-index LDRB/LDRH/LDR/STRB 更新基址并保持访问宽度', async () => {
    const base = SRAM_BASE + 0x200;
    const sram = new Uint8Array(0x2000);

    writeWord(sram, 0x200, 0x1234_5678);
    writeWord(sram, 0x204, 0x9abc_def0);

    const loads: readonly { readonly bytes: readonly number[]; readonly expected: number; readonly next: number }[] = [
      { bytes: [0x11, 0xf8, 0x02, 0x2b], expected: 0x78, next: base + 2 }, // ldrb r2,[r1],#2
      { bytes: [0x31, 0xf8, 0x02, 0x2b], expected: 0x5678, next: base + 2 }, // ldrh r2,[r1],#2
      { bytes: [0x51, 0xf8, 0x04, 0x2b], expected: 0x1234_5678, next: base + 4 }, // ldr r2,[r1],#4
    ];

    for (const { bytes, expected, next } of loads) {
      const rig = await createCpuRig({
        code: codeOf(bytes),
        sp: SP,
        states: { r1: base },
        sram,
      });

      try {
        rig.run(1);
        expect(rig.state('r2'), bytes.join(',')).toBe(expected);
        expect(rig.state('r1'), bytes.join(',')).toBe(next);
      } finally {
        rig.dispose();
      }
    }

    const byteStore = new Uint8Array(0x2000);
    const stored = await createCpuRig({
      code: codeOf([0x01, 0xf8, 0x01, 0x2b]), // strb r2,[r1],#1
      sp: SP,
      states: { r1: base, r2: 0xab },
      sram: byteStore,
    });

    try {
      stored.run(1);
      expect(stored.memories.get('sram')![0x200]).toBe(0xab);
      expect(stored.state('r1')).toBe(base + 1);
    } finally {
      stored.dispose();
    }

    const preIndex = await createCpuRig({
      code: codeOf([0x11, 0xf8, 0x01, 0x2f]), // ldrb r2,[r1,#1]!
      sp: SP,
      states: { r1: base },
      sram,
    });

    try {
      preIndex.run(1);
      expect(preIndex.state('r2')).toBe(0x56);
      expect(preIndex.state('r1')).toBe(base + 1);
    } finally {
      preIndex.dispose();
    }
  });

  it('B3xx/B9xx/BBxx CBZ/CBNZ 使用完整 i/op 位并到达高低偏移目标', async () => {
    const cases: readonly {
      readonly instr: number;
      readonly r0: number;
      readonly target: number;
      readonly fallthrough: number;
    }[] = [
      { instr: 0xb3f0, r0: 0, target: 0x80, fallthrough: 2 }, // cbz r0, +0x7c（HAL 0x08000b54）
      { instr: 0xb3f0, r0: 1, target: 0x80, fallthrough: 2 }, // cbz 不成立
      { instr: 0xbbf0, r0: 0, target: 0x80, fallthrough: 2 }, // cbnz 不成立
      { instr: 0xbbf0, r0: 1, target: 0x80, fallthrough: 2 }, // cbnz 成立
      { instr: 0xb1f0, r0: 0, target: 0x40, fallthrough: 2 }, // i=0 低偏移
    ];

    for (const { instr, r0, target, fallthrough } of cases) {
      const rig = await createCpuRig({
        code: codeOf([instr & 0xff, (instr >> 8) & 0xff]),
        sp: SP,
        states: { r0 },
      });

      try {
        rig.run(1);
        const taken = (instr & 0x0800) !== 0 ? r0 !== 0 : r0 === 0;

        expect(rig.state('pc'), instr.toString(16)).toBe(taken ? target : fallthrough);
      } finally {
        rig.dispose();
      }
    }
  });

  it('halt 写回 faulting PC，不继续顺序推进', async () => {
    const rig = await createCpuRig({
      code: codeOf([0xff, 0xff]),
      sp: SP,
    });

    try {
      rig.run(1);
      expect(rig.state('halted')).toBe(true);
      expect(rig.state('pc')).toBe(0);
      expect(rig.faults).toHaveLength(1);
    } finally {
      rig.dispose();
    }
  });

  it('IT 条件只执行满足 APSR 的指令', async () => {
    const cases: readonly { readonly it: number; readonly expected: number }[] = [
      { it: 0x08, expected: 1 }, // it eq; moveq r1,#1（cmp r0,#1 置 Z）
      { it: 0x18, expected: 0x55 }, // it ne; movne r1,#1（条件不成立）
    ];

    for (const { it, expected } of cases) {
      const rig = await createCpuRig({
        code: codeOf([
          0x01, 0x20, // movs r0,#1
          0x01, 0x28, // cmp r0,#1
          it, 0xbf, // it eq / it ne
          0x01, 0x21, // moveq/movne r1,#1
        ]),
        sp: SP,
        states: { r1: 0x55 },
        conditional: true,
      });

      try {
        for (let step = 0; step < 4; step += 1) rig.run(1);
        expect(rig.state('r1'), `it ${it.toString(16)}`).toBe(expected);
      } finally {
        rig.dispose();
      }
    }
  });

  it('CMP 的减法溢出标志（N/V）与 BGE 条件', async () => {
    const less = await createCpuRig({
      code: codeOf([0x9a, 0x42, 0x0c, 0xda]), // cmp r2,r3; bge +0x18
      sp: SP,
      states: { r2: 1, r3: 8 },
    });

    try {
      less.run(1);
      expect((((less.state('apsr') as number) >>> 0) & 0x8000_0000) >>> 0).toBe(0x8000_0000);
      expect((((less.state('apsr') as number) >>> 0) & 0x1000_0000) >>> 0).toBe(0);
      less.run(1);
      expect(less.state('pc')).toBe(4);
    } finally {
      less.dispose();
    }

    const overflow = await createCpuRig({
      code: codeOf([0x9a, 0x42]),
      sp: SP,
      states: { r2: 0x8000_0000, r3: 1 },
    });

    try {
      overflow.run(1);
      expect((((overflow.state('apsr') as number) >>> 0) & 0x1000_0000) >>> 0).toBe(0x1000_0000);
    } finally {
      overflow.dispose();
    }
  });

  it('MULS 使用精确低 32 位乘积', async () => {
    const rig = await createCpuRig({
      code: codeOf([0x48, 0x43]),
      sp: SP,
      states: { r0: 0x7fff_ffff, r1: 0x7fff_ffff },
    });

    try {
      rig.run(1);
      expect(rig.state('r0')).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it('direct JIT 后端执行新增 DSP 指令并保留 Q', async () => {
    const rig = await createCpuRig({
      code: codeOf([
        0x01, 0xf3, 0x07, 0x00, // ssat r0, #8, r1
        0x82, 0xfa, 0x81, 0xf0, // qadd r0, r1, r2
        0xfe, 0xe7, // b .
      ]),
      sp: SP,
      execution: 'throughput',
      states: { r1: 0x100, r2: 2 },
    });

    try {
      rig.run(3);
      expect(rig.direct()).toBe(true);
      expect(rig.state('r0')).toBe(258);
      expect(((rig.state('apsr') as number) & 0x0800_0000) !== 0).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('BKPT/UDF 保持显式 fault', async () => {
    for (const instruction of [
      [0x00, 0xbe],
      [0x00, 0xde],
    ]) {
      const rig = await createCpuRig({ code: codeOf(instruction), sp: SP });

      try {
        rig.run(1);
        expect(rig.faults.length).toBe(1);
        expect(rig.state('halted')).toBe(true);
      } finally {
        rig.dispose();
      }
    }
  });
});
