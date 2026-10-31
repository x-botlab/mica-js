import { describe, expect, test } from 'vitest';
import { PIN_MODE } from './index';
import type { DeviceDescription } from './index';
import type { ElectricalCurrentTarget } from './test-helpers/electrical-observation';
import { createTestProbe } from './test-helpers/circuit-probe';
import type { TestProbe } from './test-helpers/circuit-probe';

const electrical = { sources: { VDD: { voltage: 3.3 } }, interpretation: 'two-state' } as const;
const contact = (name: string): ElectricalCurrentTarget => ({
  kind: 'contact',
  device: 'switch',
  name,
});
function closeTo(probe: TestProbe, target: string | ElectricalCurrentTarget, expected: number) {
  const current = probe.current(target);
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
    (reverse) => {
      const description: DeviceDescription = {
        pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
        connections: { bridge: { pins: ['A', 'B'], initial: 'closed' } },
        factory: () => undefined,
      };
      const probe = createTestProbe(
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
      closeTo(probe, contact('bridge'), reverse ? -0.066 : 0.066);
      closeTo(probe, { kind: 'source', name: 'VDD' }, 0.066);
      closeTo(probe, { kind: 'source', name: 'GND' }, -0.066);
      closeTo(probe, 'load.body', 0.066);
      expect(probe.diagnostics()).toEqual([]);
    },
  );

  test('keeps ideal cycle currents indeterminate but identifies a bridge attached to that cycle', () => {
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
    const probe = createTestProbe(
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
    for (const name of ['ab', 'bc', 'ca'])
      expect(probe.current(contact(name))).toEqual({ state: 'indeterminate' });
    closeTo(probe, contact('tail'), 0.066);
  });

  test('reports redundant ideal-source currents as indeterminate and source-free bridge current as zero', () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
      connections: { bridge: { pins: ['A', 'B'], initial: 'closed' } },
      factory: () => undefined,
    };
    const probe = createTestProbe(
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
    expect(probe.current(contact('bridge'))).toEqual({ state: 'indeterminate' });
    expect(probe.current({ kind: 'source', name: 'VDD' })).toEqual({
      state: 'indeterminate',
    });
    expect(probe.current({ kind: 'source', name: 'VCC' })).toEqual({
      state: 'indeterminate',
    });

    const floating = createTestProbe(
      {
        devices: [
          { id: 'switch', type: 'switch', description },
          { id: 'load', type: 'load', description: resistor },
        ],
        connections: [{ from: 'switch.B', to: 'load.A' }],
      },
      { engine, electrical },
    );
    expect(floating.voltage('switch.A')).toEqual({ state: 'floating' });
    closeTo(floating, contact('bridge'), 0);
    closeTo(floating, 'load.body', 0);
  });

  test.each([
    { ohms: -1, code: 'electrical/invalid-parameter' },
    { ohms: Number.MIN_VALUE, code: 'electrical/numerical-failure' },
  ])(
    'deduplicates overcurrent, clears on recovery, and preserves the last good snapshot on $code',
    ({ ohms, code }) => {
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
      const probe = createTestProbe(
        {
          devices: [{ id: 'gpio', type: 'gpio', description }],
          connections: [{ from: 'gpio.GND', to: 'GND' }],
        },
        { engine, electrical },
      );
      closeTo(probe, { kind: 'drive', device: 'gpio', pin: 'OUT' }, 0.033);
      const initial = probe.diagnostics();
      expect(initial).toHaveLength(2);
      expect(initial.every((value) => value.code === 'electrical/overcurrent')).toBe(true);
      probe.runBatch(4);
      expect(probe.diagnostics()).toEqual(initial);
      expect(probe.tickCount).toBe(4n);
      probe.writeState('gpio', 'ohms', 1000);
      probe.step();
      expect(probe.diagnostics()).toEqual([]);
      closeTo(probe, { kind: 'drive', device: 'gpio', pin: 'OUT' }, 3.3 / 1050);
      probe.writeState('gpio', 'ohms', ohms);
      probe.runBatch(5);
      expect(probe.tickCount).toBe(5n);
      const [failure] = probe.diagnostics();
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
      expect(probe.diagnostics()).toEqual([failure]);
      closeTo(probe, 'gpio.load', 3.3 / 1050);
      probe.writeState('gpio', 'ohms', 1000);
      probe.step();
      expect(probe.tickCount).toBe(5n);
      probe.reset();
      expect(probe.diagnostics()).toEqual(initial);
      expect(Object.isFrozen(initial)).toBe(true);
      expect(() => probe.current({ kind: 'contact', device: 'gpio', name: 'load' })).toThrow(
        'Unknown electrical current',
      );
      expect(() => probe.current({ kind: 'source', name: 'missing' })).toThrow(
        'Unknown electrical current',
      );
    },
  );

  test('separates pull currents from active drive and exposes their orientation', () => {
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
    const probe = createTestProbe(
      {
        devices: [{ id: 'gpio', type: 'gpio', description }],
        connections: [{ from: 'gpio.B', to: 'GND' }],
      },
      { engine, electrical },
    );
    closeTo(probe, { kind: 'pull-up', device: 'gpio', pin: 'A' }, 0.00165);
    closeTo(probe, { kind: 'pull-down', device: 'gpio', pin: 'A' }, 0);
    closeTo(probe, { kind: 'source', name: 'VDD' }, 0.00165);
    expect(() => probe.current({ kind: 'drive', device: 'gpio', pin: 'A' })).toThrow(
      'Unknown electrical current',
    );
  });

  test('locates a matrix failure to its network without naming a fabricated culprit', () => {
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
    const probe = createTestProbe(
      {
        devices: [{ id: 'network', type: 'network', description }],
        connections: [
          { from: 'network.P', to: 'VDD' },
          { from: 'network.N', to: 'GND' },
        ],
      },
      { engine, electrical },
    );
    expect(probe.diagnostics()).toEqual([]);
    const before = probe.voltage('network.A');
    probe.writeState('network', 'ohms', 1e30);
    probe.step();
    const [failure] = probe.diagnostics();
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
    expect(probe.voltage('network.A')).toEqual(before);
    expect(probe.tickCount).toBe(0n);
    probe.reset();
    expect(probe.diagnostics()).toEqual([]);
  });

  test('latches source conflict, leaves contact current snapshot intact, and clears the fault on reset', () => {
    const description: DeviceDescription = {
      pins: { A: { kind: 'signal' }, B: { kind: 'signal' } },
      connections: { bridge: { pins: ['A', 'B'], initial: 'open' } },
      states: { closed: { type: 'bool', initial: false } },
      factory: () => ({
        tick: (api) => api.applyConnections(['bridge'], [api.state<'bool'>('closed').load()]),
      }),
    };
    const probe = createTestProbe(
      {
        devices: [{ id: 'switch', type: 'switch', description }],
        connections: [
          { from: 'switch.A', to: 'VDD' },
          { from: 'switch.B', to: 'GND' },
        ],
      },
      { engine, electrical },
    );
    closeTo(probe, contact('bridge'), 0);
    probe.writeState('switch', 'closed', true);
    probe.step();
    expect(probe.tickCount).toBe(0n);
    const [failure] = probe.diagnostics();
    expect(probe.diagnostics()).toHaveLength(1);
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
    probe.step();
    expect(probe.diagnostics()).toEqual([failure]);
    closeTo(probe, contact('bridge'), 0);
    expect(probe.voltage('switch.A')).toEqual({ state: 'determinate', value: 3.3 });
    probe.reset();
    expect(probe.diagnostics()).toEqual([]);
    probe.step();
    expect(probe.tickCount).toBe(1n);
  });
});
