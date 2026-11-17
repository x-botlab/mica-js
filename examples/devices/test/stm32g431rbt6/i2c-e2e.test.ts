import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createI2cCircuit } from './i2c-harness';

const firmware = new Uint8Array(
  readFileSync(join(import.meta.dirname, 'fixtures', 'i2c-e2e.bin')),
);

describe('STM32G431RBT6 I2C1 PB8/PB7 与 AT24C02/MCP4017 共线', () => {
  it('主机写 EEPROM、重复 START 随机读、写/读 MCP wiper 都经真实引脚与总线', async () => {
    const circuit = await createI2cCircuit({ firmware, clockFrequency: 16_000_000 });

    try {
      for (let step = 0; step < 40; step += 1) circuit.run(1_000_000_000);

      const dump = (await circuit.query('eeprom', 'getDump')) as Uint8Array;
      const wiper = (await circuit.query('pot', 'getWiper')) as number;

      expect(circuit.faults).toEqual([]);
      expect([...dump.subarray(0, 4)]).toEqual([0x5a, 0x00, 0x00, 0x00]);
      expect(wiper).toBe(0x60);
    } finally {
      circuit.dispose();
    }
  });
});
