import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpiCircuit } from './spi-harness';

const firmware = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'spi-e2e.bin')));

describe('STM32G431RBT6 SPI1 真实固件回环', () => {
  it('8/16 位帧经 PA5/PA7/PA6 AF、服务节拍与总线完成', async () => {
    const circuit = await createSpiCircuit({ firmware, clockFrequency: 16_000_000 });

    try {
      for (let step = 0; step < 40; step += 1) circuit.run(1_000_000_000);

      const sram = circuit.memory('sram');
      const result = new DataView(sram!.buffer, sram!.byteOffset, sram!.byteLength).getUint32(0, true);

      expect(circuit.faults).toEqual([]);
      expect(result).toBe(2);
    } finally {
      circuit.dispose();
    }
  });
});
