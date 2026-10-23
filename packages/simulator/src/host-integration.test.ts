/* global URL */
import { readFile } from 'node:fs/promises';
import {
  createPowerRuntime,
  timePs,
  type ElectricalPinInput,
  type PowerDefinition,
  type PowerRuntime,
  type TopologyDefinition,
  type TopologyPinRef,
} from '@mica-js/core';
import type { SchematicDocument, SchematicSymbol } from '@mica-js/core/schematic';
import { parseDeviceDescription, type IDeviceProvider } from '@mica-js/device';
import { describe, expect, it } from 'vitest';
import { createDeviceSimExecutor, type DeviceSimHostFactory } from './index';

/**
 * Cross-package contract: the committed example modules are mounted through the executor with
 * the pin host and the topology a real host supplies. Without `DeviceSimExecutorOptions.host`
 * those examples cannot load at all, so these cases guard the wiring end to end.
 */
const EXAMPLES = new URL('../../device/examples/', import.meta.url);

const EXAMPLE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'mica:ideal-button': 'ideal-button',
  'mica:ideal-relay': 'ideal-relay',
  'mica:teaching-mcu': 'teaching-mcu',
});

function exampleProvider(): IDeviceProvider {
  return {
    async resolve(deviceId: string) {
      const base = EXAMPLE_FILES[deviceId];
      if (base === undefined) {
        return undefined;
      }
      const raw = JSON.parse(
        await readFile(new URL(`${base}/${base}.json`, EXAMPLES), 'utf8'),
      ) as Record<string, unknown>;
      const code = await readFile(new URL(`${base}/${base}.js`, EXAMPLES), 'utf8');
      return { definition: parseDeviceDescription(raw, { name: deviceId }), code };
    },
  };
}

const MODEL = Object.freeze({
  kind: 'ideal-voltage' as const,
  minVoltage: 0,
  maxVoltage: 5,
  lowVoltage: 0,
  highVoltage: 5,
});

function pin(
  instanceId: string,
  pinName: string,
  overrides: Partial<ElectricalPinInput> = {},
): ElectricalPinInput {
  return {
    instanceId,
    pinName,
    powerReady: true,
    mode: 'high-z',
    outputEnabled: false,
    pull: 'none',
    model: MODEL,
    ...overrides,
  };
}

function signal(instanceId: string, pinName: string): TopologyPinRef {
  return { instanceId, pinName };
}

function symbolOf(id: string, device: string): SchematicSymbol {
  return { id, device, x: 0, y: 0, rotation: 0 };
}

function schematic(...symbols: readonly SchematicSymbol[]): SchematicDocument {
  return { version: 1, sheet: { symbols, wires: [], junctions: [] } };
}

interface BoardFixture {
  readonly power: PowerDefinition;
  readonly pinStates: readonly ElectricalPinInput[];
}

/** Button contact feeding a relay coil; the relay contacts switch a separate LOAD rail. */
const BUTTON_RELAY: BoardFixture = (() => {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'LOAD', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'COIL', kind: 'signal' },
      { instanceId: 'board', pinName: 'NO', kind: 'signal' },
      { instanceId: 'board', pinName: 'NC', kind: 'signal' },
      { instanceId: 'sw1', pinName: 'A', kind: 'signal' },
      { instanceId: 'sw1', pinName: 'B', kind: 'signal' },
      { instanceId: 'k1', pinName: 'IN', kind: 'signal' },
      { instanceId: 'k1', pinName: 'COM', kind: 'signal' },
      { instanceId: 'k1', pinName: 'NO', kind: 'signal' },
      { instanceId: 'k1', pinName: 'NC', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true },
      { wireId: 'a', pins: [signal('sw1', 'A'), signal('board', 'VCC')] },
      { wireId: 'coil', pins: [signal('sw1', 'B'), signal('k1', 'IN'), signal('board', 'COIL')] },
      { wireId: 'com', pins: [signal('k1', 'COM'), signal('board', 'LOAD')] },
      { wireId: 'no', pins: [signal('k1', 'NO'), signal('board', 'NO')] },
      { wireId: 'nc', pins: [signal('k1', 'NC'), signal('board', 'NC')] },
    ],
    connections: [
      { instanceId: 'sw1', connectionId: 'contact', pins: ['A', 'B'], initial: 'open' },
      { instanceId: 'k1', connectionId: 'normallyOpen', pins: ['COM', 'NO'], initial: 'open' },
      { instanceId: 'k1', connectionId: 'normallyClosed', pins: ['COM', 'NC'], initial: 'closed' },
    ],
  };
  const power: PowerDefinition = {
    topology,
    devices: [
      {
        instanceId: 'board',
        powerDomains: {
          board: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: { NO: { powerDomain: 'board' }, NC: { powerDomain: 'board' } },
      },
    ],
  };
  return {
    power,
    pinStates: [
      pin('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'LOAD', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'GND'),
      pin('board', 'COIL', { pull: 'down' }),
      pin('board', 'NO', { pull: 'down' }),
      pin('board', 'NC', { pull: 'down' }),
      pin('sw1', 'A'),
      pin('sw1', 'B'),
      pin('k1', 'IN'),
      pin('k1', 'COM'),
      pin('k1', 'NO'),
      pin('k1', 'NC'),
    ],
  };
})();

