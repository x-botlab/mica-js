import { describe, expect, it } from 'vitest';
import {
  GROUND_DEVICE,
  SCHEMATIC_VERSION,
  type DeviceSymbolProvider,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';
import { Circuit } from './circuit';
import { createCircuitFromSchematic } from './factory';
import { CircuitError } from './types';
import type { SchematicCircuitOptions } from './factory';
import {
  counterInput,
  driverSinkInput,
  latchDriverSinkInput,
  multiDriverInput,
  twoPairInput,
} from './test-helpers';

describe('driver + sink integration', () => {
  it('propagates every driver pin toggle to the lamp', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(circuit.devices.sink1.getState('lamp')).toBe(false);

    circuit.step();
    expect(circuit.devices.drive1.readPin('PA0')).toBe(true);
    expect(circuit.getPin('drive1.PA0')).toBe(true);
    expect(circuit.getPin('sink1.anode')).toBe(true);
    expect(circuit.getPin('sink1.cathode')).toBe(false);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);

    circuit.step();
    expect(circuit.devices.drive1.readPin('PA0')).toBe(false);
    expect(circuit.getPin('sink1.anode')).toBe(false);
    expect(circuit.devices.sink1.getState('lamp')).toBe(false);

    circuit.step();
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
  });

  it('keeps a host-driven pin level through batches', async () => {
    const circuit = await Circuit.create(latchDriverSinkInput());

    circuit.devices.drive1.writePin('PA0', true);
    circuit.runBatch(1000);

    expect(circuit.tickCount).toBe(1000n);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
    expect(circuit.getPin('sink1.anode')).toBe(true);

    circuit.devices.drive1.writePin('PA0', false);
    circuit.runBatch(1);
    expect(circuit.devices.sink1.getState('lamp')).toBe(false);
  });

  it('executes every tick of a large batch', async () => {
    const circuit = await Circuit.create(counterInput());

    circuit.runBatch(1_000_000);

    expect(circuit.tickCount).toBe(1_000_000n);
    expect(circuit.devices.count1.getState('count')).toBe(1_000_000);
    expect(circuit.devices.count1.getState('last')).toBe(false);
  });

  it('lights the sink from a host-written pin after step', async () => {
    const circuit = await Circuit.create(latchDriverSinkInput());

    circuit.reset();
    circuit.devices.drive1.writePin('PA0', true);
    circuit.step();

    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
  });

  it('keeps two driver + sink pairs independent', async () => {
    const circuit = await Circuit.create(twoPairInput());

    // drive1 is a host-driven latch, drive2 toggles on every tick.
    circuit.devices.drive1.writePin('PA0', true);
    circuit.step();
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
    expect(circuit.devices.sink2.getState('lamp')).toBe(true);

    circuit.step();
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
    expect(circuit.devices.sink2.getState('lamp')).toBe(false);
    expect(circuit.getPin('drive1.PA0')).toBe(true);
    expect(circuit.getPin('drive2.PA0')).toBe(false);
  });

  it('replays the same trace on the JIT and the reference engine', async () => {
    const jit = await Circuit.create(driverSinkInput(), { engine: 'jit' });
    const reference = await Circuit.create(driverSinkInput(), { engine: 'reference' });

    for (let tick = 0; tick < 6; tick += 1) {
      jit.step();
      reference.step();
      expect(reference.devices.sink1.getState('lamp')).toBe(jit.devices.sink1.getState('lamp'));
      expect(reference.getPin('sink1.anode')).toBe(jit.getPin('sink1.anode'));
      expect(reference.devices.drive1.readPin('PA0')).toBe(jit.devices.drive1.readPin('PA0'));
    }
    expect(reference.tickCount).toBe(jit.tickCount);
  });

  it('compiles without the optional IR validation pass', async () => {
    const circuit = await Circuit.create(driverSinkInput(), { validateIR: false });
    circuit.runBatch(3);
    expect(circuit.tickCount).toBe(3n);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
  });

  it('honours custom rails from the electrical options', async () => {
    const railInput = {
      devices: [{ id: 'sink1', type: 'lamp-sink', description: lampSinkDescription() }],
      connections: [
        { from: 'sink1.anode', to: 'PWR' },
        { from: 'sink1.cathode', to: 'GND' },
      ],
    } as const;

    await expect(Circuit.create(railInput)).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'invalid-connection',
    });

    const circuit = await Circuit.create(railInput, { electrical: { rails: { PWR: true } } });
    circuit.step();
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
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
    expect(circuit.devices.drive1.readPin('PA0')).toBe(true);
    expect(circuit.devices.drive2.readPin('PA0')).toBe(true);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);

    circuit.step();
    expect(circuit.devices.sink1.getState('lamp')).toBe(false);
  });
});

