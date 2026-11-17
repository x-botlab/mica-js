import { types } from '@mica-js/sdk/model';
import { describe, expect, it } from 'vitest';
import { writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  LOW_POWER_STOP1,
  PWR_CR1,
  PWR_CR5,
  PWR_REGISTERS,
  PWR_SCR,
  PWR_SR1,
  PWR_SR2,
  lowPowerRequest,
  readPwr,
  setWakeFlags,
  writePwr,
} from '@mica-js/stm32g431rbt6-core/pwr';
import { clockRig } from './clock-rig';

const n = (b: Body, value: number) => b.constant(types.number, value);
const read = (b: Body, offset: number) => readPwr(b, n(b, offset), 4);
const save = (b: Body, index: number, value: ReturnType<typeof readPwr>): void =>
  b.writeState(`o${index}`, value);

describe('PWR 核心 IR（合成夹具）', () => {
  it('VOS 只来自 CR1；SR2 保留 PVMO 并清 VOSF', () => {
    const rig = clockRig({
      init: (b) => {
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR1, n(b, 0x401)); // Range2 + Stop1
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR5, n(b, 0x100)); // R1MODE=1
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_SR2, n(b, 0xc400)); // PVMO4/3 + VOSF=1
      },
      emit: (b) => {
        save(b, 0, read(b, PWR_SR2));
        save(b, 1, read(b, PWR_CR1));
        writeWordAt(b, 'sys', 0x110, n(b, 1 << 2)); // SCB.SCR.SLEEPDEEP
        save(b, 2, lowPowerRequest(b));
      },
    });

    try {
      rig.run(1);
      const sr2 = rig.states.get('o0') as number;
      const cr1 = rig.states.get('o1') as number;

      expect(cr1 & 0x600).toBe(0x400);
      expect(cr1 & 0x7).toBe(1);
      // bit15/14 是 PVMO4/PVMO3，必须原样保留，不能伪造 VOS 副本。
      expect(sr2 & 0xc000).toBe(0xc000);
      expect(sr2 & (1 << 10)).toBe(0); // VOSF 已就绪
      expect(rig.states.get('o2')).toBe(LOW_POWER_STOP1);
    } finally {
      rig.dispose();
    }
  });

  it('SR1/SR2 只读；SCR 按 lane 清 WUFx/CSBF，读回 0', () => {
    const rig = clockRig({
      init: (b) => {
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR1, n(b, 0x401));
        // 模拟硬件唤醒事件置位 WUF1..5 + SBF。
        setWakeFlags(b, n(b, 0x011f));
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_SR2, n(b, 0xc000));
      },
      emit: (b) => {
        // 软件不能置只读位。
        writePwr(b, n(b, PWR_SR1), 4, n(b, 0xffff_ffff));
        writePwr(b, n(b, PWR_SR2), 4, n(b, 0xffff_ffff));
        save(b, 0, read(b, PWR_SR1));
        save(b, 1, read(b, PWR_SR2));
        // SCR 高字节 CSBF：只清 SBF，保留 WUF1..5。
        writePwr(b, n(b, PWR_SCR + 1), 1, n(b, 0x01));
        save(b, 2, read(b, PWR_SR1));
        // SCR 低字节 CWUF1..5：清 WUF1..5。
        writePwr(b, n(b, PWR_SCR), 1, n(b, 0x1f));
        save(b, 3, read(b, PWR_SR1));
        save(b, 4, read(b, PWR_SCR));
        // 保留偏移不可读写，也不与 CR1/SR1 别名。
        writePwr(b, n(b, 0x1c), 4, n(b, 0xffff_ffff));
        save(b, 5, read(b, 0x1c));
        save(b, 6, read(b, PWR_CR1));
      },
    });

    try {
      rig.run(1);
      expect(rig.states.get('o0')).toBe(0x011f);
      expect(rig.states.get('o1')).toBe(0xc000);
      expect(rig.states.get('o2')).toBe(0x001f);
      expect(rig.states.get('o3')).toBe(0);
      expect(rig.states.get('o4')).toBe(0);
      expect(rig.states.get('o5')).toBe(0);
      expect(rig.states.get('o6')).toBe(0x401);
    } finally {
      rig.dispose();
    }
  });
});
