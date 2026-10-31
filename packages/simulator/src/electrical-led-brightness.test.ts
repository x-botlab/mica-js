import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { toNumber, type FloatBits } from '@mica-js/ir';
import { Circuit, PIN_MODE, createSchematicDeviceSimulationHost } from './index';
import type { DeviceDescription, SimulationPublish } from './index';
import {
  loadDeviceLibrary,
  type DeviceLibraryFiles,
} from '../../../apps/playground/src/sim/device-library';
import {
  loadDeviceFactories,
  DEMO_ELECTRICAL,
} from '../../../apps/playground/src/sim/device-implementations';
import {
  createContractDevice,
  createContractBinding,
} from '../../../apps/playground/src/sim/device-contracts';

const publicRoot = resolve(import.meta.dirname, '../../../apps/playground/public');
const files: DeviceLibraryFiles = {
  label: 'demo',
  read: (path) => readFile(resolve(publicRoot, 'devices', path)),
};
let library: Awaited<ReturnType<typeof loadDeviceLibrary>>;
let factories: Awaited<ReturnType<typeof loadDeviceFactories>>;
beforeAll(async () => {
  library = await loadDeviceLibrary(files);
  factories = await loadDeviceFactories(files, library);
});
function led(properties = {}) {
  const entry = library.find('demo:ideal-led')!;
  return {
    ...createContractDevice(entry, 'led', factories.get(entry.reference)!)!,
    properties,
  };
}
function brightness(circuit: Circuit) {
  return toNumber(circuit.devices['led']!.getState('brightness') as FloatBits);
}
const driver: DeviceDescription = {
  pins: { OUT: { kind: 'signal' } },
  states: { high: { type: 'bool', initial: false } },
  factory: ({ electrical }) => {
    electrical.initializePin('OUT', {
      drive: { reference: { source: 'VDD' }, highResistance: 50, lowResistance: 50 },
    });
    return {
      initialize(api) {
        const pin = api.pin('OUT');
        pin.configure(PIN_MODE.pushPull);
        pin.setOutputEnabled(api.builder.const('bool', true));
      },
      tick(api) {
        api.pin('OUT').writeDigital(api.state<'bool'>('high').load());
      },
    };
  },
};

