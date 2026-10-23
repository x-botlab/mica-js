import { timePs, type TimePs } from '@mica-js/core';
import type { SchematicDocument, SchematicSymbol } from '@mica-js/core/schematic';
import { parseDeviceDescription, type IDeviceProvider } from '@mica-js/device';
import { describe, expect, it } from 'vitest';
import { createDeviceSimExecutor, SimulatorError, type DevicePublish } from './index';

const MIRROR = 'acme:mirror';
const TICKER = 'acme:ticker';
const BROKEN = 'acme:broken';

const MIRROR_CODE = `
export default function createDevice(api) {
  api.subscribe('value', (payload) => {
    api.publish('mirror', payload);
  });
  return {};
}
`;

const TICKER_CODE = `
export default function createDevice(api) {
  const tick = api.ir.entry('tick', []);
  const emitted = api.ir.output('tickOut', { params: ['u32'], capacity: 8 });
  const initialize = api.ir.lifecycle('initialize', []);

  tick.body((b) => {
    b.output(emitted, [b.const('u32', 1)]);
    b.return([]);
  });
  initialize.body((b) => {
    b.event.at(tick, b.const('f64', 1000), []);
    b.event.at(tick, b.const('f64', 2000), []);
    b.event.at(tick, b.const('f64', 3000), []);
    b.return([]);
  });

  api.onOutput(emitted, (value) => {
    api.publish('count', value[0]);
  });
  return { initialize };
}
`;

const BROKEN_CODE = `
export default function createDevice() {
  throw new Error('factory boom');
}
`;

const FIXTURES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  [MIRROR]: {
    ports: {
      value: { direction: 'input', type: 'number' },
      mirror: { direction: 'output', type: 'number', title: 'Mirror' },
    },
  },
  [TICKER]: {
    ports: { count: { direction: 'output', type: 'number' } },
  },
  [BROKEN]: {},
};

const CODE: Readonly<Record<string, string>> = {
  [MIRROR]: MIRROR_CODE,
  [TICKER]: TICKER_CODE,
  [BROKEN]: BROKEN_CODE,
};

/** Resolves the fixture set; unknown ids behave like a provider without that device. */
function createProvider(): IDeviceProvider {
  return {
    resolve(deviceId: string) {
      const fixture = FIXTURES[deviceId];
      const code = CODE[deviceId];
      if (fixture === undefined || code === undefined) {
        return undefined;
      }
      return { definition: parseDeviceDescription(fixture, { name: deviceId }), code };
    },
  };
}

function symbolOf(id: string, device: string): SchematicSymbol {
  return { id, device, x: 0, y: 0, rotation: 0 };
}

function schematic(...symbols: readonly SchematicSymbol[]): SchematicDocument {
  return { version: 1, sheet: { symbols, wires: [], junctions: [] } };
}

