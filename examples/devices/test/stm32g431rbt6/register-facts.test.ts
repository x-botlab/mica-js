import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';

const FIRMWARE = join(import.meta.dirname, '..', 'ili9325', 'fixtures', 'HAL_06_LCD.bin');

describe('STM32 register facts across service continuations', () => {
  it('invalidates the base register after post-index writeback', () => {
    const firmware = new Uint8Array([
      0x00, 0x10, 0x00, 0x20, // initial SP
      0x09, 0x00, 0x00, 0x08, // reset = 0x08000009
      0x02, 0x49, // ldr r1,[pc,#8]
      0x11, 0xf8, 0x02, 0x2b, // ldrb r2,[r1],#2
      0x01, 0x23, // movs r3,#1
      0x70, 0x47, // bx lr
      0x00, 0x00,
      0x00, 0x02, 0x00, 0x20, // literal 0x20000200
    ]);
    const facts = createRegisterFacts(firmware, firmware.byteLength);
    const atBranch = facts.at(0x10);

    expect(atBranch?.[1], 'r1 after post-index writeback').toBeUndefined();
    expect(atBranch?.[3], 'r3 after movs').toBe(1);
  });

  it('carries GPIOB literals into blocks resumed inside the same function', () => {
    const firmware = new Uint8Array(readFileSync(FIRMWARE));
    const facts = createRegisterFacts(firmware, firmware.byteLength);

    for (const pc of [
      0x0800_110e, 0x0800_111a, 0x0800_1126, 0x0800_112e, 0x0800_113c, 0x0800_1144,
    ]) {
      const registers = facts.at(pc);

      expect(registers?.[2], `r2 at ${pc.toString(16)}`).toBe(0x4800_0428);
      expect(registers?.[1], `r1 at ${pc.toString(16)}`).toBe(
        pc === 0x0800_110e ? 0x200 : 0x4800_0418,
      );
    }
  });
});
