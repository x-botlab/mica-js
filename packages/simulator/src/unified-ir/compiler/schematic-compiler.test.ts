import { describe, expect, it } from 'vitest';
import type { TopologyDefinition } from '@mica-js/core';
import {
  GROUND_DEVICE,
  POWER_DEVICE,
  SCHEMATIC_VERSION,
  synthesizeDeviceSymbol,
  symbolPinPosition,
} from '@mica-js/core/schematic';
import type {
  Placement,
  Point,
  SchematicDocument,
  SchematicSymbol,
  SchematicWire,
} from '@mica-js/core/schematic';
import { parseDeviceDescription } from '@mica-js/device';
import type { DeviceDefinition, IDeviceProvider } from '@mica-js/device';
import { compileBoardTopology, compileSchematicToCircuit } from './schematic-compiler';
import type { CompiledSchematicDevice, SchematicCompilationResult } from './schematic-compiler';

const MCU_DEVICE = 'mica:mcu';
const LED_DEVICE = 'mica:led';
const GHOST_DEVICE = 'mica:ghost';

const MCU_RAW = {
  pins: {
    PA0: { kind: 'signal', side: 'right' },
    VDD: { kind: 'power', side: 'top' },
  },
};

const LED_RAW = {
  pins: {
    anode: { kind: 'signal', side: 'left' },
    cathode: { kind: 'signal', side: 'right' },
  },
};

/** Provider over raw descriptions; a missing key is an unknown device. */
function providerOf(raw: Readonly<Record<string, unknown>>): IDeviceProvider {
  const cache = new Map<string, DeviceDefinition>();
  return {
    resolve(deviceId: string): DeviceDefinition | undefined {
      const cached = cache.get(deviceId);
      if (cached !== undefined) return cached;
      const description = raw[deviceId];
      if (description === undefined) return undefined;
      const definition: DeviceDefinition = {
        definition: parseDeviceDescription(description, { name: deviceId }),
        code: '',
      };
      cache.set(deviceId, definition);
      return definition;
    },
  };
}

/** World position of one pin, from the same synthesis the compiler uses. */
function pinAt(raw: unknown, deviceId: string, pin: string, placement: Placement): Point {
  const definition = parseDeviceDescription(raw, { name: deviceId });
  const geometry = synthesizeDeviceSymbol({
    name: deviceId,
    pins: Object.fromEntries(
      [...definition.pins.values()].map((entry) => [entry.key, { side: entry.side }]),
    ),
  });
  const anchor = geometry.pins[pin];
  if (anchor === undefined) throw new Error(`no pin ${pin}`);
  return symbolPinPosition(placement, anchor);
}

function symbol(
  id: string,
  device: string,
  placement: Placement,
  extra: Partial<SchematicSymbol> = {},
): SchematicSymbol {
  return { id, device, ...placement, ...extra };
}

function wire(id: string, ...points: Point[]): SchematicWire {
  return { id, points };
}

function sheetOf(
  symbols: readonly SchematicSymbol[],
  wires: readonly SchematicWire[] = [],
  junctions: SchematicDocument['sheet']['junctions'] = [],
): SchematicDocument {
  return {
    version: SCHEMATIC_VERSION,
    sheet: { symbols, wires, junctions },
  };
}

const MCU_AT = { x: 0, y: 0, rotation: 0 } as const;
const LED_AT = { x: 200, y: 0, rotation: 0 } as const;

