import { describe, expect, it } from 'vitest';
import { firmware } from './harness';
import { runMcu } from './mcu-harness';

describe('UCPD1 复位', () => {
  it('SYSRESETREQ 后 CFG1/CR/IMR/SR 清零', async () => {
    const view = await runMcu({ firmware: firmware('ucpd-reset.bin'), durationPs: 1_000_000_000 });

    try {
      expect(view.u32(0x4014)).toBe(1);
      expect(view.u32(0x4004)).toBe(0);
      expect(view.u32(0x4008)).toBe(0);
      expect(view.u32(0x400c)).toBe(0);
      expect(view.u32(0x4010)).toBe(0);
      expect(view.faults).toEqual([]);
    } finally {
      view.dispose();
    }
  });
});
