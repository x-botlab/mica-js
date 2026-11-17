import { describe, expect, it } from 'vitest';
import { FDCAN_IR_RF0N, FDCAN_IR_TC, FDCAN_RXF0S_F0FL } from '@mica-js/stm32g431rbt6-core/fdcan';
import { firmware } from './harness';
import { runMcu } from './mcu-harness';

describe('FDCAN1 内部 loopback（真实 MCU 固件）', () => {
  it('固件通过 FDCAN1_IT0 取走 Rx FIFO0 并完成 TX', async () => {
    let view: Awaited<ReturnType<typeof runMcu>>;
    try {
      view = await runMcu({ firmware: firmware('fdcan-loopback.bin'), durationPs: 300_000_000 });
    } catch (error) {
      console.error('RUNMCU ERROR', error);
      throw error;
    }

    try {
      expect(view.u32(0x4000)).toBe(1);
      expect(view.u32(0x4004) & FDCAN_IR_TC).toBe(FDCAN_IR_TC);
      expect(view.u32(0x4004) & FDCAN_IR_RF0N).toBe(FDCAN_IR_RF0N);
      expect(view.u32(0x4008) & FDCAN_RXF0S_F0FL).toBe(1);
      expect(view.u32(0x400c) & 1).toBe(1);
      expect(view.u32(0x4010) >>> 18).toBe(0x123);
      expect((view.u32(0x4014) >>> 16) & 0xf).toBe(8);
      expect(view.u32(0x4018)).toBe(0x44332211);
      expect(view.u32(0x401c)).toBe(0x88776655);
      expect(view.u32(0x4020)).toBeGreaterThanOrEqual(1);
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });
});