describe.each(['reference', 'jit'] as const)('%s LED brightness', (engine) => {
  test.each([
    [0, 0, 5, 0, false],
    [5, 5, 5, 0, false],
    [2.5, 0, 5, 0.5, false],
    [5, 0, 5, 1, true],
    [0, 5, 5, 0, false],
    [10, 0, 5, 1, true],
    [0.25, 0, 0.5, 0.5, false],
    [5, 2.5, 5, 0.5, true],
  ])('DC anode=%s cathode=%s nominal=%s', async (anode, cathode, nominalVoltage, expected, lit) => {
    const circuit = await Circuit.create(
      {
        devices: [led({ nominalVoltage, brightnessSamples: 1 })],
        connections: [
          { from: 'led.anode', to: 'ANODE' },
          { from: 'led.cathode', to: 'CATHODE' },
        ],
      },
      {
        engine,
        electrical: {
          ...DEMO_ELECTRICAL,
          sources: {
            ...DEMO_ELECTRICAL.sources,
            ANODE: { voltage: anode },
            CATHODE: { voltage: cathode },
          },
        },
      },
    );
    try {
      expect(brightness(circuit)).toBe(0);
      circuit.step();
      expect(brightness(circuit)).toBeCloseTo(expected, 12);
      const current = circuit.getCurrent('led.load');
      expect(current.state).toBe('determinate');
      if (current.state === 'determinate')
        expect(current.value).toBeCloseTo((anode - cathode) / 1000, 12);
      // Preserve the original digital threshold interpretation of the lit topic.
      expect(circuit.devices['led']!.getState('lamp')).toBe(lit);
      circuit.reset();
      expect(brightness(circuit)).toBe(0);
      expect(circuit.devices['led']!.getState('lamp')).toBe(false);
      circuit.step();
      expect(brightness(circuit)).toBeCloseTo(expected, 12);
    } finally {
      circuit.dispose();
    }
  });

  test.each([1, 4, 16, 64])(
    'PWM uses exponential moving average with N=%s and reproducible reset',
    async (brightnessSamples) => {
      const circuit = await Circuit.create(
        {
          devices: [
            led({ brightnessSamples }),
            { id: 'driver', type: 'driver', description: driver },
          ],
          connections: [
            { from: 'driver.OUT', to: 'led.anode' },
            { from: 'led.cathode', to: 'GND' },
          ],
        },
        { engine, electrical: DEMO_ELECTRICAL },
      );
      const run = () => {
        let expected = 0;
        const trace: number[] = [];
        // 25% duty cycle. EMA ripples around the duty average, not an exact boxcar.
        const full = 1000 / (1000 + 50);
        const ticks = 256;
        for (let tick = 0; tick < ticks; tick++) {
          const high = tick % 4 === 0;
          circuit.devices['driver']!.setState('high', high);
          circuit.step();
          expected += ((high ? full : 0) - expected) / brightnessSamples;
          expect(circuit.getVoltage('led.anode')).toEqual({
            state: 'determinate',
            value: high ? 5 * full : 0,
          });
          expect(brightness(circuit)).toBeCloseTo(expected, 12);
          expect(circuit.devices['led']!.getState('lamp')).toBe(high);
          trace.push(brightness(circuit));
        }
        // Exact final-cycle mean includes the zero-start EMA transient and tends to 25%.
        const cycleMean = 0.25 * full * (1 - (1 - 1 / brightnessSamples) ** ticks);
        expect(trace.slice(-4).reduce((sum, value) => sum + value, 0) / 4).toBeCloseTo(
          cycleMean,
          12,
        );
        return trace;
      };
      try {
        const first = run();
        circuit.reset();
        expect(brightness(circuit)).toBe(0);
        expect(run()).toEqual(first);
      } finally {
        circuit.dispose();
      }
    },
  );

  test.each([1, 64])(
    'grounded cathode stays physically off with open button; N=%s',
    async (samples) => {
      const entry = library.find('demo:ideal-button')!;
      const circuit = await Circuit.create(
        {
          devices: [
            led(samples === 64 ? {} : { brightnessSamples: 1 }),
            createContractDevice(entry, 'button', factories.get(entry.reference)!)!,
          ],
          connections: [
            { from: 'button.A', to: 'VDD' },
            { from: 'button.B', to: 'led.anode' },
            { from: 'led.cathode', to: 'GND' },
          ],
        },
        { engine, electrical: DEMO_ELECTRICAL },
      );
      const expectUnpowered = () => {
        expect(circuit.getVoltage('led.anode')).toEqual({ state: 'determinate', value: 0 });
        expect(circuit.getCurrent('led.load')).toEqual({ state: 'determinate', value: 0 });
        expect(circuit.devices['led']!.getState('lamp')).toBe(false);
      };
      try {
        circuit.runBatch(8);
        expectUnpowered();
        expect(brightness(circuit)).toBe(0);
        circuit.devices['button']!.setState('pressed', true);
        circuit.step();
        expect(circuit.getVoltage('led.anode')).toEqual({ state: 'determinate', value: 5 });
        expect(circuit.getCurrent('led.load')).toEqual({ state: 'determinate', value: 0.005 });
        expect(brightness(circuit)).toBeCloseTo(1 / samples, 12);
        circuit.devices['button']!.setState('pressed', false);
        circuit.step();
        expectUnpowered();
        // Physical power is already zero; the configured EMA retains its decaying history.
        expect(brightness(circuit)).toBeCloseTo((1 / samples) * (1 - 1 / samples), 12);
        circuit.reset();
        expect(brightness(circuit)).toBe(0);
        circuit.step();
        expectUnpowered();
        expect(brightness(circuit)).toBe(0);
      } finally {
        circuit.dispose();
      }
    },
  );

  test.each([1000, 2000, 0.5])(
    'declared LED load R=%s gives analytic divider voltage and brightness',
    async (resistance) => {
      const series: DeviceDescription = {
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        resistors: { body: { pins: ['A', 'B'] } },
        factory: ({ electrical }) => {
          electrical.initializeResistor('body', { resistance: 1000, enabled: true });
        },
      };
      const circuit = await Circuit.create(
        {
          devices: [
            led({ resistance, brightnessSamples: 1 }),
            { id: 'series', type: 'series', description: series },
          ],
          connections: [
            { from: 'series.A', to: 'VDD' },
            { from: 'series.B', to: 'led.anode' },
            { from: 'led.cathode', to: 'GND' },
          ],
        },
        { engine, electrical: DEMO_ELECTRICAL },
      );
      try {
        circuit.step();
        const voltage = circuit.getVoltage('led.anode');
        expect(voltage.state).toBe('determinate');
        if (voltage.state === 'determinate')
          expect(voltage.value).toBeCloseTo((5 * resistance) / (1000 + resistance), 12);
        expect(brightness(circuit)).toBeCloseTo(resistance / (1000 + resistance), 12);
        const current = circuit.getCurrent('led.load');
        expect(current.state).toBe('determinate');
        if (current.state === 'determinate')
          expect(current.value).toBeCloseTo(5 / (1000 + resistance), 12);
      } finally {
        circuit.dispose();
      }
    },
  );

  test.each([1, 64])(
    'both floating terminals have zero physical current and brightness; N=%s',
    async (brightnessSamples) => {
      const circuit = await Circuit.create(
        { devices: [led({ brightnessSamples })], connections: [] },
        { engine, electrical: { ...DEMO_ELECTRICAL, floatingSeed: 12345 } },
      );
      const run = () =>
        Array.from({ length: 8 }, () => {
          circuit.step();
          expect(circuit.getVoltage('led.anode')).toEqual({ state: 'floating' });
          expect(circuit.getVoltage('led.cathode')).toEqual({ state: 'floating' });
          expect(circuit.getCurrent('led.load')).toEqual({ state: 'determinate', value: 0 });
          expect(brightness(circuit)).toBe(0);
          expect(circuit.devices['led']!.getState('lamp')).toBe(false);
          return brightness(circuit);
        });
      try {
        const first = run();
        circuit.reset();
        expect(run()).toEqual(first);
      } finally {
        circuit.dispose();
      }
    },
  );
});

