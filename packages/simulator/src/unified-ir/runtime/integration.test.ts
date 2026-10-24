import { describe, expect, it } from 'vitest';
import {
  GROUND_DEVICE,
  SCHEMATIC_VERSION,
  type DeviceSymbolProvider,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { createLedDescription, createMcuDescription } from '../compiler';
import { Circuit } from './circuit';
import { createCircuitFromSchematic, createSingleDeviceCircuit } from './factory';
import { CircuitError } from './types';
import type { SchematicCircuitOptions } from './factory';
import {
  counterInput,
  latchMcuLedInput,
  mcuLedInput,
  multiDriverInput,
  twoPairInput,
} from './test-helpers';

describe('MCU + LED integration', () => {
  it('propagates every MCU pin toggle to the lamp', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(circuit.devices.led1.isOn()).toBe(false);

    circuit.step();
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(true);
    expect(circuit.getPin('mcu1.PA0')).toBe(true);
    expect(circuit.getPin('led1.anode')).toBe(true);
    expect(circuit.getPin('led1.cathode')).toBe(false);
    expect(circuit.devices.led1.isOn()).toBe(true);

    circuit.step();
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(false);
    expect(circuit.getPin('led1.anode')).toBe(false);
    expect(circuit.devices.led1.isOn()).toBe(false);

    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('keeps a host-driven pin level through batches', async () => {
    const circuit = await Circuit.create(latchMcuLedInput());

    circuit.devices.mcu1.writePin('PA0', true);
    circuit.runBatch(1000);

    expect(circuit.tickCount).toBe(1000n);
    expect(circuit.devices.led1.isOn()).toBe(true);
    expect(circuit.getPin('led1.anode')).toBe(true);

    circuit.devices.mcu1.writePin('PA0', false);
    circuit.runBatch(1);
    expect(circuit.devices.led1.isOn()).toBe(false);
  });

  it('executes every tick of a large batch', async () => {
    const circuit = await Circuit.create(counterInput());

    circuit.runBatch(1_000_000);

    expect(circuit.tickCount).toBe(1_000_000n);
    expect(circuit.devices.count1.getState('count')).toBe(1_000_000);
    expect(circuit.devices.count1.getState('last')).toBe(false);
  });

  it('lights the LED from a host-written pin after step', async () => {
    const circuit = await Circuit.create(latchMcuLedInput());

    circuit.reset();
    circuit.devices.mcu1.writePin('PA0', true);
    circuit.step();

    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('keeps two MCU + LED pairs independent', async () => {
    const circuit = await Circuit.create(twoPairInput());

    // mcu1 is a host-driven latch, mcu2 toggles on every tick.
    circuit.devices.mcu1.writePin('PA0', true);
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
    expect(circuit.devices.led2.isOn()).toBe(true);

    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
    expect(circuit.devices.led2.isOn()).toBe(false);
    expect(circuit.getPin('mcu1.PA0')).toBe(true);
    expect(circuit.getPin('mcu2.PA0')).toBe(false);
  });

  it('replays the same trace on the JIT and the reference engine', async () => {
    const jit = await Circuit.create(mcuLedInput(), { engine: 'jit' });
    const reference = await Circuit.create(mcuLedInput(), { engine: 'reference' });

    for (let tick = 0; tick < 6; tick += 1) {
      jit.step();
      reference.step();
      expect(reference.devices.led1.isOn()).toBe(jit.devices.led1.isOn());
      expect(reference.getPin('led1.anode')).toBe(jit.getPin('led1.anode'));
      expect(reference.devices.mcu1.readPin('PA0')).toBe(jit.devices.mcu1.readPin('PA0'));
    }
    expect(reference.tickCount).toBe(jit.tickCount);
  });

  it('compiles without the optional IR validation pass', async () => {
    const circuit = await Circuit.create(mcuLedInput(), { validateIR: false });
    circuit.runBatch(3);
    expect(circuit.tickCount).toBe(3n);
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('honours custom rails from the electrical options', async () => {
    const railInput = {
      devices: [{ id: 'led1', type: 'ideal-led', description: createLedDescription() }],
      connections: [
        { from: 'led1.anode', to: 'PWR' },
        { from: 'led1.cathode', to: 'GND' },
      ],
    } as const;

    await expect(Circuit.create(railInput)).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'invalid-connection',
    });

    const circuit = await Circuit.create(railInput, { electrical: { rails: { PWR: true } } });
    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('solves several drivers as a wired-OR when enabled', async () => {
    await expect(Circuit.create(multiDriverInput())).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'driver-conflict',
    });

    const circuit = await Circuit.create(multiDriverInput(), {
      electrical: { allowMultiDriver: true },
    });
    circuit.step();
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(true);
    expect(circuit.devices.mcu2.readPin('PA0')).toBe(true);
    expect(circuit.devices.led1.isOn()).toBe(true);

    circuit.step();
    expect(circuit.devices.led1.isOn()).toBe(false);
  });
});

describe('factories', () => {
  it('builds a single-device circuit from a built-in kernel', async () => {
    const circuit = await createSingleDeviceCircuit('teaching-mcu');

    expect(circuit.devices.device.type).toBe('teaching-mcu');
    expect(circuit.devices.device.pinNames).toEqual(['PA0']);
    expect(circuit.tickCount).toBe(0n);

    circuit.runBatch(9);
    expect(circuit.tickCount).toBe(9n);
    expect(circuit.devices.device.readPin('PA0')).toBe(true);
  });

  it('rejects a missing or empty device type', async () => {
    await expect(createSingleDeviceCircuit('')).rejects.toMatchObject({
      name: 'CircuitError',
      code: 'invalid-options',
    });
  });

  it('rejects a malformed schematic document', async () => {
    await expect(
      createCircuitFromSchematic({} as unknown as SchematicDocument, {
        resolveDevice: () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'CircuitError', code: 'invalid-options' });

    await expect(
      createCircuitFromSchematic(schematic, {} as unknown as SchematicCircuitOptions),
    ).rejects.toMatchObject({ name: 'CircuitError', code: 'invalid-options' });
  });

  it('derives safe, unique device ids from symbol ids and designators', async () => {
    const loose: SchematicDocument = {
      version: SCHEMATIC_VERSION,
      sheet: {
        symbols: [
          { id: 'led-1', device: 'mica:led', x: 0, y: 0, rotation: 0 },
          { id: 'led-2', device: 'mica:led', x: 100, y: 0, rotation: 0, designator: 'D1' },
          { id: 'led-3', device: 'mica:led', x: 200, y: 0, rotation: 0, designator: 'D1' },
          { id: 'gnd-1', device: GROUND_DEVICE, x: 0, y: 20, rotation: 0, net: 'GND' },
          { id: 'gnd-2', device: GROUND_DEVICE, x: 100, y: 20, rotation: 0, net: 'GND' },
          { id: 'gnd-3', device: GROUND_DEVICE, x: 200, y: 20, rotation: 0, net: 'GND' },
        ],
        wires: [
          {
            id: 'w1',
            points: [
              { x: 0, y: 10 },
              { x: 0, y: 20 },
            ],
          },
          {
            id: 'w2',
            points: [
              { x: 100, y: 10 },
              { x: 100, y: 20 },
            ],
          },
          {
            id: 'w3',
            points: [
              { x: 200, y: 10 },
              { x: 200, y: 20 },
            ],
          },
        ],
        junctions: [],
      },
    };

    const circuit = await createCircuitFromSchematic(loose, {
      devices: symbolProvider,
      resolveDevice: () => ({ type: 'ideal-led', description: createLedDescription() }),
    });

    expect(Object.keys(circuit.devices).sort()).toEqual(['D1', 'D1_2', 'led_1']);
  });

  it('rejects a device type without a kernel', async () => {
    await expect(createSingleDeviceCircuit('unknown-device')).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'unsupported-device',
    });
  });

  it('compiles a schematic into a circuit', async () => {
    const circuit = await createCircuitFromSchematic(schematic, {
      devices: symbolProvider,
      resolveDevice: (reference) => {
        if (reference.deviceId === 'mcu') {
          return { type: 'teaching-mcu', description: createMcuDescription() };
        }
        if (reference.deviceId === 'led') {
          return { type: 'ideal-led', description: createLedDescription() };
        }
        return undefined;
      },
    });

    // Designators become device ids; `sym-gnd` is a built-in power symbol.
    expect(Object.keys(circuit.devices).sort()).toEqual(['D1', 'U1']);
    expect(circuit.devices.U1?.type).toBe('teaching-mcu');
    expect(circuit.getPin('U1.PA0')).toBe(false);
    expect(circuit.getPin('D1.cathode')).toBe(false);

    circuit.step();
    expect(circuit.getPin('U1.PA0')).toBe(true);
    expect(circuit.getPin('D1.anode')).toBe(true);
  });

  it('needs a symbol provider to locate pins', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        resolveDevice: () => ({ type: 'teaching-mcu', description: createMcuDescription() }),
      }),
    ).rejects.toBeInstanceOf(CircuitError);
  });

  it('reports component symbols without a binding', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        devices: symbolProvider,
        resolveDevice: (reference) =>
          reference.deviceId === 'led'
            ? { type: 'ideal-led', description: createLedDescription() }
            : undefined,
      }),
    ).rejects.toMatchObject({ name: 'CircuitError', code: 'unresolved-device' });
  });
});

