import { describe, expect, it } from 'vitest';
import {
  UCPD_SR_TYPECEVT1,
  UCPD_SR_TYPECEVT2,
  UCPD_SR_TYPEC_VSTATE_CC1_SHIFT,
} from '@mica-js/stm32g431rbt6-core/ucpd';
import { firmware } from './harness';
import { runMcu } from './mcu-harness';

const vstate = (sr: number, shift: number): number => (sr >>> shift) & 3;

describe('UCPD1 Type-C 检测（真实 MCU 固件）', () => {
  it('固件轮询 SR 得到 TYPECEVT1/2，ICR 清除后事件消失', async () => {
    const view = await runMcu({
      firmware: firmware('ucpd-poll.bin'),
      durationPs: 3_000_000_000,
      ucpd: { cc1Source: true },
    });

    try {
      const sr = view.u32(0x4004);

      expect(view.u32(0x4000)).toBe(1);
      expect(vstate(sr, UCPD_SR_TYPEC_VSTATE_CC1_SHIFT)).toBe(2);
      expect(sr & UCPD_SR_TYPECEVT1).toBe(UCPD_SR_TYPECEVT1);
      expect(sr & UCPD_SR_TYPECEVT2).toBe(UCPD_SR_TYPECEVT2);
      expect(view.u32(0x4008)).toBe(0x80000000);
      expect(view.u32(0x4010) & 0xc000).toBe(0);
      expect(view.voltageHistory('cc1').some((value) => Math.abs(value - 0.4173) < 0.01)).toBe(
        true,
      );
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });
});