test.each([
  { nominalVoltage: 0 },
  { nominalVoltage: -1 },
  { nominalVoltage: NaN },
  { nominalVoltage: Infinity },
  { nominalVoltage: '5' },
  { resistance: 0 },
  { resistance: -1 },
  { resistance: NaN },
  { resistance: Infinity },
  { resistance: '1000' },
  { brightnessSamples: 0 },
  { brightnessSamples: -1 },
  { brightnessSamples: 1.5 },
  { brightnessSamples: NaN },
  { brightnessSamples: Infinity },
  { brightnessSamples: 1000001 },
  { brightnessSamples: '4' },
])('rejects invalid LED properties %j', async (properties) => {
  await expect(
    Circuit.create(
      { devices: [led(properties)], connections: [] },
      { electrical: DEMO_ELECTRICAL },
    ),
  ).rejects.toThrow();
});

test('existing host bridge publishes finite numeric brightness, bool lit, and replays after reset', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const schematic = {
    version: 1,
    sheet: {
      symbols: [
        {
          id,
          device: 'demo:ideal-led',
          designator: 'D1',
          x: 0,
          y: 0,
          rotation: 0,
          properties: { brightnessSamples: 4 },
        },
      ],
      wires: [],
      junctions: [],
    },
  };
  const entry = library.find('demo:ideal-led')!;
  const host = createSchematicDeviceSimulationHost({
    electrical: { ...DEMO_ELECTRICAL, floatingSeed: 12345 },
    devices: library.symbols,
    read: async () => new TextEncoder().encode(JSON.stringify(schematic)),
    resolveDevice: () => createContractBinding(entry, factories.get(entry.reference)!),
  });
  const publications: SimulationPublish[] = [];
  const subscription = host.onDidPublish((event) => publications.push(event));
  try {
    await host.loadSchematic('file:///led.sch');
    await host.tick(10);
    const first = publications.slice();
    expect(first).toHaveLength(2);
    expect(first.find((event) => event.target.port === 'brightness')?.payload).toEqual(
      expect.any(Number),
    );
    expect(first.find((event) => event.target.port === 'lit')?.payload).toEqual(
      expect.any(Boolean),
    );
    for (const event of first.filter((event) => event.target.port === 'brightness')) {
      expect(Number.isFinite(event.payload)).toBe(true);
      expect(event.payload).toBeGreaterThanOrEqual(0);
      expect(event.payload).toBeLessThanOrEqual(1);
    }
    await host.reset();
    publications.length = 0;
    await host.tick(10);
    expect(publications).toEqual(first);
  } finally {
    subscription.dispose();
    await host.dispose();
  }
});

