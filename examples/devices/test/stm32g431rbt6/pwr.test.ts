import { describe, expect, it } from 'vitest';
import {
  LOW_POWER_SLEEP,
  LOW_POWER_STANDBY,
  LOW_POWER_STOP0,
  LOW_POWER_STOP1,
  lowPowerModeOf,
  voltageLimitHz,
  voltageScalingOf,
} from '@mica-js/stm32g431rbt6-core/pwr';
import { clockBoard } from './clock-harness';
import { firmware } from './harness';

function word(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

describe('PWR VOS/VOSF', () => {
  it('VOS 写入后 SR2 报告目标档位且 VOSF 为已就绪', async () => {
    const rig = await clockBoard({
      firmware: firmware('pwr-vos.bin'),
      clockFrequency: 16_000_000,
    });

    try {
      rig.run(5_000_000_000);
      const sr2 = word(rig.memory('sram'), 0);
      const cr1 = word(rig.memory('sram'), 4);
      const scr = word(rig.memory('sram'), 8);

      expect(cr1 & 0x600).toBe(0x400); // VOS = Range 2（只从 CR1 读）
      expect(cr1 & 0x7).toBe(1); // LPMS = Stop 1
      expect(sr2 & (1 << 10)).toBe(0); // VOSF=0：已稳定
      expect(sr2 & 0xc000).toBe(0); // bit15/14 是 PVMO，固件未置位就不是 VOS 副本
      expect(scr).toBe(0); // SCR 的 W1C 位读回 0
    } finally {
      rig.dispose();
    }
  });

  it('按 VOS/R1MODE 给出频率上限', () => {
    expect(voltageScalingOf(0)).toBe(1); // 复位缺省 Range 1
    expect(voltageScalingOf(0x400)).toBe(2);
    // CR5.R1MODE 在 bit8：0=boost(170 MHz)，1=普通 Range1(150 MHz)。
    expect(voltageLimitHz(0x200, 0)).toBe(170_000_000);
    expect(voltageLimitHz(0x200, 0x100)).toBe(150_000_000);
    expect(voltageLimitHz(0x400, 0x100)).toBe(26_000_000);
  });

  it('把 SLEEPDEEP/LPMS 映射到低功耗目标模式', () => {
    expect(lowPowerModeOf(0x401, false)).toBe(LOW_POWER_SLEEP);
    expect(lowPowerModeOf(0, true)).toBe(LOW_POWER_STOP0);
    expect(lowPowerModeOf(1, true)).toBe(LOW_POWER_STOP1);
    expect(lowPowerModeOf(3, true)).toBe(LOW_POWER_STANDBY);
    expect(lowPowerModeOf(4, true)).toBe(4);
  });
});
