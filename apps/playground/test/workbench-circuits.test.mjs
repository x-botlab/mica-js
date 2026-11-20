import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCt117eCircuit } from '../scripts/workbench-circuits.mjs';
import assets from '../workbench-assets.json' with { type: 'json' };

test('CT117E-M4 LCD demo uses one locked board and the LCD HEX asset', () => {
  const lock = {
    id: 'example:ct117e-m4',
    version: '0.1.0',
    integrity: `sha256:${'ab'.repeat(32)}`,
  };
  const circuit = createCt117eCircuit(lock);
  assert.equal(circuit.version, 2);
  assert.deepEqual(circuit.dependencies, {
    [lock.id]: { version: lock.version, integrity: lock.integrity },
  });
  assert.equal(circuit.instances.length, 1);
  const [board] = circuit.instances;
  assert.equal(board.device, lock.id);
  assert.equal(board.properties.clockFrequency, 80_000_000);
  assert.deepEqual(board.properties.firmware, assets.ct117eFirmware);
  assert.equal(board.properties.firmware.name, 'HAL_06_LCD.hex');
  assert.deepEqual(circuit.wires, []);
  assert.deepEqual(
    circuit.references.map(({ target, voltage }) => [target.instance, target.pin, voltage]),
    [
      [board.id, 'VDD1', 3.3],
      [board.id, 'VSS1', 0],
    ],
  );
});