/** `U1.PA0 -> D1.anode`, `D1.cathode -> GND`, `U1.VDD -> 3V3`. */
function ledMcuSheet(): SchematicDocument {
  const pa0 = pinAt(MCU_RAW, MCU_DEVICE, 'PA0', MCU_AT);
  const vdd = pinAt(MCU_RAW, MCU_DEVICE, 'VDD', MCU_AT);
  const anode = pinAt(LED_RAW, LED_DEVICE, 'anode', LED_AT);
  const cathode = pinAt(LED_RAW, LED_DEVICE, 'cathode', LED_AT);
  const supply = { x: vdd.x, y: vdd.y - 20 };
  const ground = { x: cathode.x, y: cathode.y + 20 };
  return sheetOf(
    [
      symbol('sym-mcu', MCU_DEVICE, MCU_AT, { designator: 'U1' }),
      symbol('sym-led', LED_DEVICE, LED_AT, { designator: 'D1' }),
      symbol('sym-3v3', POWER_DEVICE, { ...supply, rotation: 0 }, { net: '3V3' }),
      symbol('sym-gnd', GROUND_DEVICE, { ...ground, rotation: 0 }, { net: 'GND' }),
    ],
    [
      wire('w-signal', pa0, anode),
      wire('w-supply', vdd, supply),
      wire('w-ground', cathode, ground),
    ],
  );
}

function errorsOf(result: SchematicCompilationResult) {
  return result.diagnostics.filter((entry) => entry.severity === 'error');
}

/** Connections as undirected endpoint pairs, so net member order does not matter. */
function pairsOf(result: SchematicCompilationResult): readonly string[] {
  return result.input.connections
    .map((connection) => [connection.from, connection.to].sort().join('<->'))
    .sort();
}

