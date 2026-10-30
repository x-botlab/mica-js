import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { parseSchematic } from '@mica-js/core/schematic';
import { toNumber, type FloatBits } from '@mica-js/ir';
import { Circuit, createCircuitFromSchematic, createSchematicDeviceSimulationHost } from './index';
import type { DeviceConfig, DeviceDescription, SimulationPublish } from './index';
import { loadDeviceLibrary } from '../../../apps/playground/src/sim/device-library';
import type {
  DeviceLibrary,
  DeviceLibraryFiles,
} from '../../../apps/playground/src/sim/device-library';
import {
  DEMO_ELECTRICAL,
  loadDeviceFactories,
} from '../../../apps/playground/src/sim/device-implementations';
import {
  createContractBinding,
  createContractDevice,
} from '../../../apps/playground/src/sim/device-contracts';

const publicRoot = resolve(import.meta.dirname, '../../../apps/playground/public');
const files: DeviceLibraryFiles = {
  label: 'demo',
  read: (path) => readFile(resolve(publicRoot, 'devices', path)),
};
let library: DeviceLibrary;
let factories: Awaited<ReturnType<typeof loadDeviceFactories>>;
beforeAll(async () => {
  library = await loadDeviceLibrary(files);
  factories = await loadDeviceFactories(files, library);
});
function device(name: string, id = name): DeviceConfig {
  const entry = library.find(`demo:${name}`)!;
  return createContractDevice(entry, id, factories.get(entry.reference)!)!;
}
function voltage(circuit: Circuit, pin: string, expected: number) {
  const value = circuit.getVoltage(pin);
  expect(value.state).toBe('determinate');
  if (value.state === 'determinate') expect(value.value).toBeCloseTo(expected, 10);
}
const load: DeviceDescription = {
  pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
  resistors: { body: { pins: ['A', 'B'] } },
  factory: ({ electrical }) => {
    electrical.initializeResistor('body', { resistance: 1000, enabled: true });
  },
};

test('requires valid paired JS files and keeps metadata loading independent', async () => {
  expect(library.entries).toHaveLength(6);
  expect(factories.size).toBe(6);
  await expect(
    loadDeviceFactories(
      {
        ...files,
        read: async () => {
          throw new Error('missing');
        },
      },
      library,
    ),
  ).rejects.toThrow('paired implementation');
  await expect(
    loadDeviceFactories(
      { ...files, read: async () => new TextEncoder().encode('export default 42;') },
      library,
    ),
  ).rejects.toThrow('invalid paired implementation');
});

