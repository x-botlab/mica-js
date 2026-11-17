import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpiCircuit } from './spi-harness';

const firmware = new Uint8Array(
  readFileSync(join(import.meta.dirname, 'fixtures', 'spi-dma-ch2.bin')),
);

/** 真实生产 SPI1 双通道 DMA：CH1 TX、CH2 RX，等到 CH2 TC 再结束。 */
describe('STM32G431RBT6 SPI1 CH2 RX DMA', () => {
  it('completes CH2 with TC, CNDTR=0 and the full loopback payload', async () => {
    const circuit = await createSpiCircuit({ firmware, clockFrequency: 16_000_000 });

    try {
      for (let step = 0; step < 20; step += 1) circuit.run(1_000_000_000);

      const sram = circuit.memory('sram')!;
      const view = new DataView(sram.buffer, sram.byteOffset, sram.byteLength);

      expect(circuit.faults).toEqual([]);
      expect(view.getUint32(0, true)).toBe(2);
      expect(view.getUint32(0x08, true)).toBe(0); // CH2 CNDTR after TC
      expect(view.getUint32(0x0c, true) & 0x20).toBe(0x20); // DMA1 ISR TCIF2
      expect([...sram.subarray(0x20, 0x24)]).toEqual([0x5a, 0xa5, 0x3c, 0xc3]);
    } finally {
      circuit.dispose();
    }
  });
});
