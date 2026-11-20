import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFusedCt107dBoard } from '../bench/fused';
import { assemble } from './fixtures/8051/assemble';
import { MCU_PIN } from '../device/src/nets';

const firmware = (name: string): Uint8Array =>
  assemble(readFileSync(join(import.meta.dirname, 'fixtures', '8051', `${name}.asm`), 'utf8'));

const P20 = MCU_PIN.P2_0.drive;
const P33 = MCU_PIN.P3_3.drive;
const P36 = MCU_PIN.P3_6.drive;

describe('fused MCU resistor contract', () => {
  it('keeps quasi-bidirectional pull-up weak, push-pull high strong and open-drain release unknown', async () => {
    const fused = await createFusedCt107dBoard({ firmware: firmware('resistor-mixed') });
    try {
      fused.methods.setSwitch!({ designator: 'S4', pressed: true });
      fused.board.runUntil(1_000_000_000);
      const drives = fused.fusedMcuDrives();
      const pins = fused.fusedPins();

      // 8051 quasi-bidirectional latch=1 is 10 kΩ weak high, but S4 is a strong low.
      expect(drives[P33]).toBe(2);
      expect(pins[P33]).toBe(0);

      // Push-pull high is 25 Ω strong and wins over the I²C devices' 1 MΩ weak low.
      expect(drives[P20]).toBe(1);
      expect(pins[P20]).toBe(1);

      // Open-drain release has no external driver on P3.6, so the net is unknown.
      expect(drives[P36]).toBe(4);
      expect(pins[P36]).toBe(2);
    } finally {
      fused.dispose();
    }
  }, 60_000);

  it('resolves open-drain release against a weak pull-down as low', async () => {
    const fused = await createFusedCt107dBoard({ firmware: firmware('resistor-opendrain') });
    try {
      fused.board.runUntil(1_000_000_000);
      const drives = fused.fusedMcuDrives();
      const pins = fused.fusedPins();

      expect(drives[P20]).toBe(4);
      expect(pins[P20]).toBe(0);
    } finally {
      fused.dispose();
    }
  }, 60_000);
});