/** One MCU GPIO driving a pulled-down sense net on the board logic domain. */
const MCU_BOARD: BoardFixture = (() => {
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: 'board', pinName: 'VCC', kind: 'power' },
      { instanceId: 'board', pinName: 'GND', kind: 'gnd' },
      { instanceId: 'board', pinName: 'SENSE', kind: 'signal' },
      { instanceId: 'mcu', pinName: 'GPIO', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [signal('board', 'GND')], globalGnd: true },
      { wireId: 'gpio', pins: [signal('mcu', 'GPIO'), signal('board', 'SENSE')] },
    ],
    connections: [],
  };
  const power: PowerDefinition = {
    topology,
    devices: [
      {
        instanceId: 'board',
        powerDomains: {
          logic: { supply: 'VCC', ground: 'GND', voltage: { turnOn: 3, turnOff: 2 } },
        },
        pins: { SENSE: { powerDomain: 'logic' } },
      },
    ],
  };
  return {
    power,
    pinStates: [
      pin('board', 'VCC', { mode: 'analog', outputEnabled: true, voltageIntent: 5 }),
      pin('board', 'GND'),
      pin('board', 'SENSE', { pull: 'down' }),
      pin('mcu', 'GPIO'),
    ],
  };
})();

interface PowerRecorder {
  readonly factory: DeviceSimHostFactory;
  readonly runtimes: PowerRuntime[];
  readonly disposed: PowerRuntime[];
}

/** Host factory that builds one power runtime per runtime and records its lifecycle. */
function powerHost(board: BoardFixture): PowerRecorder {
  const runtimes: PowerRuntime[] = [];
  const disposed: PowerRuntime[] = [];
  const factory: DeviceSimHostFactory = ({ scheduler }) => {
    const power = createPowerRuntime(scheduler, board.power, {
      instanceId: 'power',
      pinStates: board.pinStates,
      floating: { seed: 63 },
    });
    runtimes.push(power);
    return {
      pinHost: power,
      topology: power,
      dispose: () => {
        disposed.push(power);
        power.destroy();
      },
    };
  };
  return { factory, runtimes, disposed };
}

