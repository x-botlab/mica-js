import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GROUND_DEVICE, POWER_DEVICE, parseSchematic } from '@mica-js/core/schematic';
import type { DeviceSymbolProvider } from '@mica-js/core/schematic';
import {
  Circuit,
  createCircuitFromSchematic,
  createCircuitDeviceSimulationHost,
  createSchematicDeviceSimulationHost,
  compileCircuit,
  PIN_MODE,
} from './index';
import type { DeviceDescription, CircuitCompilationInput, ElectricalFactoryContext } from './index';

const electrical = { sources: { VDD: { voltage: 5 } }, interpretation: 'two-state' } as const;

async function resistorDescription(): Promise<DeviceDescription> {
  const document = readFileSync(
    resolve(import.meta.dirname, '..', '..', '..', 'docs', 'rfc', '0005-device-definition.md'),
    'utf8',
  );
  const definition = [...document.matchAll(/```json\r?\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]!) as DeviceDescription)
    .find((value) => value.resistors !== undefined)!;
  const source = /```js\r?\n([\s\S]*?)```/.exec(document)![1]!;
  const { default: factory } = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  )) as { default: (context: ElectricalFactoryContext) => void };
  return { ...definition, factory };
}

function divider(description: DeviceDescription): CircuitCompilationInput {
  return {
    devices: [
      { id: 'R1', type: 'resistor', description, properties: { resistance: 3300 } },
      { id: 'R2', type: 'resistor', description, properties: { resistance: 1100 } },
    ],
    connections: [
      { from: 'R1.A', to: 'VDD' },
      { from: 'R1.B', to: 'R2.A' },
      { from: 'R2.B', to: 'GND' },
    ],
  };
}

function assertDivider(circuit: Circuit, expected = 1.25) {
  expect(circuit.getVoltage('R1.A')).toEqual({ state: 'determinate', value: 5 });
  expect(circuit.getVoltage('R2.B')).toEqual({ state: 'determinate', value: 0 });
  const voltage = circuit.getVoltage('R1.B');
  expect(voltage.state).toBe('determinate');
  if (voltage.state === 'determinate') expect(voltage.value).toBeCloseTo(expected, 12);
  const current = circuit.getCurrent('R2.body');
  expect(current.state).toBe('determinate');
  if (current.state === 'determinate') expect(current.value).toBeCloseTo(expected / 1100, 12);
}

describe.each(['reference', 'jit'] as const)('%s public resistive circuit', (engine) => {
  test('loads the RFC JSON/JS pair once per instance and solves without a tick behavior', async () => {
    const base = await resistorDescription();
    const properties: ElectricalFactoryContext['properties'][] = [];
    const description = {
      ...base,
      factory: (context: ElectricalFactoryContext) => {
        properties.push(context.properties);
        base.factory!(context);
      },
    };
    const circuit = await Circuit.create(divider(description), { engine, electrical });
    try {
      expect(properties.map((value) => value['resistance'])).toEqual([3300, 1100]);
      expect(properties[0]).not.toBe(properties[1]);
      expect(Object.isFrozen(properties[0])).toBe(true);
      assertDivider(circuit);
      expect(circuit.tickCount).toBe(0n);
      circuit.step();
      circuit.runBatch(3);
      assertDivider(circuit);
      expect(circuit.tickCount).toBe(4n);
      circuit.reset();
      assertDivider(circuit);
      expect(circuit.tickCount).toBe(0n);
      expect(properties).toHaveLength(2);
      expect(() => circuit.setPin('R1.A', false)).toThrow('typed IR');
      expect(() => circuit.devices['R1']!.writePin('A', false)).toThrow('typed IR');
      expect(() => circuit.getPin('R1.A')).toThrow('no digital input');
      expect(() => circuit.getCurrent('R1.missing')).toThrow('Unknown resistor');
    } finally {
      circuit.dispose();
    }
    expect(() => circuit.getVoltage('R1.B')).toThrow('disposed');
  });

  test('applies state-driven resistance only through IR and restores the initial solve on reset', async () => {
    const base = await resistorDescription();
    const input = divider(base);
    const first = input.devices[0]!;
    const circuit = await Circuit.create(
      {
        ...input,
        devices: [
          {
            ...first,
            description: {
              ...base,
              states: { ohms: { type: 'f64', initial: 3300 } },
              factory: (context) => {
                base.factory!(context);
                return {
                  tick: (api) =>
                    api.resistor('body').setResistance(api.state<'f64'>('ohms').load()),
                };
              },
            },
          },
          input.devices[1]!,
        ],
      },
      { engine, electrical },
    );
    try {
      circuit.devices['R1']!.setState('ohms', 1100);
      assertDivider(circuit);
      circuit.step();
      assertDivider(circuit, 2.5);
      circuit.devices['R1']!.setState('ohms', -1);
      const host = createCircuitDeviceSimulationHost({
        circuit,
        ownsCircuit: false,
        deliver: () => undefined,
      });
      expect(await host.tick(10_000)).toEqual({ simTime: 10_000, executed: 0 });
      await host.dispose();
      circuit.runBatch(4);
      expect(circuit.tickCount).toBe(1n);
      assertDivider(circuit, 2.5);
      circuit.reset();
      assertDivider(circuit);
      expect(circuit.tickCount).toBe(0n);
      circuit.step();
      assertDivider(circuit);
      expect(circuit.tickCount).toBe(1n);
    } finally {
      circuit.dispose();
    }
  });

  test('loads per-symbol properties and explicit power through the real schematic factory', async () => {
    const description = await resistorDescription();
    const schematic = parseSchematic(
      JSON.stringify({
        version: 1,
        sheet: {
          symbols: [
            {
              id: randomUUID(),
              device: 'test:resistor',
              designator: 'R1',
              x: 0,
              y: 0,
              rotation: 0,
              properties: { resistance: 3300 },
            },
            {
              id: randomUUID(),
              device: 'test:resistor',
              designator: 'R2',
              x: 0,
              y: 40,
              rotation: 0,
              properties: { resistance: 1100 },
            },
            { id: randomUUID(), device: POWER_DEVICE, x: 0, y: -20, rotation: 0, net: 'VDD' },
            { id: randomUUID(), device: GROUND_DEVICE, x: 0, y: 80, rotation: 0, net: 'GND' },
          ],
          wires: [
            {
              id: randomUUID(),
              points: [
                { x: 0, y: -20 },
                { x: 0, y: 0 },
              ],
            },
            {
              id: randomUUID(),
              points: [
                { x: 0, y: 20 },
                { x: 0, y: 40 },
              ],
            },
            {
              id: randomUUID(),
              points: [
                { x: 0, y: 60 },
                { x: 0, y: 80 },
              ],
            },
          ],
          junctions: [],
        },
      }),
    );
    const devices: DeviceSymbolProvider = {
      getDeviceSymbol: () => ({
        name: 'resistor',
        pins: { A: { x: 0, y: 0 }, B: { x: 0, y: 20 } },
      }),
      getDeviceName: () => 'resistor',
    };
    const circuit = await createCircuitFromSchematic(schematic, {
      engine,
      electrical,
      devices,
      resolveDevice: () => ({ type: 'resistor', description }),
    });
    try {
      assertDivider(circuit);
      circuit.runBatch(2);
      circuit.reset();
      assertDivider(circuit);
    } finally {
      circuit.dispose();
    }
    const host = createSchematicDeviceSimulationHost({
      electrical,
      devices,
      read: async () => new TextEncoder().encode(JSON.stringify(schematic)),
      resolveDevice: () => ({
        type: 'resistor',
        description: {
          ...description,
          states: { attempted: { type: 'bool', initial: false } },
          factory: (context) => {
            description.factory!(context);
            return {
              tick: (api) => {
                const b = api.builder;
                const attempted = api.state<'bool'>('attempted');
                api
                  .resistor('body')
                  .setResistance(
                    b.select(
                      attempted.load(),
                      b.const('f64', -1),
                      b.const('f64', context.properties['resistance'] as number),
                    ),
                  );
                attempted.store(b.const('bool', true));
              },
            };
          },
        },
      }),
    });
    try {
      await host.loadSchematic('file:///divider.sch');
      expect(await host.tick(10)).toEqual({ simTime: 10, executed: 1 });
      expect(await host.tick(10)).toEqual({ simTime: 10, executed: 0 });
      expect(await host.getSimTime()).toBe(10);
      await host.reset();
      expect(await host.tick(10)).toEqual({ simTime: 10, executed: 1 });
    } finally {
      await host.dispose();
    }
    await expect(
      createCircuitFromSchematic(schematic, {
        engine,
        electrical: { interpretation: 'two-state' },
        devices,
        resolveDevice: () => ({ type: 'resistor', description }),
      }),
    ).rejects.toThrow('VDD');
  });

  test('keeps unconnected physical pins floating and reads typed GPIO samples', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          {
            id: 'gpio',
            type: 'gpio',
            description: {
              pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
              factory: ({ electrical }) => {
                electrical.initializePin('A', {
                  drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
                  input: { reference: { source: 'VDD' }, low: 0.3, high: 0.7 },
                });
                return {
                  initialize: (api) => {
                    const pin = api.pin('A');
                    pin.configure(PIN_MODE.pushPull);
                    pin.setOutputEnabled(api.builder.const('bool', true));
                    pin.writeDigital(api.builder.const('bool', true));
                  },
                };
              },
            },
          },
        ],
        connections: [],
      },
      { engine, electrical },
    );
    try {
      expect(circuit.getPin('gpio.A')).toBe(true);
      expect(circuit.devices.gpio.readPin('A')).toBe(true);
      expect(circuit.getVoltage('gpio.A')).toEqual({ state: 'determinate', value: 5 });
      expect(circuit.getVoltage('gpio.B')).toEqual({ state: 'floating' });
    } finally {
      circuit.dispose();
    }
  });
});

test.each([null, 0, { tick: 2 }, { unexpected: () => undefined }])(
  'rejects malformed JS factory results %#',
  async (result) => {
    const base = await resistorDescription();
    const description = {
      ...base,
      factory: ((context: ElectricalFactoryContext) => {
        base.factory!(context);
        return result;
      }) as unknown as NonNullable<DeviceDescription['factory']>,
    };
    expect(() => compileCircuit(divider(description), electrical)).toThrow(/factory|behavior/);
  },
);

test('rejects omitted factories, mixed models, implicit interpretation and legacy rails', async () => {
  const description = await resistorDescription();
  const input = divider(description);
  expect(() => compileCircuit(input)).toThrow('explicit digital interpretation');
  expect(() => compileCircuit(input, { ...electrical, rails: { VDD: true } })).toThrow(
    'boolean rails',
  );
  expect(() =>
    compileCircuit(
      {
        ...input,
        devices: [...input.devices, { id: 'old', type: 'old', description: { pins: {} } }],
      },
      electrical,
    ),
  ).toThrow('mixed legacy');
  expect(() =>
    compileCircuit(
      {
        ...input,
        devices: input.devices.map((device) => ({
          ...device,
          description: { pins: description.pins, resistors: description.resistors! },
        })),
      },
      electrical,
    ),
  ).toThrow('paired electrical factory');
});