function createExecutor(onDiagnostic?: (diagnostic: unknown) => void) {
  return createDeviceSimExecutor({
    devices: createProvider(),
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
}

function captured(executor: ReturnType<typeof createExecutor>): DevicePublish[] {
  const publishes: DevicePublish[] = [];
  executor.onPublish((publish) => {
    publishes.push(publish);
  });
  return publishes;
}

describe('createDeviceSimExecutor', () => {
  it('starts idle with an empty sheet and refuses to advance', () => {
    const executor = createExecutor();

    expect(executor.getState()).toBe('idle');
    expect(executor.getSimTime()).toBe(0);
    expect(executor.getTopics()).toEqual([]);
    expect(executor.getSchematic().sheet.symbols).toEqual([]);
    expect(() => executor.advance(timePs(1))).toThrowError(SimulatorError);
  });

  it('mounts one instance per symbol and indexes its ports', async () => {
    const executor = createExecutor();

    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR), symbolOf('u2', TICKER)));

    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(0);
    expect(executor.getTopics()).toEqual([
      { symbol: 'u1', port: 'value', direction: 'input', type: 'number' },
      { symbol: 'u1', port: 'mirror', direction: 'output', type: 'number', title: 'Mirror' },
      { symbol: 'u2', port: 'count', direction: 'output', type: 'number' },
    ]);
  });

  it('keeps the running simulation when a device cannot be resolved', async () => {
    const executor = createExecutor();
    const loaded = schematic(symbolOf('u1', MIRROR));
    await executor.loadSchematic(loaded);

    await expect(
      executor.loadSchematic(schematic(symbolOf('u1', MIRROR), symbolOf('u9', 'acme:missing'))),
    ).rejects.toMatchObject({ code: 'simulator/device-load-failed', symbol: 'u9' });

    expect(executor.getState()).toBe('ready');
    expect(executor.getSchematic()).toBe(loaded);
    expect(executor.getTopics()).toHaveLength(2);
  });

  it('reports a failing device factory as an instance failure', async () => {
    const executor = createExecutor();

    await expect(executor.loadSchematic(schematic(symbolOf('u1', BROKEN)))).rejects.toMatchObject({
      code: 'simulator/instance-create-failed',
      symbol: 'u1',
    });
    expect(executor.getState()).toBe('idle');
  });

  it('delivers queued payloads at the start of the next slice', async () => {
    const executor = createExecutor();
    const publishes = captured(executor);
    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR)));

    executor.deliver({ symbol: 'u1', port: 'value' }, 42);
    expect(publishes).toEqual([]);

    const report = executor.advance(timePs(1));

    expect(report).toEqual({ from: 0, to: 1, executed: 0, reason: 'until' });
    expect(publishes).toEqual([
      { target: { symbol: 'u1', port: 'mirror' }, payload: 42, simTime: 0 },
    ]);
  });

  it('runs scheduled entries and stamps publishes with the entry time', async () => {
    const executor = createExecutor();
    const publishes = captured(executor);
    await executor.loadSchematic(schematic(symbolOf('u1', TICKER)));

    expect(executor.advance(timePs(1000))).toEqual({
      from: 0,
      to: 1000,
      executed: 1,
      reason: 'until',
    });
    expect(publishes).toEqual([
      { target: { symbol: 'u1', port: 'count' }, payload: 1, simTime: 1000 },
    ]);

    executor.advance(timePs(1000));
    expect(publishes).toHaveLength(2);
    expect(publishes[1]?.simTime).toBe(2000);

    const last = executor.advance(timePs(1500));
    expect(last).toEqual({ from: 2000, to: 3500, executed: 1, reason: 'until' });
    expect(publishes).toHaveLength(3);
    expect(publishes[2]?.simTime).toBe(3000);
  });

  it('rejects unknown symbols, unknown ports and output targets', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR)));

    expect(() => executor.deliver({ symbol: 'u9', port: 'value' }, 1)).toThrowError(
      /no symbol "u9"/,
    );
    expect(() => executor.deliver({ symbol: 'u1', port: 'nope' }, 1)).toThrowError(
      /no port "nope"/,
    );
    expect(() => executor.deliver({ symbol: 'u1', port: 'mirror' }, 1)).toThrowError(
      /is an output/,
    );
  });

  it('rejects a slice that is not a positive whole number', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR)));

    for (const delta of [0, -1, 1.5, Number.NaN]) {
      expect(() => executor.advance(delta as TimePs)).toThrowError(/positive whole number/);
    }
    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(0);
  });

  it('rebuilds the same schematic at time zero on reset', async () => {
    const executor = createExecutor();
    const publishes = captured(executor);
    const loaded = schematic(symbolOf('u1', TICKER));
    await executor.loadSchematic(loaded);
    executor.advance(timePs(1000));
    expect(publishes).toHaveLength(1);

    // Synchronous on purpose: the modules are cached, so a reset never yields the host thread.
    expect(executor.reset()).toBeUndefined();

    expect(executor.getSimTime()).toBe(0);
    expect(executor.getSchematic()).toBe(loaded);
    executor.advance(timePs(1000));
    expect(publishes).toHaveLength(2);
    expect(publishes[1]?.simTime).toBe(1000);
  });

  it('is idempotent on dispose and blocks the host API afterwards', async () => {
    const executor = createExecutor();
    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR)));

    expect(executor.dispose()).toBeUndefined();
    expect(executor.dispose()).toBeUndefined();

    expect(executor.getState()).toBe('disposed');
    expect(executor.getTopics()).toEqual([]);
    expect(() => executor.advance(timePs(1))).toThrowError(SimulatorError);
    expect(() => executor.deliver({ symbol: 'u1', port: 'value' }, 1)).toThrowError(SimulatorError);
    expect(() => executor.reset()).toThrowError(SimulatorError);
    await expect(executor.loadSchematic(schematic())).rejects.toMatchObject({
      code: 'simulator/disposed',
    });
  });

  it('keeps a throwing publish listener from stopping the simulation', async () => {
    const diagnostics: { code: string }[] = [];
    const executor = createExecutor((diagnostic) => {
      diagnostics.push(diagnostic as { code: string });
    });
    const publishes = captured(executor);
    executor.onPublish(() => {
      throw new Error('listener boom');
    });
    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR)));

    executor.deliver({ symbol: 'u1', port: 'value' }, 7);
    executor.advance(timePs(1));

    expect(publishes).toHaveLength(1);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['simulator/publish-failed']);
    expect(executor.getState()).toBe('ready');
  });
});
