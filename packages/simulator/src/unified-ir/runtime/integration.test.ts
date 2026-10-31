import { physicalDescription, TEST_ELECTRICAL } from '../compiler/test-helpers';
import { describe, expect, it } from 'vitest';
import {
  GROUND_DEVICE,
  SCHEMATIC_VERSION,
  type DeviceSymbolProvider,
  type SchematicDocument,
} from '@mica-js/core/schematic';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';
import { compileSchematicInput, createCircuitFromSchematic } from './factory';
import { createTestProbe } from '../../test-helpers/circuit-probe';
import { CircuitError } from './types';
import type { SchematicCircuitOptions } from './factory';

describe('factories', () => {
  it('rejects a malformed schematic document', async () => {
    await expect(
      createCircuitFromSchematic({} as unknown as SchematicDocument, {
        resolveDevice: () => undefined,
      }),
    ).rejects.toMatchObject({ name: 'CircuitError', code: 'invalid-options' });

    await expect(
      createCircuitFromSchematic(schematic, {
        electrical: TEST_ELECTRICAL,
      } as unknown as SchematicCircuitOptions),
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

    const compiled = compileSchematicInput(loose, {
      electrical: TEST_ELECTRICAL,
      devices: symbolProvider,
      resolveDevice: () => ({
        type: 'lamp-sink',
        description: physicalDescription(lampSinkDescription()),
      }),
    });
    expect(compiled.bindings.map((binding) => binding.deviceId).sort()).toEqual([
      'D1',
      'D1_2',
      'sink_1',
    ]);
  });

  it('compiles a schematic into a circuit', async () => {
    const options: SchematicCircuitOptions = {
      electrical: TEST_ELECTRICAL,
      devices: symbolProvider,
      resolveDevice: (reference) => {
        if (reference.deviceId === 'driver') {
          return {
            type: 'toggle-driver',
            description: physicalDescription(toggleDriverDescription()),
          };
        }
        if (reference.deviceId === 'sink') {
          return { type: 'lamp-sink', description: physicalDescription(lampSinkDescription()) };
        }
        return undefined;
      },
    } as const;
    const circuit = await createCircuitFromSchematic(schematic, options);
    try {
      const compiled = compileSchematicInput(schematic, options);
      // Designators become device ids; `sym-gnd` is a built-in power symbol.
      expect(compiled.bindings.map((binding) => binding.deviceId).sort()).toEqual(['D1', 'U1']);
      expect(compiled.bindings.find((binding) => binding.deviceId === 'U1')?.type).toBe(
        'toggle-driver',
      );

      const probe = createTestProbe(compiled.input, { electrical: TEST_ELECTRICAL });
      expect(probe.digital('U1.PA0')).toBe(false);
      expect(probe.digital('D1.cathode')).toBe(false);

      probe.step();
      expect(probe.digital('U1.PA0')).toBe(true);
      expect(probe.digital('D1.anode')).toBe(true);

      circuit.step();
      expect(circuit.tickCount).toBe(1n);
    } finally {
      circuit.dispose();
    }
  });

  it('needs a symbol provider to locate pins', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        electrical: TEST_ELECTRICAL,
        resolveDevice: () => ({
          type: 'toggle-driver',
          description: physicalDescription(toggleDriverDescription()),
        }),
      }),
    ).rejects.toBeInstanceOf(CircuitError);
  });

  it('reports component symbols without a binding', async () => {
    await expect(
      createCircuitFromSchematic(schematic, {
        electrical: TEST_ELECTRICAL,
        devices: symbolProvider,
        resolveDevice: (reference) =>
          reference.deviceId === 'sink'
            ? { type: 'lamp-sink', description: physicalDescription(lampSinkDescription()) }
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