type WidgetApi = {
  width: number;
  height: number;
  props: Record<string, unknown>;
  subscribe: (port: string, listener: (payload: unknown) => void) => void;
  invalidate: () => void;
};
test('actual lamp JS preserves boolean mode and gives clamped numeric brightness persistent precedence', async () => {
  const source = await readFile(resolve(publicRoot, 'widgets', 'lamp.js'), 'utf8');
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  )) as {
    default: (api: WidgetApi) => { render: (context: unknown) => void; dispose: () => void };
  };
  const listeners = new Map<string, (payload: unknown) => void>();
  const invalidate = vi.fn();
  const widget = module.default({
    width: 100,
    height: 100,
    props: { color: '#FF3B30', offColor: '#27272A', label: 'LED', radius: 8 },
    subscribe: (port, listener) => {
      listeners.set(port, listener);
    },
    invalidate,
  });
  const fills: { color: string; alpha: number; glow: number }[] = [];
  const stack: { fillStyle: string; globalAlpha: number; shadowBlur: number }[] = [];
  const context = {
    fillStyle: '',
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: '',
    save() {
      stack.push({
        fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha,
        shadowBlur: this.shadowBlur,
      });
    },
    restore() {
      Object.assign(this, stack.pop());
    },
    fill() {
      fills.push({ color: this.fillStyle, alpha: this.globalAlpha, glow: this.shadowBlur });
    },
    clearRect() {},
    beginPath() {},
    roundRect() {},
    arc() {},
    fillText() {},
  };
  const render = () => {
    fills.length = 0;
    widget.render(context);
    return fills.find((fill) => fill.color === '#FF3B30');
  };
  const emit = (port: string, value: unknown) => listeners.get(port)!(value);
  expect(render()).toBeUndefined();
  emit('lit', true);
  expect(render()).toMatchObject({ alpha: 1 });
  const fullGlow = render()!.glow;
  emit('lit', false);
  expect(render()).toBeUndefined();
  for (const malformed of [NaN, Infinity, -Infinity, '0.5', null, {}, true])
    emit('brightness', malformed);
  emit('lit', true);
  expect(render()).toMatchObject({ alpha: 1 });
  emit('brightness', 0.5);
  expect(render()).toEqual({ color: '#FF3B30', alpha: 0.5, glow: fullGlow / 2 });
  expect(fills.some((fill) => fill.color === `rgba(255, 255, 255, ${0.12 + 0.43 * 0.5})`)).toBe(
    true,
  );
  emit('lit', false);
  expect(render()!.alpha).toBe(0.5);
  const count = invalidate.mock.calls.length;
  for (const malformed of [NaN, Infinity, 'bad', undefined, null]) emit('brightness', malformed);
  expect(invalidate).toHaveBeenCalledTimes(count);
  expect(render()!.alpha).toBe(0.5);
  emit('brightness', -2);
  emit('lit', true);
  expect(render()).toBeUndefined();
  emit('brightness', 2);
  expect(render()!.alpha).toBe(1);
  emit('brightness', 0);
  expect(render()).toBeUndefined();
  widget.dispose();
});