describe.each(['reference', 'jit'] as const)('%s actual Playground factories', (engine) => {
  test('updates both potentiometer branches with real loading, endpoint resistance and reset', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { ...device('potentiometer', 'pot'), properties: { initialPosition: 0.2 } },
          { id: 'load', type: 'load', description: load },
        ],
        connections: [
          { from: 'pot.A', to: 'VDD' },
          { from: 'pot.B', to: 'GND' },
          { from: 'pot.W', to: 'load.A' },
          { from: 'load.B', to: 'GND' },
        ],
      },
      { engine, electrical: DEMO_ELECTRICAL },
    );
    const expected = (p: number) => {
      const lower = 1 / (1 / (10 + 10000 * p) + 1 / 1000);
      return (5 * lower) / (10 + 10000 * (1 - p) + lower);
    };
    try {
      voltage(circuit, 'pot.W', expected(0.2));
      circuit.devices['pot']!.setState('position', 0.8);
      voltage(circuit, 'pot.W', expected(0.2));
      circuit.step();
      voltage(circuit, 'pot.W', expected(0.8));
      const upper = circuit.getCurrent('pot.upper');
      const lower = circuit.getCurrent('pot.lower');
      const current = circuit.getCurrent('load.body');
      if (
        upper.state !== 'determinate' ||
        lower.state !== 'determinate' ||
        current.state !== 'determinate'
      )
        throw new Error('Expected determined branch currents');
      expect(upper.value).toBeCloseTo(lower.value + current.value, 12);
      for (const position of [0, 1]) {
        circuit.devices['pot']!.setState('position', position);
        circuit.step();
        voltage(circuit, 'pot.W', expected(position));
      }
      circuit.reset();
      voltage(circuit, 'pot.W', expected(0.2));
      expect(toNumber(circuit.devices['pot']!.getState('position') as FloatBits)).toBe(0.2);
    } finally {
      circuit.dispose();
    }
  });

  test.each([false, true])(
    'button conducts bidirectionally with reversed supply=%s',
    async (reverse) => {
      const circuit = await Circuit.create(
        {
          devices: [
            device('ideal-button', 'button'),
            { id: 'load', type: 'load', description: load },
          ],
          connections: [
            { from: `button.${reverse ? 'B' : 'A'}`, to: 'VDD' },
            { from: `button.${reverse ? 'A' : 'B'}`, to: 'load.A' },
            { from: 'load.B', to: 'GND' },
          ],
        },
        { engine, electrical: DEMO_ELECTRICAL },
      );
      try {
        voltage(circuit, 'load.A', 0);
        circuit.devices['button']!.setState('pressed', true);
        circuit.step();
        voltage(circuit, 'load.A', 5);
        expect(circuit.devices['button']!.getState('closed')).toBe(true);
        expect(circuit.devices['button']!.getState('pressCount')).toBe(1);
        circuit.devices['button']!.setState('pressed', false);
        circuit.step();
        voltage(circuit, 'load.A', 0);
      } finally {
        circuit.dispose();
      }
    },
  );

  test('mechanical closure does not fabricate power, and debounce counts consecutive ticks', async () => {
    const circuit = await Circuit.create(
      { devices: [device('debounced-button', 'button')], connections: [] },
      { engine, electrical: DEMO_ELECTRICAL },
    );
    try {
      circuit.devices['button']!.setState('pressed', true);
      circuit.runBatch(2);
      expect(circuit.devices['button']!.getState('closed')).toBe(false);
      circuit.devices['button']!.setState('pressed', false);
      circuit.step();
      circuit.devices['button']!.setState('pressed', true);
      circuit.runBatch(2);
      expect(circuit.devices['button']!.getState('closed')).toBe(false);
      circuit.step();
      expect(circuit.devices['button']!.getState('closed')).toBe(true);
      expect(circuit.getVoltage('button.A')).toEqual({ state: 'floating' });
      expect(circuit.getVoltage('button.B')).toEqual({ state: 'floating' });
      circuit.reset();
      expect(circuit.devices['button']!.getState('closed')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  test('relay switches two opposite-powered throws atomically and accepts reverse conduction', async () => {
    const circuit = await Circuit.create(
      {
        devices: [device('ideal-relay', 'relay')],
        connections: [
          { from: 'relay.IN', to: 'VDD' },
          { from: 'relay.NO', to: 'VDD' },
          { from: 'relay.NC', to: 'GND' },
        ],
      },
      { engine, electrical: DEMO_ELECTRICAL },
    );
    try {
      voltage(circuit, 'relay.COM', 0);
      circuit.step();
      expect(circuit.tickCount).toBe(1n);
      voltage(circuit, 'relay.COM', 5);
      voltage(circuit, 'relay.NC', 0);
      expect(circuit.devices['relay']!.getState('energized')).toBe(true);
      circuit.reset();
      voltage(circuit, 'relay.COM', 0);
    } finally {
      circuit.dispose();
    }
    const floating = await Circuit.create(
      { devices: [device('ideal-relay', 'relay')], connections: [{ from: 'relay.IN', to: 'VDD' }] },
      { engine, electrical: DEMO_ELECTRICAL },
    );
    try {
      floating.step();
      expect(floating.getVoltage('relay.COM')).toEqual({ state: 'floating' });
      expect(floating.getVoltage('relay.NO')).toEqual({ state: 'floating' });
    } finally {
      floating.dispose();
    }
  });

  test('MCU drives through finite resistance and LED senses the solved node', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          device('teaching-mcu', 'mcu'),
          device('ideal-led', 'led'),
          { id: 'load', type: 'load', description: load },
        ],
        connections: [
          { from: 'mcu.PA0', to: 'led.anode' },
          { from: 'mcu.PA0', to: 'load.A' },
          { from: 'load.B', to: 'GND' },
          { from: 'led.cathode', to: 'GND' },
        ],
      },
      { engine, electrical: DEMO_ELECTRICAL },
    );
    try {
      voltage(circuit, 'mcu.PA0', 0);
      circuit.step();
      voltage(circuit, 'mcu.PA0', (5 * 1000) / 1050);
      expect(circuit.devices['led']!.getState('lamp')).toBe(true);
      circuit.step();
      voltage(circuit, 'mcu.PA0', 0);
      expect(circuit.devices['led']!.getState('lamp')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  test.each(['device-bench.sch', 'button-relay.sch'])(
    'compiles and executes existing %s without legacy models',
    async (name) => {
      const schematic = parseSchematic(
        await readFile(resolve(publicRoot, 'schematics', name), 'utf8'),
      );
      const circuit = await createCircuitFromSchematic(schematic, {
        engine,
        electrical: DEMO_ELECTRICAL,
        devices: library.symbols,
        resolveDevice: (reference) => {
          const entry = library.find(reference.raw);
          return entry === undefined
            ? undefined
            : createContractBinding(entry, factories.get(entry.reference)!);
        },
      });
      try {
        circuit.runBatch(4);
        expect(circuit.tickCount).toBe(4n);
      } finally {
        circuit.dispose();
      }
    },
  );
});

test('existing host queues potentiometer input, publishes numbers on change and resets', async () => {
  const id = randomUUID();
  const schematic = {
    version: 1,
    sheet: {
      symbols: [
        {
          id,
          device: 'demo:potentiometer',
          designator: 'RV1',
          x: 0,
          y: 0,
          rotation: 0,
          properties: { initialPosition: 0.2 },
        },
      ],
      wires: [],
      junctions: [],
    },
  };
  const entry = library.find('demo:potentiometer')!;
  const host = createSchematicDeviceSimulationHost({
    electrical: DEMO_ELECTRICAL,
    devices: library.symbols,
    read: async () => new TextEncoder().encode(JSON.stringify(schematic)),
    resolveDevice: () => createContractBinding(entry, factories.get(entry.reference)!),
  });
  const publications: SimulationPublish[] = [];
  const subscription = host.onDidPublish((event) => publications.push(event));
  const target = { symbol: id, port: 'position' };
  try {
    await host.loadSchematic('file:///pot.sch');
    await host.tick(10);
    expect(publications.map((event) => event.payload)).toEqual([0.2]);
    await host.deliver(target, 0.8);
    expect(publications).toHaveLength(1);
    await host.tick(10);
    expect(publications.map((event) => event.payload)).toEqual([0.2, 0.8]);
    await host.tick(10);
    expect(publications).toHaveLength(2);
    for (const value of [NaN, Infinity, -0.1, 1.1]) {
      await host.deliver(target, value);
      await expect(host.tick(10)).rejects.toThrow(/finite|\[0, 1\]/);
      expect(await host.getSimTime()).toBe(30);
    }
    await expect(host.deliver(target, 'bad')).rejects.toThrow();
    await host.reset();
    await host.tick(10);
    expect(publications.map((event) => event.payload)).toEqual([0.2, 0.8, 0.2]);
  } finally {
    subscription.dispose();
    await host.dispose();
  }
});
