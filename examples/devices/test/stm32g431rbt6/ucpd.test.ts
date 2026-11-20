import { describe, expect, it } from 'vitest';
import { PWR_CR3, PWR_REGISTERS } from '@mica-js/stm32g431rbt6-core/pwr';
import { RCC_APB1ENR2 } from '@mica-js/stm32g431rbt6-core/clock-tree';
import { RCC_RCC_STATE } from '@mica-js/stm32g431rbt6-core/layout';
import { types } from '@mica-js/sdk/model';
import type { Value } from '@mica-js/sdk/model';
import { num, writeWordAt } from '@mica-js/stm32g431rbt6-core/ir';
import type { Body } from '@mica-js/stm32g431rbt6-core/ir';
import {
  UCPD1_BASE,
  UCPD_CFG1,
  UCPD_CFG1_UCPDEN,
  UCPD_CR,
  UCPD_CR_ANASUBMODE_SHIFT,
  UCPD_CR_CCENABLE_SHIFT,
  UCPD_ICR,
  UCPD_IMR,
  UCPD_SR,
  UCPD_SR_TYPECEVT1,
  UCPD_SR_TYPEC_VSTATE_CC1_SHIFT,
  UCPD_SR_TYPEC_VSTATE_CC2_SHIFT,
  readUcpdAt,
  ucpdPending,
  writeUcpdAt,
} from '@mica-js/stm32g431rbt6-core/ucpd';
import { runUcpdRig } from './ucpd-rig';

const OUT_SR = 0x00;
const OUT_SR_AFTER_DISABLE = 0x04;
const OUT_CFG1 = 0x08;

const write = (b: Body, address: number, value: number): void => {
  writeUcpdAt(b, address, 4, num(b, value));
};
const read = (b: Body, address: number): ReturnType<typeof readUcpdAt> => readUcpdAt(b, address, 4);
const put = (b: Body, offset: number, value: ReturnType<typeof num>): void => {
  writeWordAt(b, 'out', offset, value);
};
const putFlag = (b: Body, offset: number, value: Value<boolean>): void => {
  put(
    b,
    offset,
    b.select(
      types.number,
      value,
      (inner) => inner.constant(types.number, 1),
      (inner) => inner.constant(types.number, 0),
    ),
  );
};
const vstate = (sr: number, shift: number): number => (sr >>> shift) & 3;