describe('factories', () => {
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
          { id: 'sink-1', device: 'mica:sink', x: 0, y: 0, rotation: 0 },
          { id: 'sink-2', device: 'mica:sink', x: 100, y: 0, rotation: 0, designator: 'D1' },
          { id: 'sink-3', device: 'mica:sink', x: 200, y: 0, rotation: 0, designator: 'D1' },
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
      resolveDevice: () => ({ type: 'lamp-sink', description: lampSinkDescription() }),
    });

    expect(Object.keys(circuit.devices).sort()).toEqual(['D1', 'D1_2', 'sink_1']);
  });

  it('compiles a schematic into a circuit', async () => {
    const circuit = await createCircuitFromSchematic(schematic, {
      devices: symbolProvider,
      resolveDevice: (reference) => {
        if (reference.deviceId === 'driver') {
          return { type: 'toggle-driver', description: toggleDriverDescription() };
        }
        if (reference.deviceId === 'sink') {
          return { type: 'lamp-sink', description: lampSinkDescription() };
        }
        return undefined;
      },
    });

    // Designators become device ids; `sym-gnd` is a built-in power symbol.
    expect(Object.keys(circuit.devices).sort()).toEqual(['D1', 'U1']);
    expect(circuit.devices.U1?.type).toBe('toggle-driver');
    expect(circuit.getPin('U1.PA0')).toBe(false);
    expect(circuit.getPin('D1.cathode')).toBe(false);

    circuit.step();
    expect(circuit.getPin('U1.PA0')).toBe(true);
    expect(circuit.getPin('D1.anode')).toBe(true);
  });

  it('needs a symbol provider to locate pins', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        resolveDevice: () => ({ type: 'toggle-driver', description: toggleDriverDescription() }),
      }),
    ).rejects.toBeInstanceOf(CircuitError);
  });

  it('reports component symbols without a binding', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        devices: symbolProvider,
        resolveDevice: (reference) =>
          reference.deviceId === 'sink'
            ? { type: 'lamp-sink', description: lampSinkDescription() }
            : undefined,
      }),
    ).rejects.toMatchObject({ name: 'CircuitError', code: 'unresolved-device' });
  });
});

/** Minimal geometry: PA0 at the symbol origin, anode/cathode 10 units apart. */
const symbolProvider: DeviceSymbolProvider = {
  getDeviceSymbol(reference) {
    if (reference.deviceId === 'driver') {
      return { name: 'driver', pins: { PA0: { x: 0, y: 0 } } };
    }
    if (reference.deviceId === 'sink') {
      return {
        name: 'sink',
        pins: { anode: { x: 0, y: 0 }, cathode: { x: 0, y: 10 } },
      };
    }
    return undefined;
  },
  getDeviceName(reference) {
    if (reference.deviceId === 'driver') return 'driver';
    if (reference.deviceId === 'sink') return 'sink';
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
      { id: 'sym-driver', device: 'mica:driver', x: 0, y: 0, rotation: 0, designator: 'U1' },
      { id: 'sym-sink', device: 'mica:sink', x: 100, y: 0, rotation: 0, designator: 'D1' },
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
