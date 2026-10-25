import { describe, expect, it, vi } from 'vitest';
import { timePs } from '@mica-js/core';
import type { TopologyDefinition } from '@mica-js/core';
import { SCHEMATIC_VERSION } from '@mica-js/core/schematic';
import type { SchematicDocument, SchematicSymbol } from '@mica-js/core/schematic';
import { parseDeviceDescription } from '@mica-js/device';
import type { DeviceDefinition, IDeviceProvider } from '@mica-js/device';
import type { DeviceDescription } from '../compiler';
import { createIdealButtonDescription } from '../devices';
import { TICK_PS, createCircuitExecutor } from './circuit-executor-adapter';
import type { CircuitExecutorOptions } from './circuit-executor-adapter';
import { SimulatorError } from '../../errors';
import type { DevicePublish } from '../../types';

const SENSOR_DEVICE = 'mica:sensor';
const DISPLAY_DEVICE = 'mica:display';
const GHOST_DEVICE = 'mica:ghost';

const RAW: Readonly<Record<string, unknown>> = {
  [SENSOR_DEVICE]: { pins: {}, ports: { level: { direction: 'output', type: 'number' } } },
  [DISPLAY_DEVICE]: {
    pins: {},
    ports: {
      show: { direction: 'input', type: 'number' },
      echo: { direction: 'output', type: 'number' },
    },
  },
};

function provider(): IDeviceProvider {
  const cache = new Map<string, DeviceDefinition>();
  return {
    resolve(deviceId: string): DeviceDefinition | undefined {
      const cached = cache.get(deviceId);
      if (cached !== undefined) return cached;
      const raw = RAW[deviceId];
      if (raw === undefined) return undefined;
      const definition: DeviceDefinition = {
        definition: parseDeviceDescription(raw, { name: deviceId }),
        code: '',
      };
      cache.set(deviceId, definition);
      return definition;
    },
  };
}

const sensorDescription: DeviceDescription = {
  pins: {},
  ports: { level: { direction: 'output', type: 'number' } },
  states: { next: { type: 'f64', initial: 0 } },
  behaviors: {
    tick: (api) => {
      const next = api.state<'f64'>('next');
      const value = api.builder.float.add(next.load(), api.builder.const('f64', 1));
      next.store(value);
      api.topics.publish('level', [value]);
    },
  },
};

/** The display echoes whatever arrived on `show`; `extra` is a binding-only port. */
function displayDescription(
  extra: Readonly<Record<string, { direction: 'input'; type: 'boolean' }>> = {},
): DeviceDescription {
  return {
    pins: {},
    ports: {
      show: { direction: 'input', type: 'number' },
      echo: { direction: 'output', type: 'number' },
      ...extra,
    },
    states: { value: { type: 'f64', initial: -1 } },
    behaviors: {
      initialize: (api) => {
        api.topics.subscribe('show', (entry) => {
          entry.state<'f64'>('value').store(entry.args[0] as never);
        });
      },
      tick: (api) => {
        api.topics.publish('echo', [api.state<'f64'>('value').load()]);
      },
    },
  };
}

/** Both devices run real IR logic, so topics have something to move. */
const resolveDevice: NonNullable<CircuitExecutorOptions['resolveDevice']> = (reference) => {
  if (reference.deviceId === 'sensor') {
    return { type: 'adapter-sensor', description: sensorDescription };
  }
  if (reference.deviceId === 'display') {
    return { type: 'adapter-display', description: displayDescription() };
  }
  return undefined;
};

function symbolOf(id: string, device: string, designator: string, x: number): SchematicSymbol {
  return { id, device, designator, x, y: 0, rotation: 0 };
}

function sheetOf(symbols: readonly SchematicSymbol[]): SchematicDocument {
  return {
    version: SCHEMATIC_VERSION,
    sheet: { symbols, wires: [], junctions: [] },
  };
}

const sheet = sheetOf([
  symbolOf('sym-sensor', SENSOR_DEVICE, 'U1', 0),
  symbolOf('sym-display', DISPLAY_DEVICE, 'DS1', 100),
]);

function createExecutor(overrides: Partial<CircuitExecutorOptions> = {}) {
  return createCircuitExecutor({
    devices: provider(),
    resolveDevice,
    ...overrides,
  });
}