describe('compileSchematicToCircuit', () => {
  it('compiles an LED and an MCU into devices, connections and rails', async () => {
    const result = await compileSchematicToCircuit(
      ledMcuSheet(),
      providerOf({ [MCU_DEVICE]: MCU_RAW, [LED_DEVICE]: LED_RAW }),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.devices.map((device) => device.deviceId)).toEqual(['U1', 'D1']);
    expect(result.devices.map((device) => device.type)).toEqual(['mcu', 'led']);
    expect(result.input.devices.map((device) => device.id)).toEqual(['U1', 'D1']);
    expect(result.rails).toEqual({ '3V3': true, GND: false });
    expect(pairsOf(result)).toEqual(['3V3<->U1.VDD', 'D1.anode<->U1.PA0', 'D1.cathode<->GND']);
  });

  it('derives passive pins and empty behaviour from a package description', async () => {
    const result = await compileSchematicToCircuit(
      ledMcuSheet(),
      providerOf({ [MCU_DEVICE]: MCU_RAW, [LED_DEVICE]: LED_RAW }),
    );

    const led = result.input.devices.find((device) => device.id === 'D1');
    expect(led?.description.pins).toEqual({
      anode: { direction: 'passive', kind: 'signal' },
      cathode: { direction: 'passive', kind: 'signal' },
    });
    expect(typeof led?.description.behaviors?.initialize).toBe('function');
  });

  it('omits every rail the sheet does not declare', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-led', LED_DEVICE, LED_AT, { designator: 'D1' })]),
      providerOf({ [LED_DEVICE]: LED_RAW }),
    );

    expect(result.rails).toEqual({});
    expect(result.input.connections).toEqual([]);
  });

  it('accepts a ground symbol with the GND net and one without a net', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([
        symbol('sym-gnd', GROUND_DEVICE, { x: 0, y: 0, rotation: 0 }, { net: 'GND' }),
        symbol('sym-gnd-default', GROUND_DEVICE, { x: 40, y: 0, rotation: 0 }),
      ]),
      providerOf({}),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.rails).toEqual({ GND: false });
  });

  it('rejects a ground symbol with a custom net name', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-agnd', GROUND_DEVICE, { x: 0, y: 0, rotation: 0 }, { net: 'AGND' })]),
      providerOf({}),
    );

    expect(result.rails).toEqual({});
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'invalid-ground-net',
        symbol: 'sym-agnd',
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain('AGND');
  });

  it('rejects a power symbol that names the GND net', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-bad', POWER_DEVICE, { x: 0, y: 0, rotation: 0 }, { net: 'GND' })]),
      providerOf({}),
    );

    expect(result.rails).toEqual({});
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid-power-net', symbol: 'sym-bad' }),
    ]);
  });

  it('defaults a power symbol without a net to 3V3', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-3v3', POWER_DEVICE, { x: 0, y: 0, rotation: 0 })]),
      providerOf({}),
    );

    expect(result.rails).toEqual({ '3V3': true });
  });

  it('ties pins to the default 3V3 rail of a net-less power symbol', async () => {
    const vdd = pinAt(MCU_RAW, MCU_DEVICE, 'VDD', MCU_AT);
    const supply = { x: vdd.x, y: vdd.y - 20 };
    const result = await compileSchematicToCircuit(
      sheetOf(
        [
          symbol('sym-mcu', MCU_DEVICE, MCU_AT, { designator: 'U1' }),
          symbol('sym-3v3', POWER_DEVICE, { ...supply, rotation: 0 }),
        ],
        [wire('w-supply', vdd, supply)],
      ),
      providerOf({ [MCU_DEVICE]: MCU_RAW }),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.rails).toEqual({ '3V3': true });
    expect(pairsOf(result)).toEqual(['3V3<->U1.VDD']);
  });

  it('keeps a custom 5V rail and ties its pins to it', async () => {
    const vdd = pinAt(MCU_RAW, MCU_DEVICE, 'VDD', MCU_AT);
    const supply = { x: vdd.x, y: vdd.y - 20 };
    const result = await compileSchematicToCircuit(
      sheetOf(
        [
          symbol('sym-mcu', MCU_DEVICE, MCU_AT, { designator: 'U1' }),
          symbol('sym-5v', POWER_DEVICE, { ...supply, rotation: 0 }, { net: '5V' }),
        ],
        [wire('w-supply', vdd, supply)],
      ),
      providerOf({ [MCU_DEVICE]: MCU_RAW }),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.rails).toEqual({ '5V': true });
    expect(pairsOf(result)).toEqual(['5V<->U1.VDD']);
  });

  it('reports unknown devices and keeps the rest of the sheet', async () => {
    const sheet = ledMcuSheet();
    const result = await compileSchematicToCircuit(
      sheetOf(
        [
          ...sheet.sheet.symbols,
          symbol('sym-ghost', GHOST_DEVICE, { x: 400, y: 0, rotation: 0 }, { designator: 'U9' }),
        ],
        sheet.sheet.wires,
      ),
      providerOf({ [MCU_DEVICE]: MCU_RAW, [LED_DEVICE]: LED_RAW }),
    );

    expect(result.devices.map((device) => device.deviceId)).toEqual(['U1', 'D1']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'unknown-device',
        symbol: 'sym-ghost',
      }),
    ]);
  });

  it('reports an invalid device reference', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-bad', 'not-a-reference', { x: 0, y: 0, rotation: 0 })]),
      providerOf({}),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'invalid-device-reference',
        symbol: 'sym-bad',
      }),
    ]);
    expect(result.input.devices).toEqual([]);
  });

  it('converts symbol properties into the device config', async () => {
    const clock = {
      pins: { XTAL1: { kind: 'signal', side: 'left' } },
      properties: {
        speed: { type: 'number', title: 'Speed', default: 11.0592, min: 1, max: 24 },
        label: { type: 'string', title: 'Name', default: '8051' },
      },
    };
    const result = await compileSchematicToCircuit(
      sheetOf([
        symbol(
          'sym-8051',
          MCU_DEVICE,
          { x: 0, y: 0, rotation: 0 },
          { designator: 'U1', properties: { speed: 8, label: 'main' } },
        ),
      ]),
      providerOf({ [MCU_DEVICE]: clock }),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.input.devices[0]?.config).toEqual({ speed: 8, label: 'main' });
  });

  it('applies property defaults when the symbol overrides nothing', async () => {
    const clock = {
      pins: { XTAL1: { kind: 'signal', side: 'left' } },
      properties: { speed: { type: 'number', default: 12, min: 1, max: 24 } },
    };
    const result = await compileSchematicToCircuit(
      sheetOf([symbol('sym-8051', MCU_DEVICE, { x: 0, y: 0, rotation: 0 })]),
      providerOf({ [MCU_DEVICE]: clock }),
    );

    expect(result.input.devices[0]?.config).toEqual({ speed: 12 });
  });

  it('reports an invalid property override', async () => {
    const clock = {
      pins: { XTAL1: { kind: 'signal', side: 'left' } },
      properties: { speed: { type: 'number', default: 12, min: 1, max: 24 } },
    };
    const result = await compileSchematicToCircuit(
      sheetOf([
        symbol(
          'sym-8051',
          MCU_DEVICE,
          { x: 0, y: 0, rotation: 0 },
          { designator: 'U1', properties: { speed: 99 } },
        ),
      ]),
      providerOf({ [MCU_DEVICE]: clock }),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid-property', symbol: 'sym-8051' }),
    ]);
  });

  it('joins pins through a junction and several wire segments', async () => {
    const pa0 = pinAt(MCU_RAW, MCU_DEVICE, 'PA0', MCU_AT);
    const firstAnode = pinAt(LED_RAW, LED_DEVICE, 'anode', LED_AT);
    const secondAnode = pinAt(LED_RAW, LED_DEVICE, 'anode', { x: 200, y: 100, rotation: 0 });
    const junction = { x: 100, y: pa0.y };
    const downJunction = { x: 100, y: secondAnode.y };

    const result = await compileSchematicToCircuit(
      sheetOf(
        [
          symbol('sym-mcu', MCU_DEVICE, MCU_AT, { designator: 'U1' }),
          symbol('sym-led-1', LED_DEVICE, LED_AT, { designator: 'D1' }),
          symbol('sym-led-2', LED_DEVICE, { x: 200, y: 100, rotation: 0 }, { designator: 'D2' }),
        ],
        [
          wire('w-a', pa0, junction),
          wire('w-b', junction, { x: firstAnode.x, y: firstAnode.y }),
          wire('w-c', junction, downJunction),
          wire('w-d', downJunction, secondAnode),
        ],
        [
          { id: 'j-1', x: junction.x, y: junction.y, wires: ['w-a', 'w-b', 'w-c'] },
          { id: 'j-2', x: downJunction.x, y: downJunction.y, wires: ['w-c', 'w-d'] },
        ],
      ),
      providerOf({ [MCU_DEVICE]: MCU_RAW, [LED_DEVICE]: LED_RAW }),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(result.input.connections).toHaveLength(2);
    const endpoints = new Set(
      result.input.connections.flatMap((connection) => [connection.from, connection.to]),
    );
    expect(endpoints).toEqual(new Set(['U1.PA0', 'D1.anode', 'D2.anode']));
  });

  it('deduplicates device ids that share a designator', async () => {
    const result = await compileSchematicToCircuit(
      sheetOf([
        symbol('sym-led-1', LED_DEVICE, LED_AT, { designator: 'D1' }),
        symbol('sym-led-2', LED_DEVICE, { x: 300, y: 0, rotation: 0 }, { designator: 'D1' }),
      ]),
      providerOf({ [LED_DEVICE]: LED_RAW }),
    );

    expect(result.input.devices.map((device) => device.id)).toEqual(['D1', 'D1_2']);
  });

  it('compiles an empty sheet', async () => {
    const result = await compileSchematicToCircuit(sheetOf([]), providerOf({}));

    expect(result.input).toEqual({ devices: [], connections: [] });
    expect(result.rails).toEqual({});
    expect(result.diagnostics).toEqual([]);
    expect(result.devices).toEqual([]);
  });

  it('accepts a resolveDevice binding for devices with IR logic', async () => {
    const result = await compileSchematicToCircuit(
      ledMcuSheet(),
      providerOf({ [MCU_DEVICE]: MCU_RAW, [LED_DEVICE]: LED_RAW }),
      {
        resolveDevice: (reference) =>
          reference.deviceId === 'mcu'
            ? {
                type: 'teaching-mcu',
                description: {
                  pins: { PA0: { direction: 'output' } },
                  behaviors: { tick: () => {} },
                },
              }
            : { type: 'ideal-led' },
      },
    );

    const mcu = result.input.devices.find((device) => device.id === 'U1');
    expect(mcu?.type).toBe('teaching-mcu');
    expect(mcu?.description.pins).toEqual({ PA0: { direction: 'output' } });
    // The LED keeps the derived description but takes the bound type.
    const led = result.input.devices.find((device) => device.id === 'D1');
    expect(led?.type).toBe('ideal-led');
  });
});