/** Minimal geometry: PA0 at the symbol origin, anode/cathode 10 units apart. */
const symbolProvider: DeviceSymbolProvider = {
  getDeviceSymbol(reference) {
    if (reference.deviceId === 'mcu') {
      return { name: 'MCU', pins: { PA0: { x: 0, y: 0 } } };
    }
    if (reference.deviceId === 'led') {
      return {
        name: 'LED',
        pins: { anode: { x: 0, y: 0 }, cathode: { x: 0, y: 10 } },
      };
    }
    return undefined;
  },
  getDeviceName(reference) {
    if (reference.deviceId === 'mcu') return 'MCU';
    if (reference.deviceId === 'led') return 'LED';
    return undefined;
  },
};

/**
 * ```
 * U1.PA0 ────────── D1.anode
 *                   D1.cathode
 *                        │
 *                       GND
 * ```
 */
const schematic: SchematicDocument = {
  version: SCHEMATIC_VERSION,
  sheet: {
    symbols: [
      { id: 'sym-mcu', device: 'mica:mcu', x: 0, y: 0, rotation: 0, designator: 'U1' },
      { id: 'sym-led', device: 'mica:led', x: 100, y: 0, rotation: 0, designator: 'D1' },
      { id: 'sym-gnd', device: GROUND_DEVICE, x: 100, y: 20, rotation: 0, net: 'GND' },
    ],
    wires: [
      {
        id: 'w-signal',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
      {
        id: 'w-ground',
        points: [
          { x: 100, y: 10 },
          { x: 100, y: 20 },
        ],
      },
    ],
    junctions: [],
  },
};