describe('device executor host wiring', () => {
  it('refuses a pin/connection device when no host is configured', async () => {
    const executor = createDeviceSimExecutor({ devices: exampleProvider() });

    await expect(
      executor.loadSchematic(schematic(symbolOf('sw1', 'mica:ideal-button'))),
    ).rejects.toMatchObject({ code: 'simulator/instance-create-failed', symbol: 'sw1' });
    expect(executor.getState()).toBe('idle');
  });

  it('closes the button contact and switches the relay on the shared topology', async () => {
    const host = powerHost(BUTTON_RELAY);
    const executor = createDeviceSimExecutor({ devices: exampleProvider(), host: host.factory });
    await executor.loadSchematic(
      schematic(symbolOf('sw1', 'mica:ideal-button'), symbolOf('k1', 'mica:ideal-relay')),
    );
    const power = host.runtimes[0]!;

    expect(power.connectionState('sw1', 'contact')).toBe('open');
    expect(power.connectionState('k1', 'normallyOpen')).toBe('open');
    expect(power.connectionState('k1', 'normallyClosed')).toBe('closed');

    executor.deliver({ symbol: 'sw1', port: 'pressed' }, true);
    executor.advance(timePs(1_000));

    expect(power.connectionState('sw1', 'contact')).toBe('closed');
    expect(power.connectionState('k1', 'normallyOpen')).toBe('closed');
    expect(power.connectionState('k1', 'normallyClosed')).toBe('open');
    expect(power.sampleDigital(signal('k1', 'IN'))).toMatchObject({ value: 1, ready: true });

    executor.deliver({ symbol: 'sw1', port: 'pressed' }, false);
    executor.advance(timePs(1_000));

    expect(power.connectionState('sw1', 'contact')).toBe('open');
    expect(power.connectionState('k1', 'normallyOpen')).toBe('open');
    expect(power.connectionState('k1', 'normallyClosed')).toBe('closed');
  });

  it('runs the teaching MCU and exposes its GPIO through the pin host', async () => {
    const host = powerHost(MCU_BOARD);
    const executor = createDeviceSimExecutor({
      devices: exampleProvider(),
      host: (context) => ({
        ...host.factory(context),
        instanceOptions: (symbol) =>
          symbol.id === 'mcu' ? { updateResources: ['firmware'] } : undefined,
      }),
    });
    await executor.loadSchematic(schematic(symbolOf('mcu', 'mica:teaching-mcu')));
    const power = host.runtimes[0]!;
    const gpio = (): number => power.sampleDigital(signal('mcu', 'GPIO')).value;

    const samples = new Set<number>([gpio()]);
    for (let step = 0; step < 8; step += 1) {
      executor.advance(timePs(10_000));
      samples.add(gpio());
    }
    expect([...samples].sort()).toEqual([0, 1]);

    // The host grant is what makes the readonly firmware patch path usable.
    executor.deliver(
      { symbol: 'mcu', port: 'firmwarePatch' },
      Uint8Array.from([0x10, 1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    expect(() => executor.advance(timePs(10_000))).not.toThrow();
    expect(executor.getState()).toBe('ready');
  });

  it('rebuilds the host wiring on reset and releases it on dispose', async () => {
    const host = powerHost(BUTTON_RELAY);
    const executor = createDeviceSimExecutor({ devices: exampleProvider(), host: host.factory });
    await executor.loadSchematic(schematic(symbolOf('sw1', 'mica:ideal-button')));
    expect(host.runtimes).toHaveLength(1);

    executor.advance(timePs(5_000));
    expect(executor.getSimTime()).toBe(5_000);

    executor.reset();
    expect(executor.getSimTime()).toBe(0);
    expect(host.runtimes).toHaveLength(2);
    expect(host.disposed).toEqual([host.runtimes[0]]);

    executor.dispose();
    expect(host.disposed).toEqual(host.runtimes);
    expect(executor.getState()).toBe('disposed');
    expect(() => executor.reset()).toThrowError();
  });

  it('keeps the running runtime when the host factory throws', async () => {
    let calls = 0;
    const base = powerHost(BUTTON_RELAY);
    const executor = createDeviceSimExecutor({
      devices: exampleProvider(),
      host: (context) => {
        calls += 1;
        if (calls > 1) {
          throw new Error('host boom');
        }
        return base.factory(context);
      },
    });
    await executor.loadSchematic(schematic(symbolOf('sw1', 'mica:ideal-button')));
    executor.advance(timePs(7_000));

    expect(() => executor.reset()).toThrowError('host boom');
    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(7_000);
    expect(base.runtimes).toHaveLength(1);
  });

  it('reports a throwing host dispose instead of failing silently', async () => {
    const diagnostics: string[] = [];
    const simple: IDeviceProvider = {
      resolve: (deviceId: string) =>
        deviceId === 'acme:simple'
          ? {
              definition: parseDeviceDescription(
                { ports: { value: { direction: 'input', type: 'number' } } },
                { name: deviceId },
              ),
              code: 'export default function createDevice() { return {}; }',
            }
          : undefined,
    };
    const executor = createDeviceSimExecutor({
      devices: simple,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      host: () => ({
        dispose() {
          throw new Error('dispose boom');
        },
      }),
    });
    await executor.loadSchematic(schematic(symbolOf('u1', 'acme:simple')));

    expect(() => executor.dispose()).not.toThrow();
    expect(diagnostics).toContain('simulator/dispose-failed');
  });
});