describe('compileBoardTopology', () => {
  const devices: readonly CompiledSchematicDevice[] = Object.freeze([
    { symbolId: 'sym-sw', designator: 'S1', deviceId: 'S1', type: 'ideal-button', ports: [] },
    { symbolId: 'sym-k', designator: 'K1', deviceId: 'K1', type: 'ideal-relay', ports: [] },
  ]);

  it('turns board wires into rails, connections and probe aliases', () => {
    const topology: TopologyDefinition = {
      pins: [
        { instanceId: 'board', pinName: 'VCC', kind: 'power' },
        { instanceId: 'board', pinName: 'LOAD', kind: 'power' },
        { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
        { instanceId: 'board', pinName: 'COIL', kind: 'signal' },
        { instanceId: 'board', pinName: 'NO', kind: 'signal' },
        { instanceId: 'sym-sw', pinName: 'A', kind: 'signal' },
        { instanceId: 'sym-sw', pinName: 'B', kind: 'signal' },
        { instanceId: 'sym-k', pinName: 'IN', kind: 'signal' },
        { instanceId: 'sym-k', pinName: 'COM', kind: 'signal' },
        { instanceId: 'sym-k', pinName: 'NO', kind: 'signal' },
      ],
      wires: [
        { wireId: 'ground', pins: [{ instanceId: 'board', pinName: 'GND' }], globalGnd: true },
        {
          wireId: 'vcc',
          pins: [
            { instanceId: 'sym-sw', pinName: 'A' },
            { instanceId: 'board', pinName: 'VCC' },
          ],
        },
        {
          wireId: 'coil',
          pins: [
            { instanceId: 'sym-sw', pinName: 'B' },
            { instanceId: 'sym-k', pinName: 'IN' },
            { instanceId: 'board', pinName: 'COIL' },
          ],
        },
        {
          wireId: 'com',
          pins: [
            { instanceId: 'sym-k', pinName: 'COM' },
            { instanceId: 'board', pinName: 'LOAD' },
          ],
        },
        {
          wireId: 'no',
          pins: [
            { instanceId: 'sym-k', pinName: 'NO' },
            { instanceId: 'board', pinName: 'NO' },
          ],
        },
      ],
      connections: [],
    };

    const board = compileBoardTopology(topology, devices);

    // Power pins name their rail; a ground pin is always the GND rail.
    expect(board.rails).toEqual({ GND: false, VCC: true, LOAD: true });
    expect(board.connections).toEqual([
      { from: 'VCC', to: 'S1.A' },
      { from: 'S1.B', to: 'K1.IN' },
      { from: 'LOAD', to: 'K1.COM' },
    ]);
    // Board pins are sampled through the device pin on the same wire.
    expect([...board.aliases]).toEqual([
      ['board.VCC', 'S1.A'],
      ['board.COIL', 'S1.B'],
      ['board.LOAD', 'K1.COM'],
      ['board.NO', 'K1.NO'],
    ]);
  });

  it('leaves a board-only wire unconnected', () => {
    const topology: TopologyDefinition = {
      pins: [{ instanceId: 'board', pinName: 'SENSE', kind: 'signal' }],
      wires: [{ wireId: 'sense', pins: [{ instanceId: 'board', pinName: 'SENSE' }] }],
      connections: [],
    };

    const board = compileBoardTopology(topology, devices);

    expect(board.connections).toEqual([]);
    expect(board.rails).toEqual({});
    expect(board.aliases.size).toBe(0);
  });
});
