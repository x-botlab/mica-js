import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseSchematic } from '@mica-js/core/schematic';
import { parseCanvas } from '@mica-js/core/canvas';
import { toNumber, type FloatBits } from '@mica-js/ir';
import {
  createCircuitFromSchematic,
  createSchematicDeviceSimulationHost,
  type Circuit,
  type SimulationPublish,
} from './index';
import {
  loadDeviceLibrary,
  PLAYGROUND_DEVICE_EXTENSIONS,
} from '../../../apps/playground/src/sim/device-library';
import {
  DEMO_ELECTRICAL,
  loadDeviceFactories,
} from '../../../apps/playground/src/sim/device-implementations';
import { createContractBinding } from '../../../apps/playground/src/sim/device-contracts';
import {
  canvasExampleById,
  schematicExampleById,
} from '../../../apps/playground/src/examples/registry';

const root = resolve(import.meta.dirname, '../../../apps/playground/public');
const files = { label: 'demo', read: (path: string) => readFile(resolve(root, 'devices', path)) };
let library: Awaited<ReturnType<typeof loadDeviceLibrary>>;
let factories: Awaited<ReturnType<typeof loadDeviceFactories>>;
let schematic: ReturnType<typeof parseSchematic>;
const dt = 25_000_000_000; // The real WidgetHost's 25 ms step, in picoseconds.
beforeAll(async () => {
  library = await loadDeviceLibrary(files, PLAYGROUND_DEVICE_EXTENSIONS);
  factories = await loadDeviceFactories(files, library);
  schematic = parseSchematic(await readFile(resolve(root, 'schematics/teaching-i2c.sch'), 'utf8'));
});

async function create(engine: 'reference' | 'jit', slave = true) {
  return createCircuitFromSchematic(
    slave
      ? schematic
      : {
          ...schematic,
          sheet: {
            ...schematic.sheet,
            symbols: schematic.sheet.symbols.filter((s) => s.designator !== 'U2'),
          },
        },
    {
      engine,
      electrical: DEMO_ELECTRICAL,
      devices: library.symbols,
      resolveDevice: (reference) => {
        const entry = library.find(reference.raw);
        return entry && createContractBinding(entry, factories.get(entry.reference)!);
      },
    },
  );
}
function voltage(circuit: Circuit, pin: string): number {
  const sample = circuit.getVoltage(pin);
  if (sample.state !== 'determinate') throw new Error(`${pin}: ${sample.state}`);
  return sample.value;
}
function state(circuit: Circuit, id: string, name: string) {
  return circuit.devices[id]!.getState(name);
}
function brightness(circuit: Circuit, id: string) {
  return toNumber(state(circuit, id, 'brightness') as FloatBits);
}

test('routes and actual canvas bindings identify both finite bus indicators', async () => {
  expect(schematicExampleById('teaching-i2c').document).toBe('schematics/teaching-i2c.sch');
  const canvasExample = canvasExampleById('teaching-i2c');
  const canvas = parseCanvas(await readFile(resolve(root, canvasExample.document), 'utf8'));
  expect(canvas.schematic).toBe('schematics/teaching-i2c.sch');
  expect(canvas.widgets.map((widget) => widget.bindings?.['brightness'])).toEqual([
    { symbol: 'c1000000-0000-4000-8000-000000000005', port: 'brightness' },
    { symbol: 'c1000000-0000-4000-8000-000000000006', port: 'brightness' },
  ]);
});

test('unchanged simulation host publishes actual per-device counters and bound LED brightness', async () => {
  const host = createSchematicDeviceSimulationHost({
    electrical: DEMO_ELECTRICAL,
    devices: library.symbols,
    read: async () => new TextEncoder().encode(JSON.stringify(schematic)),
    resolveDevice: (reference) => {
      const entry = library.find(reference.raw);
      return entry && createContractBinding(entry, factories.get(entry.reference)!);
    },
  });
  const events: SimulationPublish[] = [];
  const subscription = host.onDidPublish((event) => events.push(event));
  const latest = (suffix: string, port: string) =>
    events
      .filter((event) => event.target.symbol.endsWith(suffix) && event.target.port === port)
      .at(-1)?.payload;
  try {
    await host.loadSchematic('schematics/teaching-i2c.sch');
    for (let tick = 0; tick < 420; tick++) await host.tick(dt);
    expect(await host.getSimTime()).toBe(420 * dt);
    for (const suffix of ['0001', '0002']) {
      expect(latest(suffix, 'count')).toBe(1);
      expect(latest(suffix, 'addressAcks')).toBe(1);
      expect(latest(suffix, 'dataAcks')).toBe(1);
    }
    expect(latest('0001', 'nacks')).toBe(0);
    expect(latest('0002', 'received')).toBe(0);
    expect(latest('0002', 'stops')).toBe(1);
    for (const suffix of ['0005', '0006']) {
      expect(latest(suffix, 'brightness')).toBeCloseTo(100000 / 104700, 10);
    }
    await host.reset();
    await host.tick(dt);
    expect(latest('0001', 'count')).toBe(0);
    expect(latest('0002', 'count')).toBe(0);
  } finally {
    subscription.dispose();
    await host.dispose();
  }
}, 30000);

