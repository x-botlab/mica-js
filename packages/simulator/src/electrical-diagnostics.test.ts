import { describe, expect, test } from 'vitest';
import { Circuit, PIN_MODE } from './index';
import type { DeviceDescription, ElectricalCurrentTarget } from './index';

const electrical = { sources: { VDD: { voltage: 3.3 } }, interpretation: 'two-state' } as const;
const contact = (name: string): ElectricalCurrentTarget => ({
  kind: 'contact',
  device: 'switch',
  name,
});
function closeTo(circuit: Circuit, target: string | ElectricalCurrentTarget, expected: number) {
  const current = circuit.getCurrent(target);
  expect(current.state).toBe('determinate');
  if (current.state === 'determinate') expect(current.value).toBeCloseTo(expected, 12);
}
const resistor: DeviceDescription = {
  pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
  resistors: { body: { pins: ['A', 'B'] } },
  factory: ({ electrical }) => {
    electrical.initializeResistor('body', { resistance: 50, enabled: true });
  },
};

describe.each(['reference', 'jit'] as const)('%s current identity and diagnostics', (engine) => {
  test.each([false, true])(
    'identifies a bridge contact current with reversed supply=%s',
    async (reverse) => {
      const description: DeviceDescription = {
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        connections: { bridge: { pins: ['A', 'B'], initial: 'closed' } },
        factory: () => undefined,
      };
      const circuit = await Circuit.create(
        {
          devices: [
            { id: 'switch', type: 'switch', description },
            { id: 'load', type: 'load', description: resistor },
          ],
          connections: [
            { from: `switch.${reverse ? 'B' : 'A'}`, to: 'VDD' },
            { from: `switch.${reverse ? 'A' : 'B'}`, to: 'load.A' },
            { from: 'load.B', to: 'GND' },
          ],
        },
        { engine, electrical },
      );
      try {
        closeTo(circuit, contact('bridge'), reverse ? -0.066 : 0.066);
        closeTo(circuit, { kind: 'source', name: 'VDD' }, 0.066);
        closeTo(circuit, { kind: 'source', name: 'GND' }, -0.066);
        closeTo(circuit, 'load.body', 0.066);
        expect(circuit.getDiagnostics()).toEqual([]);
      } finally {
        circuit.dispose();
      }
    },
  );

  test('keeps ideal cycle currents indeterminate but identifies a bridge attached to that cycle', async () => {
    const description: DeviceDescription = {
      pins: {
        A: { kind: 'signal' },
        B: { kind: 'signal' },
        C: { kind: 'signal' },
        D: { kind: 'signal' },
      },
      connections: {
        ab: { pins: ['A', 'B'], initial: 'closed' },
        bc: { pins: ['B', 'C'], initial: 'closed' },
        ca: { pins: ['C', 'A'], initial: 'closed' },
        tail: { pins: ['C', 'D'], initial: 'closed' },
      },
      factory: () => undefined,
    };
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'switch', type: 'switch', description },
          { id: 'load', type: 'load', description: resistor },
        ],
        connections: [
          { from: 'switch.A', to: 'VDD' },
          { from: 'switch.D', to: 'load.A' },
          { from: 'load.B', to: 'GND' },
        ],
      },
      { engine, electrical },
    );
    try {
      for (const name of ['ab', 'bc', 'ca'])
        expect(circuit.getCurrent(contact(name))).toEqual({ state: 'indeterminate' });
      closeTo(circuit, contact('tail'), 0.066);
    } finally {
      circuit.dispose();
    }
  });

  test('reports redundant ideal-source currents as indeterminate and source-free bridge current as zero', async () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
      connections: { bridge: { pins: ['A', 'B'], initial: 'closed' } },
      factory: () => undefined,
    };
    const circuit = await Circuit.create(
      {
        devices: [{ id: 'switch', type: 'switch', description }],
        connections: [
          { from: 'switch.A', to: 'VDD' },
          { from: 'switch.B', to: 'VCC' },
        ],
      },
      {
        engine,
        electrical: { ...electrical, sources: { VDD: { voltage: 3.3 }, VCC: { voltage: 3.3 } } },
      },
    );
    try {
      expect(circuit.getCurrent(contact('bridge'))).toEqual({ state: 'indeterminate' });
      expect(circuit.getCurrent({ kind: 'source', name: 'VDD' })).toEqual({
        state: 'indeterminate',
      });
      expect(circuit.getCurrent({ kind: 'source', name: 'VCC' })).toEqual({
        state: 'indeterminate',
      });
    } finally {
      circuit.dispose();
    }
    const floating = await Circuit.create(
      {
        devices: [
          { id: 'switch', type: 'switch', description },
          { id: 'load', type: 'load', description: resistor },
        ],
        connections: [{ from: 'switch.B', to: 'load.A' }],
      },
      { engine, electrical },
    );
    try {
      expect(floating.getVoltage('switch.A')).toEqual({ state: 'floating' });
      closeTo(floating, contact('bridge'), 0);
      closeTo(floating, 'load.body', 0);
    } finally {
      floating.dispose();
    }
  });

  test.each([
    { ohms: -1, code: 'electrical/invalid-parameter' },
    { ohms: Number.MIN_VALUE, code: 'electrical/numerical-failure' },
  ])(
    'deduplicates overcurrent, clears on recovery, and preserves the last good snapshot on $code',
    async ({ ohms, code }) => {
      const description: DeviceDescription = {
        pins: { OUT: { kind: 'signal' }, GND: { kind: 'gnd' } },
        states: { ohms: { type: 'f64', initial: 50 } },
        resistors: { load: { pins: ['OUT', 'GND'] } },
        factory: ({ electrical }) => {
          electrical.initializePin('OUT', {
            drive: {
              reference: { source: 'VDD' },
              highResistance: 50,
              lowResistance: 50,
              maxAbsCurrent: 0.02,
            },
          });
          electrical.initializeResistor('load', {
            resistance: 50,
            enabled: true,
            maxAbsCurrent: 0.02,
          });
          return {
            initialize: (api) => {
              const pin = api.pin('OUT');
              pin.configure(PIN_MODE.pushPull);
              pin.setOutputEnabled(api.builder.const('bool', true));
              pin.writeDigital(api.builder.const('bool', true));
            },
            tick: (api) => api.resistor('load').setResistance(api.state<'f64'>('ohms').load()),
          };
        },
      };
      const circuit = await Circuit.create(
        {
          devices: [{ id: 'gpio', type: 'gpio', description }],
          connections: [{ from: 'gpio.GND', to: 'GND' }],
        },
        { engine, electrical },
      );
      try {
        closeTo(circuit, { kind: 'drive', device: 'gpio', pin: 'OUT' }, 0.033);
        const initial = circuit.getDiagnostics();
        expect(initial).toHaveLength(2);
        expect(initial.every((value) => value.code === 'electrical/overcurrent')).toBe(true);
        circuit.runBatch(4);
        expect(circuit.getDiagnostics()).toEqual(initial);
        expect(circuit.tickCount).toBe(4n);
        circuit.devices.gpio.setState('ohms', 1000);
        circuit.step();
        expect(circuit.getDiagnostics()).toEqual([]);
        closeTo(circuit, { kind: 'drive', device: 'gpio', pin: 'OUT' }, 3.3 / 1050);
        circuit.devices.gpio.setState('ohms', ohms);
        circuit.runBatch(5);
        expect(circuit.tickCount).toBe(5n);
        const [failure] = circuit.getDiagnostics();
        if (failure?.severity !== 'error') throw new Error('Expected an electrical fault');
        expect(failure).toMatchObject({
          code,
          severity: 'error',
          target: { kind: 'resistor', device: 'gpio', name: 'load' },
        });
        expect(failure?.resources).toContainEqual({
          kind: 'resistor',
          device: 'gpio',
          name: 'load',
        });
        expect(failure?.pins).toEqual(expect.arrayContaining(['gpio.OUT', 'gpio.GND']));
        expect(Object.isFrozen(failure?.resources)).toBe(true);
        expect(Object.isFrozen(failure?.pins)).toBe(true);
        expect(circuit.getDiagnostics()).toEqual([failure]);
        closeTo(circuit, 'gpio.load', 3.3 / 1050);
        circuit.devices.gpio.setState('ohms', 1000);
        circuit.step();
        expect(circuit.tickCount).toBe(5n);
        circuit.reset();
        expect(circuit.getDiagnostics()).toEqual(initial);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(() => circuit.getCurrent({ kind: 'contact', device: 'gpio', name: 'load' })).toThrow(
          'Unknown electrical current',
        );
        expect(() => circuit.getCurrent({ kind: 'source', name: 'missing' })).toThrow(
          'Unknown electrical current',
        );
      } finally {
        circuit.dispose();
      }
      expect(() => circuit.getDiagnostics()).toThrow('disposed');
    },
  );

  test('separates pull currents from active drive and exposes their orientation', async () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'gnd' } },
      resistors: { load: { pins: ['A', 'B'] } },
      factory: ({ electrical }) => {
        electrical.initializePin('A', {
          bias: { reference: { source: 'VDD' }, upResistance: 1000, downResistance: 2000 },
        });
        electrical.initializeResistor('load', { resistance: 1000, enabled: true });
        return { initialize: (api) => api.pin('A').setPull('up') };
      },
    };
    const circuit = await Circuit.create(
      {
        devices: [{ id: 'gpio', type: 'gpio', description }],
        connections: [{ from: 'gpio.B', to: 'GND' }],
      },
      { engine, electrical },
    );
    try {
      closeTo(circuit, { kind: 'pull-up', device: 'gpio', pin: 'A' }, 0.00165);
      closeTo(circuit, { kind: 'pull-down', device: 'gpio', pin: 'A' }, 0);
      closeTo(circuit, { kind: 'source', name: 'VDD' }, 0.00165);
      expect(() => circuit.getCurrent({ kind: 'drive', device: 'gpio', pin: 'A' })).toThrow(
        'Unknown electrical current',
      );
    } finally {
      circuit.dispose();
    }
  });

  test('locates a matrix failure to its network without naming a fabricated culprit', async () => {
    const description: DeviceDescription = {
      pins: {
        P: { kind: 'signal' },
        A: { kind: 'signal' },
        B: { kind: 'signal' },
        N: { kind: 'signal' },
      },
      resistors: {
        feed: { pins: ['P', 'A'] },
        link: { pins: ['A', 'B'] },
        load: { pins: ['B', 'N'] },
        unused: { pins: ['A', 'B'] },
      },
      states: { ohms: { type: 'f64', initial: 50 } },
      factory: ({ electrical }) => {
        electrical.initializeResistor('feed', { resistance: 50, enabled: true });
        electrical.initializeResistor('link', { resistance: 1, enabled: true });
        electrical.initializeResistor('load', { resistance: 50, enabled: true });
        electrical.initializeResistor('unused', { resistance: 100, enabled: false });
        return {
          tick: (api) => {
            const value = api.state<'f64'>('ohms').load();
            api.applyResistors(['feed', 'load'], [value, value]);
          },
        };
      },
    };
    const circuit = await Circuit.create(
      {
        devices: [{ id: 'network', type: 'network', description }],
        connections: [
          { from: 'network.P', to: 'VDD' },
          { from: 'network.N', to: 'GND' },
        ],
      },
      { engine, electrical },
    );
    try {
      expect(circuit.getDiagnostics()).toEqual([]);
      const before = circuit.getVoltage('network.A');
      circuit.devices.network.setState('ohms', 1e30);
      circuit.step();
      const [failure] = circuit.getDiagnostics();
      if (failure?.severity !== 'error') throw new Error('Expected an electrical fault');
      expect(failure.code).toBe('electrical/numerical-failure');
      expect(failure.target).toBeUndefined();
      expect(failure.resources).toEqual(
        expect.arrayContaining([
          { kind: 'resistor', device: 'network', name: 'feed' },
          { kind: 'resistor', device: 'network', name: 'link' },
          { kind: 'resistor', device: 'network', name: 'load' },
        ]),
      );
      expect(failure.resources).not.toContainEqual({
        kind: 'resistor',
        device: 'network',
        name: 'unused',
      });
      expect(failure.pins).toEqual(['network.P', 'network.A', 'network.B', 'network.N']);
      expect(circuit.getVoltage('network.A')).toEqual(before);
      expect(circuit.tickCount).toBe(0n);
      circuit.reset();
      expect(circuit.getDiagnostics()).toEqual([]);
    } finally {
      circuit.dispose();
    }
  });

  test('latches source conflict, leaves contact current snapshot intact, and clears the fault on reset', async () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
      connections: { bridge: { pins: ['A', 'B'], initial: 'open' } },
      states: { closed: { type: 'bool', initial: false } },
      factory: () => ({
        tick: (api) => api.applyConnections(['bridge'], [api.state<'bool'>('closed').load()]),
      }),
    };
    const circuit = await Circuit.create(
      {
        devices: [{ id: 'switch', type: 'switch', description }],
        connections: [
          { from: 'switch.A', to: 'VDD' },
          { from: 'switch.B', to: 'GND' },
        ],
      },
      { engine, electrical },
    );
    try {
      closeTo(circuit, contact('bridge'), 0);
      circuit.devices.switch.setState('closed', true);
      circuit.step();
      expect(circuit.tickCount).toBe(0n);
      const [failure] = circuit.getDiagnostics();
      expect(circuit.getDiagnostics()).toHaveLength(1);
      expect(failure).toMatchObject({
        code: 'electrical/source-conflict',
        severity: 'error',
        resources: expect.arrayContaining([
          { kind: 'source', name: 'VDD' },
          { kind: 'source', name: 'GND' },
          contact('bridge'),
        ]),
        pins: ['switch.A', 'switch.B'],
      });
      circuit.step();
      expect(circuit.getDiagnostics()).toEqual([failure]);
      closeTo(circuit, contact('bridge'), 0);
      expect(circuit.getVoltage('switch.A')).toEqual({ state: 'determinate', value: 3.3 });
      circuit.reset();
      expect(circuit.getDiagnostics()).toEqual([]);
      circuit.step();
      expect(circuit.tickCount).toBe(1n);
    } finally {
      circuit.dispose();
    }
  });
});
