import { timePs, type TimePs } from '@mica-js/core';
import {
  synthesizeDeviceSymbol,
  symbolPinPosition,
  type SchematicDocument,
  type SchematicSymbol,
} from '@mica-js/core/schematic';
import { parseDeviceDescription, type IDeviceProvider } from '@mica-js/device';
import { describe, expect, it } from 'vitest';
import { createCircuitHost, createDeviceSimExecutor, SimulatorError, type DevicePublish } from './index';

const MIRROR = 'acme:mirror';
const TICKER = 'acme:ticker';
const BROKEN = 'acme:broken';
const BUTTON = 'acme:button';
const PROBE = 'acme:probe';

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

const BUTTON_CODE = `
export default function createDevice(api) {
  const ir = api.ir;
  const contact = ir.connection('contact');
  const setPressed = ir.entry('setPressed', ['bool']);
  const initialize = ir.lifecycle('initialize', []);

  setPressed.body((b, [pressed]) => {
    b.connection.apply([{ connection: contact, closed: pressed }]);
    b.return([]);
  });
  initialize.body((b) => {
    b.connection.apply([{ connection: contact, closed: b.const('bool', false) }]);
    b.return([]);
  });

  const stop = api.subscribe('pressed', (pressed) => api.post(setPressed, [pressed]));
  return { initialize, onDispose: stop };
}
`;

