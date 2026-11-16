import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegisterFacts } from '@mica-js/stm32g431rbt6-core/register-facts';

const FIRMWARE = join(import.meta.dirname, '..', 'ili9325', 'fixtures', 'HAL_06_LCD.bin');

describe('STM32 register facts across service continuations', () => {
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