describe.each(['reference', 'jit'] as const)('%s physical bit-banged I2C', (engine) => {
  test('decodes three incrementing writes and both ACKs from real bus voltages', async () => {
    const circuit = await create(engine);
    try {
      const high = (5 * 100000) / 104700;
      expect(voltage(circuit, 'U1.SDA')).toBeCloseTo(high, 10);
      expect(voltage(circuit, 'U1.SCL')).toBeCloseTo(high, 10);
      expect(circuit.getPin('U2.SDA')).toBe(true);
      expect(circuit.getPin('U2.SCL')).toBe(true);
      let previousSda = true;
      let previousScl = true;
      let bits: number[] | undefined;
      const transfers: number[][] = [];
      const starts: number[] = [];
      const stops: number[] = [];
      const clockEdges: number[] = [];
      let lows = 0;
      let highs = 0;
      for (let tick = 1; tick <= 1300; tick++) {
        circuit.step(dt);
        const sda = circuit.getPin('U1.SDA');
        const scl = circuit.getPin('U1.SCL');
        expect(circuit.getPin('U2.SDA')).toBe(sda);
        expect(circuit.getPin('U2.SCL')).toBe(scl);
        for (const [name, level, led] of [
          ['SDA', sda, 'D1'],
          ['SCL', scl, 'D2'],
        ] as const) {
          const volts = voltage(circuit, `U1.${name}`);
          if (level) {
            expect(volts).toBeCloseTo(high, 10);
            highs++;
          } else {
            expect(volts).toBeLessThan(0.06);
            expect(volts).toBeGreaterThan(0);
            lows++;
          }
          expect(brightness(circuit, led)).toBeCloseTo(volts / 5, 10);
          expect(state(circuit, led, 'lamp')).toBe(level);
        }
        if (previousSda && !sda && previousScl && scl) {
          starts.push(tick);
          bits = [];
        }
        if (!previousSda && sda && previousScl && scl) {
          stops.push(tick);
          if (bits) transfers.push(bits);
          bits = undefined;
        }
        if (!previousScl && scl && bits) bits.push(Number(sda));
        if (previousScl !== scl) clockEdges.push(tick);
        previousSda = sda;
        previousScl = scl;
      }
      expect(starts).toEqual([20, 460, 900]);
      expect(stops).toEqual([410, 850, 1290]);
      expect(transfers).toHaveLength(3);
      for (let byte = 0; byte < 3; byte++) {
        // STOP preparation raises SCL once more after the two nine-clock bytes.
        const frame = transfers[byte]!;
        expect(frame).toHaveLength(19);
        expect(parseInt(frame.slice(0, 8).join(''), 2)).toBe(0x84);
        expect(frame[8]).toBe(0); // Address ACK is electrically asserted by U2.
        expect(parseInt(frame.slice(9, 17).join(''), 2)).toBe(byte);
        expect(frame[17]).toBe(0); // Data ACK.
        const edges = clockEdges.filter((tick) => tick > starts[byte]! && tick < stops[byte]!);
        for (let i = 1; i < edges.length; i++) expect(edges[i]! - edges[i - 1]!).toBe(10);
      }
      expect(lows).toBeGreaterThan(0);
      expect(highs).toBeGreaterThan(0);
      expect(state(circuit, 'U1', 'sentCount')).toBe(3);
      expect(state(circuit, 'U1', 'lastSent')).toBe(2);
      expect(state(circuit, 'U1', 'nacks')).toBe(0);
      expect(state(circuit, 'U2', 'receivedCount')).toBe(3);
      expect(state(circuit, 'U2', 'received')).toBe(2);
      for (const id of ['U1', 'U2']) {
        expect(state(circuit, id, 'addressAcks')).toBe(3);
        expect(state(circuit, id, 'dataAcks')).toBe(3);
      }
      expect(state(circuit, 'U2', 'starts')).toBe(3);
      expect(state(circuit, 'U2', 'stops')).toBe(3);
      expect(circuit.getPin('U1.SDA')).toBe(true);
      expect(circuit.getPin('U1.SCL')).toBe(true);
      circuit.reset();
      expect(state(circuit, 'U1', 'sentCount')).toBe(0);
      expect(state(circuit, 'U2', 'receivedCount')).toBe(0);
      expect(voltage(circuit, 'U1.SDA')).toBeCloseTo(high, 10);
      expect(voltage(circuit, 'U1.SCL')).toBeCloseTo(high, 10);
    } finally {
      circuit.dispose();
    }
  }, 30000);

  test('missing physical slave produces a sampled NACK, STOP, and no successful write', async () => {
    const circuit = await create(engine, false);
    try {
      circuit.runBatch(250, dt);
      expect(state(circuit, 'U1', 'nacks')).toBe(1);
      expect(state(circuit, 'U1', 'addressAcks')).toBe(0);
      expect(state(circuit, 'U1', 'dataAcks')).toBe(0);
      expect(state(circuit, 'U1', 'sentCount')).toBe(0);
      expect(state(circuit, 'U1', 'byte')).toBe(0);
      expect(circuit.getPin('U1.SDA')).toBe(true);
      expect(circuit.getPin('U1.SCL')).toBe(true);
    } finally {
      circuit.dispose();
    }
  }, 30000);
});
