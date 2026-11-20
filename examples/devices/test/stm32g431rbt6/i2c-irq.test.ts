import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createI2cCircuit } from './i2c-harness';

const firmware = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'i2c-irq.bin')));

describe('STM32G431RBT6 I2C1 错误中断 IRQ32', () => {
  it('NACKF 经 ISER1/IRQ32 进入处理程序并清标志', async () => {
    const circuit = await createI2cCircuit({ firmware, clockFrequency: 16_000_000 });

    try {
      for (let step = 0; step < 20; step += 1) circuit.run(1_000_000_000);

      const sram = circuit.memory('sram');
      const word = new DataView(sram!.buffer, sram!.byteOffset, sram!.byteLength).getUint32(0, true);

      expect(circuit.faults).toEqual([]);
      expect(word).toBe(1);
    } finally {
      circuit.dispose();
    }
  });
});
