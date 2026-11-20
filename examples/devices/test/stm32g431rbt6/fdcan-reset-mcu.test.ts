import { describe, expect, it } from 'vitest';
import { firmware } from './harness';
import { runMcu } from './mcu-harness';

describe('FDCAN1 复位', () => {
  it('SYSRESETREQ 后寄存器回到 RM 复位值', async () => {
    const view = await runMcu({ firmware: firmware('fdcan-reset.bin'), durationPs: 1_000_000_000 });

    try {
      expect(view.u32(0x4014)).toBe(1);
      expect(view.u32(0x4004)).toBe(0x32141218);
      expect(view.u32(0x4008)).toBe(1);
      expect(view.u32(0x400c)).toBe(3);
      expect(view.u32(0x4010)).toBe(0x1fffffff);
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });
});