describe('createCircuitExecutor', () => {
  it('starts idle and refuses to advance before a load', () => {
    const executor = createExecutor();

    expect(executor.getState()).toBe('idle');
    expect(executor.getSimTime()).toBe(0);
    expect(executor.getTopics()).toEqual([]);
    expect(() => executor.advance(timePs(1000))).toThrow(SimulatorError);
  });

  it('loads a schematic into a ready circuit', async () => {
    const executor = createExecutor();

    await executor.loadSchematic(sheet);

    expect(executor.getState()).toBe('ready');
    expect(executor.getSchematic()).toBe(sheet);
    expect(executor.getSimTime()).toBe(0);
    expect(executor.getTopics()).toEqual([
      {
        symbol: 'sym-sensor',
        designator: 'U1',
        port: 'level',
        direction: 'output',
        type: 'number',
      },
      {
        symbol: 'sym-display',
        designator: 'DS1',
        port: 'show',
        direction: 'input',
        type: 'number',
      },
      {
        symbol: 'sym-display',
        designator: 'DS1',
        port: 'echo',
        direction: 'output',
        type: 'number',
      },
    ]);
  });

  it('converts picoseconds into circuit ticks', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    const report = executor.advance(timePs(TICK_PS * 16));

    expect(TICK_PS).toBe(1_000_000);
    expect(report).toEqual({
      from: 0,
      to: TICK_PS * 16,
      executed: 16,
      reason: 'until',
    });
    expect(executor.getSimTime()).toBe(TICK_PS * 16);
  });

  it('carries sub-tick deltas until a whole tick has accumulated', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    const first = executor.advance(timePs(TICK_PS - 1));
    // The clock still follows the host's slices, but no tick ran.
    expect(first.executed).toBe(0);
    expect(first.to).toBe(TICK_PS - 1);
    expect(executor.getSimTime()).toBe(TICK_PS - 1);

    // The carry plus a 10 ns slice crosses the microsecond boundary.
    const second = executor.advance(timePs(10_000));
    expect(second.executed).toBe(1);
    expect(second.to).toBe(TICK_PS + 9_999);
    expect(executor.getSimTime()).toBe(TICK_PS + 9_999);
  });

  it('runs one tick per hundred 10 ns steps, like the playground bench', async () => {
    const executor = createExecutor();
    const publishes: DevicePublish[] = [];
    executor.onPublish((publish) => publishes.push(publish));
    await executor.loadSchematic(sheet);

    for (let step = 0; step < 99; step += 1) executor.advance(timePs(10_000));
    expect(publishes).toEqual([]);
    expect(executor.getSimTime()).toBe(990_000);

    executor.advance(timePs(10_000));
    expect(executor.getSimTime()).toBe(TICK_PS);
    // One tick ran both devices' tick phases.
    expect(publishes.map((publish) => publish.target.symbol)).toEqual([
      'sym-sensor',
      'sym-display',
    ]);
  });

  it('rejects a non-positive or fractional delta', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    expect(() => executor.advance(timePs(0))).toThrow(SimulatorError);
    expect(() => executor.advance(1.5 as never)).toThrow(SimulatorError);
  });

  it('queues a delivery until the next advance', async () => {
    const executor = createExecutor();
    const publishes: DevicePublish[] = [];
    executor.onPublish((publish) => publishes.push(publish));
    await executor.loadSchematic(sheet);

    executor.deliver({ symbol: 'sym-display', port: 'show' }, 7);
    expect(publishes).toEqual([]);

    executor.advance(timePs(TICK_PS * 3));

    const echoes = publishes
      .filter((publish) => publish.target.symbol === 'sym-display')
      .map((publish) => publish.payload);
    expect(echoes).toEqual([7, 7, 7]);
  });

  it('forwards device publishes with schematic identity and picosecond time', async () => {
    const executor = createExecutor();
    const listener = vi.fn();
    executor.onPublish(listener);
    await executor.loadSchematic(sheet);

    executor.advance(timePs(TICK_PS * 2));

    // Devices publish in execution order: the sensor, then the display, per tick.
    expect(listener.mock.calls.map((call) => call[0].payload)).toEqual([1, -1, 2, -1]);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      target: { symbol: 'sym-sensor', port: 'level' },
      simTime: 0,
    });

    executor.advance(timePs(TICK_PS * 2));
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ simTime: TICK_PS * 2 });
  });

  it('validates deliveries against the compiled endpoints, not the package', async () => {
    const executor = createExecutor({
      resolveDevice: (reference) =>
        reference.deviceId === 'display'
          ? {
              type: 'adapter-display',
              description: displayDescription({
                mode: { direction: 'input', type: 'boolean' },
              }),
            }
          : { type: 'adapter-sensor', description: sensorDescription },
    });
    await executor.loadSchematic(sheet);

    expect(executor.getTopics()).toContainEqual({
      symbol: 'sym-display',
      designator: 'DS1',
      port: 'mode',
      direction: 'input',
      type: 'boolean',
    });
    expect(() => executor.deliver({ symbol: 'sym-display', port: 'mode' }, true)).not.toThrow();
  });

  it('rejects an unknown target and a non-input port', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    expect(() => executor.deliver({ symbol: 'nope', port: 'show' }, 1)).toThrow(/no device symbol/);
    expect(() => executor.deliver({ symbol: 'sym-display', port: 'nope' }, 1)).toThrow(
      /has no port/,
    );
    expect(() => executor.deliver({ symbol: 'sym-display', port: 'echo' }, 1)).toThrow(
      /output, not an input/,
    );
  });

  it('rejects a bad payload without faulting or advancing the clock', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    executor.deliver({ symbol: 'sym-display', port: 'show' }, 'nope');

    // A rejected payload never reaches a tick: the error surfaces from the
    // slice, the executor stays ready and the clock does not move.
    expect(() => executor.advance(timePs(TICK_PS))).toThrow(/expects a number/);
    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(0);

    executor.advance(timePs(TICK_PS));
    expect(executor.getSimTime()).toBe(TICK_PS);
  });

  it('resets the circuit to time zero and its declared state', async () => {
    const executor = createExecutor();
    const publishes: DevicePublish[] = [];
    executor.onPublish((publish) => publishes.push(publish));
    await executor.loadSchematic(sheet);

    executor.deliver({ symbol: 'sym-display', port: 'show' }, 9);
    executor.advance(timePs(TICK_PS * 4));
    expect(executor.getSimTime()).toBe(TICK_PS * 4);

    executor.reset();
    publishes.length = 0;
    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(0);

    executor.advance(timePs(TICK_PS));
    // The sensor counter restarted, and the display lost the delivered value.
    expect(publishes.map((publish) => publish.payload)).toEqual([1, -1]);
  });

  it('stops simulating the previous sheet when a load fails', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);
    executor.advance(timePs(TICK_PS * 2));

    const broken = sheetOf([symbolOf('sym-ghost', GHOST_DEVICE, 'U9', 0)]);
    await expect(executor.loadSchematic(broken)).rejects.toMatchObject({
      name: 'SimulatorError',
      code: 'simulator/schematic-compile-failed',
    });

    expect(executor.getState()).toBe('ready');
    expect(executor.getSchematic()).toBe(sheet);
    expect(executor.getSimTime()).toBe(TICK_PS * 2);
  });

  it('loads an empty sheet and still advances the clock', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheetOf([]));

    expect(executor.getState()).toBe('ready');
    expect(executor.getTopics()).toEqual([]);
    const report = executor.advance(timePs(TICK_PS * 5));
    expect(report.executed).toBe(5);
    expect(executor.getSimTime()).toBe(TICK_PS * 5);

    executor.reset();
    expect(executor.getSimTime()).toBe(0);
  });

  it('disposes once and rejects later calls', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(sheet);

    executor.dispose();
    executor.dispose();

    expect(executor.getState()).toBe('disposed');
    expect(() => executor.advance(timePs(TICK_PS))).toThrow(/disposed/);
    expect(() => executor.deliver({ symbol: 'sym-sensor', port: 'level' }, 1)).toThrow(/disposed/);
    await expect(executor.loadSchematic(sheet)).rejects.toThrow(/disposed/);
    expect(executor.onPublish(() => {})).toBeInstanceOf(Function);
  });

  it('stops delivering to a listener after unsubscribe', async () => {
    const executor = createExecutor();
    const listener = vi.fn();
    const unsubscribe = executor.onPublish(listener);
    await executor.loadSchematic(sheet);

    executor.advance(timePs(TICK_PS));
    unsubscribe();
    executor.advance(timePs(TICK_PS));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reports compile diagnostics to the host', async () => {
    const diagnostics = vi.fn();
    const executor = createExecutor({ onDiagnostic: diagnostics });

    await expect(
      executor.loadSchematic(sheetOf([symbolOf('sym-ghost', GHOST_DEVICE, 'U9', 0)])),
    ).rejects.toThrow();

    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'simulator/schematic-diagnostic',
        symbol: 'sym-ghost',
        message: expect.stringContaining('unknown-device'),
      }),
    );
  });
});