describe('UCPD1 Type-C 检测（IR rig + 真实电阻）', () => {
  it('sink Rd 5.1k 与 5V/56k 源得到约 0.42V，VSTATE=2；禁用后 CC 释放', async () => {
    const rig = await runUcpdRig({
      build: (b, wait) => {
        writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR2, num(b, 1 << 8));
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR3, num(b, 1 << 14));
        write(b, UCPD1_BASE + UCPD_CFG1, UCPD_CFG1_UCPDEN);
        write(b, UCPD1_BASE + UCPD_CR, (1 << 9) | (3 << UCPD_CR_CCENABLE_SHIFT));
        write(b, UCPD1_BASE + UCPD_IMR, (1 << 14) | (1 << 15));
        wait(1_000_000_000);
        put(b, OUT_SR, read(b, UCPD1_BASE + UCPD_SR));
        write(b, UCPD1_BASE + UCPD_CFG1, 0);
        wait(1_000_000_000);
        put(b, OUT_SR_AFTER_DISABLE, read(b, UCPD1_BASE + UCPD_SR));
        put(b, OUT_CFG1, read(b, UCPD1_BASE + UCPD_CFG1));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);
      const sr = out.getUint32(OUT_SR, true);

      expect(vstate(sr, UCPD_SR_TYPEC_VSTATE_CC1_SHIFT)).toBe(2);
      expect(vstate(sr, UCPD_SR_TYPEC_VSTATE_CC2_SHIFT)).toBe(1);
      expect(sr & UCPD_SR_TYPECEVT1).toBe(UCPD_SR_TYPECEVT1);
      expect(rig.voltageHistory('cc1').some((value) => Math.abs(value - 0.4173) < 0.01)).toBe(true);
      expect(out.getUint32(OUT_SR_AFTER_DISABLE, true)).toBe(0);
      expect(out.getUint32(OUT_CFG1, true)).toBe(0);
      expect(rig.voltage('cc1')).toBeCloseTo(5, 1);
    } finally {
      rig.dispose();
    }
  });

  it('source default Rp 56k 与外部 5.1k 下拉得到约 0.31V，VSTATE=2', async () => {
    const rig = await runUcpdRig({
      cc1Source: false,
      cc1Load: true,
      build: (b, wait) => {
        writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR2, num(b, 1 << 8));
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR3, num(b, 1 << 14));
        write(b, UCPD1_BASE + UCPD_CFG1, UCPD_CFG1_UCPDEN);
        write(
          b,
          UCPD1_BASE + UCPD_CR,
          (0 << 9) | (1 << UCPD_CR_ANASUBMODE_SHIFT) | (3 << UCPD_CR_CCENABLE_SHIFT),
        );
        wait(1_000_000_000);
        put(b, OUT_SR, read(b, UCPD1_BASE + UCPD_SR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);
      const sr = out.getUint32(OUT_SR, true);

      expect(vstate(sr, UCPD_SR_TYPEC_VSTATE_CC1_SHIFT)).toBe(2);
      expect(rig.voltage('cc1')).toBeCloseTo(0.2755, 3);
    } finally {
      rig.dispose();
    }
  });

  it('DBDIS=0 时 dead-battery Rd 仍接在 CC 上，且 UCPD 检测器不工作', async () => {
    const rig = await runUcpdRig({
      build: (b) => {
        writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR2, num(b, 1 << 8));
        put(b, OUT_SR, read(b, UCPD1_BASE + UCPD_SR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(OUT_SR, true)).toBe(0);
      expect(rig.voltageHistory('cc1').some((value) => Math.abs(value - 0.4173) < 0.01)).toBe(true);
    } finally {
      rig.dispose();
    }
  });
  it('IMR/ICR 清除 TYPECEVT1 后中断挂起消失，IMR 支持半字访问', async () => {
    const rig = await runUcpdRig({
      build: (b, wait) => {
        writeWordAt(b, 'periph', RCC_RCC_STATE + RCC_APB1ENR2, num(b, 1 << 8));
        writeWordAt(b, 'periph', PWR_REGISTERS + PWR_CR3, num(b, 1 << 14));
        write(b, UCPD1_BASE + UCPD_CFG1, UCPD_CFG1_UCPDEN);
        write(b, UCPD1_BASE + UCPD_CR, (1 << 9) | (3 << UCPD_CR_CCENABLE_SHIFT));
        writeUcpdAt(b, UCPD1_BASE + UCPD_IMR, 2, num(b, 0x4000));
        wait(1_000_000_000);
        put(b, 0x04, read(b, UCPD1_BASE + UCPD_SR));
        putFlag(b, 0x00, ucpdPending(b));
        put(b, 0x08, read(b, UCPD1_BASE + UCPD_IMR));
        write(b, UCPD1_BASE + UCPD_ICR, 0x4000);
        putFlag(b, 0x0c, ucpdPending(b));
        put(b, 0x10, read(b, UCPD1_BASE + UCPD_SR));
      },
    });

    try {
      const out = new DataView(rig.memory('out').buffer);

      expect(out.getUint32(0x00, true)).toBe(1);
      expect(out.getUint32(0x04, true) & UCPD_SR_TYPECEVT1).toBe(UCPD_SR_TYPECEVT1);
      expect(out.getUint32(0x08, true)).toBe(0x4000);
      expect(out.getUint32(0x0c, true)).toBe(0);
      expect(out.getUint32(0x10, true) & UCPD_SR_TYPECEVT1).toBe(0);
    } finally {
      rig.dispose();
    }
  });
});