const PROBE_CODE = `
export default function createDevice(api) {
  const ir = api.ir;
  const input = ir.pin('IN');
  const count = ir.state('count', 'u32', 0);
  const hit = ir.entry('hit', ['u8']);
  const emitted = ir.output('hits', { params: ['u32'], capacity: 8 });
  const initialize = ir.lifecycle('initialize', []);
  const observation = ir.observeDigital('input', {
    trigger: input,
    captures: [],
    target: hit,
  });

  hit.body((b) => {
    const next = b.int.add(b.state.load(count), b.const('u32', 1));
    b.state.store(count, next);
    b.output(emitted, [next]);
    b.return([]);
  });
  initialize.body((b) => {
    b.state.store(count, b.const('u32', 0));
    b.pin.configure(input, { mode: 'high-z', outputEnabled: false, pull: 'up' });
    b.observe.configure(observation, { enabled: true, edges: 'falling' });
    b.return([]);
  });

  api.onOutput(emitted, ([value]) => {
    api.publish('count', value);
  });
  return { initialize };
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
  [BUTTON]: {
    pins: {
      A: { kind: 'signal', side: 'right' },
      B: { kind: 'signal', side: 'left' },
    },
    connections: { contact: { pins: ['A', 'B'], initial: 'open' } },
    ports: { pressed: { direction: 'input', type: 'boolean' } },
  },
  [PROBE]: {
    pins: {
      VCC: { kind: 'power', side: 'left' },
      GND: { kind: 'gnd', side: 'left' },
      IN: { kind: 'signal', side: 'left' },
    },
    ports: { count: { direction: 'output', type: 'number' } },
  },
  [BROKEN]: {},
};

const CODE: Readonly<Record<string, string>> = {
  [MIRROR]: MIRROR_CODE,
  [TICKER]: TICKER_CODE,
  [BUTTON]: BUTTON_CODE,
  [PROBE]: PROBE_CODE,
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

function symbolOf(id: string, device: string, designator?: string): SchematicSymbol {
  return {
    id,
    device,
    x: 0,
    y: 0,
    rotation: 0,
    ...(designator === undefined ? {} : { designator }),
  };
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

/** Executor whose pins and connections come from the sheet's nets, like a drawn schematic. */
function createWiredExecutor() {
  return createDeviceSimExecutor({ devices: createProvider(), host: createCircuitHost() });
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

    await executor.loadSchematic(schematic(symbolOf('u1', MIRROR, 'U1'), symbolOf('u2', TICKER)));

    expect(executor.getState()).toBe('ready');
    expect(executor.getSimTime()).toBe(0);
    // `designator` falls back to the symbol id when the schematic does not name the part.
    expect(executor.getTopics()).toEqual([
      { symbol: 'u1', designator: 'U1', port: 'value', direction: 'input', type: 'number' },
      {
        symbol: 'u1',
        designator: 'U1',
        port: 'mirror',
        direction: 'output',
        type: 'number',
        title: 'Mirror',
      },
      { symbol: 'u2', designator: 'u2', port: 'count', direction: 'output', type: 'number' },
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

const SHEET = {
  button: '00000021-0000-4000-8000-000000000001',
  probe: '00000022-0000-4000-8000-000000000001',
  power: '00000023-0000-4000-8000-000000000001',
  ground: '00000024-0000-4000-8000-000000000001',
} as const;

const BUTTON_AT = { x: 100, y: 120 };
const PROBE_AT = { x: 340, y: 120 };
const POWER_AT = { x: 60, y: 40 };
const GROUND_AT = { x: 60, y: 320 };

/** Pin anchor of a synthesized symbol, i.e. the geometry the schematic was drawn against. */
function anchorOf(device: string, pin: string, placement: { x: number; y: number }) {
  const definition = parseDeviceDescription(FIXTURES[device] ?? {}, { name: device });
  const symbol = synthesizeDeviceSymbol({
    name: device,
    pins: Object.fromEntries(
      [...definition.pins.values()].map((descriptor) => [
        descriptor.key,
        { side: descriptor.side },
      ]),
    ),
  });
  const anchor = symbol.pins[pin];
  if (anchor === undefined) {
    throw new Error(`${device} has no pin ${pin}`);
  }
  return symbolPinPosition({ ...placement, rotation: 0 }, anchor);
}

/**
 * Button contact to the probe input, contact return to the ground rail and the probe chip on the
 * supply rails: every connection in this sheet has to go through the derived nets.
 */
function wiredSchematic(): SchematicDocument {
  const buttonA = anchorOf(BUTTON, 'A', BUTTON_AT);
  const buttonB = anchorOf(BUTTON, 'B', BUTTON_AT);
  const probeIn = anchorOf(PROBE, 'IN', PROBE_AT);
  const probeSupply = anchorOf(PROBE, 'VCC', PROBE_AT);
  const probeGround = anchorOf(PROBE, 'GND', PROBE_AT);
  return {
    version: 1,
    sheet: {
      symbols: [
        { id: SHEET.button, device: BUTTON, designator: 'S1', ...BUTTON_AT, rotation: 0 },
        { id: SHEET.probe, device: PROBE, designator: 'U1', ...PROBE_AT, rotation: 0 },
        { id: SHEET.power, device: 'builtin:power', net: '5V', ...POWER_AT, rotation: 0 },
        { id: SHEET.ground, device: 'builtin:ground', net: 'GND', ...GROUND_AT, rotation: 0 },
      ],
      wires: [
        {
          id: '00000031-0000-4000-8000-000000000001',
          points: [
            buttonA,
            { x: buttonA.x + 30, y: buttonA.y },
            { x: buttonA.x + 30, y: probeIn.y },
            probeIn,
          ],
        },
        {
          id: '00000032-0000-4000-8000-000000000001',
          points: [
            buttonB,
            { x: buttonB.x - 10, y: buttonB.y },
            { x: buttonB.x - 10, y: GROUND_AT.y },
            GROUND_AT,
          ],
        },
        {
          id: '00000033-0000-4000-8000-000000000001',
          points: [
            probeSupply,
            { x: probeSupply.x - 30, y: probeSupply.y },
            { x: probeSupply.x - 30, y: POWER_AT.y },
            POWER_AT,
          ],
        },
        {
          id: '00000034-0000-4000-8000-000000000001',
          points: [
            probeGround,
            { x: probeGround.x + 10, y: probeGround.y },
            { x: probeGround.x + 10, y: GROUND_AT.y },
            GROUND_AT,
          ],
        },
      ],
      junctions: [],
    },
  };
}

describe('createDeviceSimExecutor electrical network', () => {
  it('counts the transitions a wired button contact produces', async () => {
    const executor = createWiredExecutor();
    const publishes = captured(executor);
    await executor.loadSchematic(wiredSchematic());

    // A held pull-up with an open contact reads high, so closing it is a falling edge.
    executor.deliver({ symbol: SHEET.button, port: 'pressed' }, true);
    executor.advance(timePs(1_000_000));
    expect(publishes.map((publish) => publish.payload)).toEqual([1]);

    executor.deliver({ symbol: SHEET.button, port: 'pressed' }, false);
    executor.advance(timePs(1_000_000));
    expect(publishes).toHaveLength(1);

    executor.deliver({ symbol: SHEET.button, port: 'pressed' }, true);
    executor.advance(timePs(1_000_000));
    expect(publishes.map((publish) => publish.payload)).toEqual([1, 2]);
    expect(publishes.every((publish) => publish.target.symbol === SHEET.probe)).toBe(true);
  });

  it('solves the same nets again after a reset', async () => {
    const executor = createWiredExecutor();
    const publishes = captured(executor);
    await executor.loadSchematic(wiredSchematic());

    executor.deliver({ symbol: SHEET.button, port: 'pressed' }, true);
    executor.advance(timePs(1_000_000));
    expect(publishes).toHaveLength(1);

    executor.reset();
    executor.deliver({ symbol: SHEET.button, port: 'pressed' }, true);
    executor.advance(timePs(1_000_000));

    expect(publishes.map((publish) => publish.payload)).toEqual([1, 1]);
    expect(executor.getSimTime()).toBe(1_000_000);
  });

  it('refuses a schematic whose symbols name unloaded devices', async () => {
    const executor = createWiredExecutor();
    const sheet = wiredSchematic();
    const stray: SchematicSymbol = {
      id: '00000025-0000-4000-8000-000000000001',
      device: 'acme:missing',
      x: 600,
      y: 120,
      rotation: 0,
    };

    await expect(
      executor.loadSchematic({
        ...sheet,
        sheet: { ...sheet.sheet, symbols: [...sheet.sheet.symbols, stray] },
      }),
    ).rejects.toMatchObject({ code: 'simulator/device-load-failed', symbol: stray.id });
  });
});