/**
 * Probe sampling needs an electrical model: a device with a declared contact,
 * the board wiring the sheet does not draw, and the rail that feeds it.
 */
describe('createCircuitExecutor probes', () => {
  const SWITCH_DEVICE = 'mica:ideal-button';
  const BOARD = 'board';

  function switchProvider(): IDeviceProvider {
    const definition: DeviceDefinition = {
      definition: parseDeviceDescription(
        {
          pins: {
            A: { kind: 'signal', side: 'left' },
            B: { kind: 'signal', side: 'right' },
          },
          connections: { contact: { pins: ['A', 'B'], initial: 'open' } },
          ports: { pressed: { direction: 'input', type: 'boolean' } },
        },
        { name: SWITCH_DEVICE },
      ),
      code: '',
    };
    return { resolve: (deviceId) => (deviceId === SWITCH_DEVICE ? definition : undefined) };
  }

  /** `board` pins the sheet does not draw: VCC, GND and the SENSE tap. */
  const topology: TopologyDefinition = {
    pins: [
      { instanceId: BOARD, pinName: 'VCC', kind: 'power' },
      { instanceId: BOARD, pinName: 'GND', kind: 'gnd' },
      { instanceId: BOARD, pinName: 'SENSE', kind: 'signal' },
      { instanceId: 'sym-sw', pinName: 'A', kind: 'signal' },
      { instanceId: 'sym-sw', pinName: 'B', kind: 'signal' },
    ],
    wires: [
      { wireId: 'ground', pins: [{ instanceId: BOARD, pinName: 'GND' }], globalGnd: true },
      {
        wireId: 'vcc',
        pins: [
          { instanceId: 'sym-sw', pinName: 'A' },
          { instanceId: BOARD, pinName: 'VCC' },
        ],
      },
      {
        wireId: 'sense',
        pins: [
          { instanceId: 'sym-sw', pinName: 'B' },
          { instanceId: BOARD, pinName: 'SENSE' },
        ],
      },
    ],
    connections: [
      { instanceId: 'sym-sw', connectionId: 'contact', pins: ['A', 'B'], initial: 'open' },
    ],
  };

  function switchExecutor() {
    return createCircuitExecutor({
      devices: switchProvider(),
      topology,
      resolveDevice: () => ({
        type: 'ideal-button',
        description: createIdealButtonDescription(),
      }),
    });
  }

  const switchSheet = sheetOf([symbolOf('sym-sw', SWITCH_DEVICE, 'S1', 0)]);

  it('samples a device pin by symbol id and by designator', async () => {
    const executor = switchExecutor();
    await executor.loadSchematic(switchSheet);
    executor.advance(timePs(TICK_PS));

    // The contact is open, so B is not tied to the VCC rail.
    expect(executor.samplePin?.('sym-sw', 'B')).toEqual({ value: 0, ready: true });
    expect(executor.samplePin?.('S1', 'B')).toEqual({ value: 0, ready: true });
  });

  it('samples a board pin through the device pin on the same wire', async () => {
    const executor = switchExecutor();
    await executor.loadSchematic(switchSheet);

    expect(executor.samplePin?.(BOARD, 'SENSE')).toEqual({ value: 0, ready: true });
    executor.deliver({ symbol: 'sym-sw', port: 'pressed' }, true);
    executor.advance(timePs(TICK_PS));
    // The closed contact carries the VCC rail into the SENSE wire.
    expect(executor.samplePin?.(BOARD, 'SENSE')).toEqual({ value: 1, ready: true });
  });

  it('samples a connection and follows the applied patch', async () => {
    const executor = switchExecutor();
    await executor.loadSchematic(switchSheet);

    expect(executor.sampleConnection?.('sym-sw', 'contact')).toEqual({
      state: 'open',
      ready: true,
    });
    executor.deliver({ symbol: 'sym-sw', port: 'pressed' }, true);
    expect(executor.sampleConnection?.('sym-sw', 'contact')).toEqual({
      state: 'open',
      ready: true,
    });

    executor.advance(timePs(TICK_PS));
    expect(executor.sampleConnection?.('S1', 'contact')).toEqual({ state: 'closed', ready: true });

    executor.deliver({ symbol: 'sym-sw', port: 'pressed' }, false);
    executor.advance(timePs(TICK_PS));
    expect(executor.sampleConnection?.('sym-sw', 'contact')).toEqual({
      state: 'open',
      ready: true,
    });
  });

  it('rejects a probe before a load and for an unknown symbol', async () => {
    const executor = switchExecutor();
    expect(() => executor.samplePin?.('sym-sw', 'B')).toThrow(SimulatorError);

    await executor.loadSchematic(switchSheet);
    expect(() => executor.samplePin?.('nope', 'B')).toThrow(/Device nope not found/);
    // The message names the device id the circuit keys pins by (the designator).
    expect(() => executor.sampleConnection?.('sym-sw', 'nope')).toThrow(
      /Connection S1.nope not found/,
    );
  });
});
