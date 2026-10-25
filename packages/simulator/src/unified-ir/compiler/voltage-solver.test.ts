import { describe, expect, it } from 'vitest';
import { PIN_MODE, PIN_PULL } from '../pin-space';
import { Circuit } from '../runtime/circuit';
import { scalarToNumber } from '../runtime/topic-payload';
import { compileCircuit } from './index';
import type { DeviceDescription } from './types';
import {
  DEFAULT_HIGH_THRESHOLD,
  DEFAULT_LOW_THRESHOLD,
  DEFAULT_SUPPLY_VOLTAGE,
  VOLTAGE_CONFLICT_TOLERANCE,
  planVoltage,
  railVoltageOf,
  resolveVoltageNetwork,
  supplyVoltageOfRail,
  thresholdsForSupply,
  type VoltageNetworkResult,
  type VoltagePinState,
} from './voltage-solver';

/**
 * RFC 0002 §4/§5 — the analog voltage model.
 *
 * The pure tests pin the arbitration rules (rails > strong > weak > floating),
 * the threshold defaults and the conflict tolerance. The runtime tests drive
 * the same rules through the generated IR: `pin.writeAnalog`/`sampleAnalog`,
 * `Circuit.samplePinVoltage`, digital reads through the pin thresholds, and
 * the paused main loop of a conflicting network.
 */

type TestDriveMode = 'push-pull' | 'open-drain' | 'high-z' | 'analog';
type TestPull = 'none' | 'up' | 'down';

/** One pin held at a fixed mode and latch, for the digital tiers. */
function driver(mode: TestDriveMode, level = false): DeviceDescription {
  return {
    pins: { out: { direction: 'output' } },
    behaviors: {
      initialize: (api) => {
        const pin = api.pin('out');
        pin.configure({ mode });
        pin.writeDigital(api.builder.const('bool', level));
      },
    },
  };
}

/** One analog source with a compile-time voltage (writing implies analog mode). */
function analogSource(voltage: number): DeviceDescription {
  return {
    pins: { out: { direction: 'output' } },
    behaviors: {
      initialize: (api) => {
        api.pin('out').writeAnalog(voltage);
      },
    },
  };
}

/** One analog source whose voltage the host can change through its state. */
function variableAnalogSource(initial: number): DeviceDescription {
  return {
    pins: { out: { direction: 'output' } },
    states: { level: { type: 'f32', initial } },
    behaviors: {
      tick: (api) => {
        api.pin('out').writeAnalog(api.state<'f32'>('level').load());
      },
    },
  };
}

/**
 * One bidirectional pin that only configures analog thresholds: it samples the
 * net with a custom window but must not drive it.
 */
function analogListener(thresholds: { low: number; high: number }): DeviceDescription {
  return {
    pins: { io: { direction: 'bidirectional' } },
    behaviors: {
      initialize: (api) => {
        api.pin('io').configure({
          mode: 'analog',
          lowThreshold: thresholds.low,
          highThreshold: thresholds.high,
        });
      },
    },
  };
}

/** One passive pin that only biases its net (a pull resistor). */
function pullResistor(pull: TestPull): DeviceDescription {
  return {
    pins: { io: { direction: 'passive' } },
    behaviors: {
      initialize: (api) => {
        api.pin('io').pull(pull);
      },
    },
  };
}

/** One input pin that samples the net with the default thresholds. */
function sink(thresholds?: { low: number; high: number }): DeviceDescription {
  const pins = { in: { direction: 'input' as const } };
  if (thresholds === undefined) {
    return { pins, behaviors: { update: () => {} } };
  }
  return {
    pins,
    behaviors: {
      initialize: (api) => {
        api.pin('in').configure({ lowThreshold: thresholds.low, highThreshold: thresholds.high });
      },
    },
  };
}

/** One device that samples the solved net voltage into an `f32` state. */
function analogProbe(): DeviceDescription {
  return {
    pins: { in: { direction: 'input' } },
    states: { reading: { type: 'f32', initial: 0 } },
    behaviors: {
      update: (api) => {
        api.state<'f32'>('reading').store(api.pin('in').sampleAnalog());
      },
    },
  };
}

function state(overrides: Partial<VoltagePinState> = {}): VoltagePinState {
  return {
    globalPinId: 0,
    mode: PIN_MODE.highZ,
    output: false,
    voltageIntent: 0,
    pull: PIN_PULL.none,
    powered: true,
    highVoltage: DEFAULT_SUPPLY_VOLTAGE,
    lowVoltage: 0,
    ...overrides,
  };
}

/** Solved voltage of a non-conflicting network. */
function voltageOf(result: VoltageNetworkResult): number {
  if (result.state === 'conflict') {
    throw new Error(`unexpected conflict (spread ${result.spread} V)`);
  }
  return result.voltage;
}

describe('voltage model constants', () => {
  it('keeps the 3.3 V defaults named by RFC 0002', () => {
    expect(DEFAULT_SUPPLY_VOLTAGE).toBe(3.3);
    expect(VOLTAGE_CONFLICT_TOLERANCE).toBe(0.001);
    const thresholds = thresholdsForSupply(DEFAULT_SUPPLY_VOLTAGE);
    expect(thresholds.low).toBeCloseTo(DEFAULT_LOW_THRESHOLD, 6);
    expect(thresholds.high).toBeCloseTo(DEFAULT_HIGH_THRESHOLD, 6);
  });

  it('scales the default thresholds with a low-voltage supply', () => {
    const thresholds = thresholdsForSupply(1.8);
    expect(thresholds.low).toBeCloseTo(0.44, 2);
    expect(thresholds.high).toBeCloseTo(1.09, 2);
    expect(thresholds.high).toBeLessThan(1.8);
  });

  it('reads the supply out of a rail name', () => {
    expect(supplyVoltageOfRail('3V3', 3.3)).toBeCloseTo(3.3, 6);
    expect(supplyVoltageOfRail('+5V', 3.3)).toBe(5);
    expect(supplyVoltageOfRail('12V', 3.3)).toBe(12);
    expect(supplyVoltageOfRail('VCC', 3.3)).toBe(3.3);
    expect(supplyVoltageOfRail('VBUS', 5)).toBe(5);
  });

  it('maps a rail to its node voltage', () => {
    expect(railVoltageOf([{ name: 'GND', level: false }], DEFAULT_SUPPLY_VOLTAGE)).toBe(0);
    expect(railVoltageOf([{ name: 'VCC', level: true }], DEFAULT_SUPPLY_VOLTAGE)).toBe(
      DEFAULT_SUPPLY_VOLTAGE,
    );
    expect(railVoltageOf([{ name: '5V', level: true }], 3.3)).toBe(5);
    expect(railVoltageOf([], 3.3)).toBeUndefined();
  });
});

describe('resolveVoltageNetwork', () => {
  it('floats at 0 V without any contribution', () => {
    const result = resolveVoltageNetwork([state(), state({ globalPinId: 1 })]);
    expect(result.state).toBe('floating');
    expect(voltageOf(result)).toBe(0);
  });

  it('solves a push-pull driver high at its supply', () => {
    const result = resolveVoltageNetwork([state({ mode: PIN_MODE.pushPull, output: true })]);
    expect(result).toMatchObject({ state: 'driven', strength: 'strong' });
    expect(voltageOf(result)).toBe(3.3);
  });

  it('solves a push-pull driver low at 0 V', () => {
    const result = resolveVoltageNetwork([state({ mode: PIN_MODE.pushPull })]);
    expect(voltageOf(result)).toBe(0);
  });

  it('pulls low with an open-drain latch of 0 and releases on 1', () => {
    expect(voltageOf(resolveVoltageNetwork([state({ mode: PIN_MODE.openDrain })]))).toBe(0);
    expect(resolveVoltageNetwork([state({ mode: PIN_MODE.openDrain, output: true })]).state).toBe(
      'floating',
    );
  });

  it('drives the analog intent once its output is enabled', () => {
    const result = resolveVoltageNetwork([
      state({ mode: PIN_MODE.analog, output: true, voltageIntent: 2.5 }),
    ]);
    expect(voltageOf(result)).toBe(2.5);
  });

  it('releases an analog pin that only configures thresholds', () => {
    expect(
      resolveVoltageNetwork([state({ mode: PIN_MODE.analog, voltageIntent: 2.5 })]).state,
    ).toBe('floating');
  });

  it('releases an analog pin of an unpowered domain', () => {
    expect(
      resolveVoltageNetwork([
        state({ mode: PIN_MODE.analog, output: true, voltageIntent: 2.5, powered: false }),
      ]).state,
    ).toBe('floating');
  });

  it('biases a released node with a pull-up', () => {
    const result = resolveVoltageNetwork([state({ pull: PIN_PULL.up })]);
    expect(result).toMatchObject({ state: 'driven', strength: 'weak' });
    expect(voltageOf(result)).toBe(3.3);
  });

  it('biases a released node with a pull-down', () => {
    expect(voltageOf(resolveVoltageNetwork([state({ pull: PIN_PULL.down })]))).toBe(0);
  });

  it('lets a strong drive win over a weak bias', () => {
    const result = resolveVoltageNetwork([
      state({ globalPinId: 0, mode: PIN_MODE.pushPull }),
      state({ globalPinId: 1, pull: PIN_PULL.up }),
    ]);
    expect(result).toMatchObject({ state: 'driven', strength: 'strong' });
    expect(voltageOf(result)).toBe(0);
  });

  it('lets a rail win over both tiers', () => {
    const result = resolveVoltageNetwork(
      [state({ mode: PIN_MODE.pushPull }), state({ globalPinId: 1, pull: PIN_PULL.down })],
      3.3,
    );
    expect(result).toMatchObject({ state: 'driven', strength: 'rail' });
    expect(voltageOf(result)).toBe(3.3);
  });

  it('detects strong drives that differ by more than the tolerance', () => {
    const result = resolveVoltageNetwork([
      state({ globalPinId: 0, mode: PIN_MODE.pushPull, output: true }),
      state({ globalPinId: 1, mode: PIN_MODE.pushPull }),
    ]);
    expect(result.state).toBe('conflict');
    if (result.state === 'conflict') expect(result.spread).toBeCloseTo(3.3, 6);
  });

  it('accepts strong drives inside the tolerance', () => {
    const result = resolveVoltageNetwork([
      state({ globalPinId: 0, mode: PIN_MODE.analog, output: true, voltageIntent: 2.5 }),
      state({ globalPinId: 1, mode: PIN_MODE.analog, output: true, voltageIntent: 2.5005 }),
    ]);
    expect(result).toMatchObject({ state: 'driven', strength: 'strong' });
    expect(voltageOf(result)).toBe(2.5);
  });

  it('lets a pull-up win over a pull-down instead of reporting a conflict', () => {
    const result = resolveVoltageNetwork([
      state({ globalPinId: 0, pull: PIN_PULL.up }),
      state({ globalPinId: 1, pull: PIN_PULL.down }),
    ]);
    expect(result).toMatchObject({ state: 'driven', strength: 'weak' });
    expect(voltageOf(result)).toBe(3.3);
  });
});

describe('pin memories', () => {
  it('allocates and seeds the voltage arrays', () => {
    const compiled = compileCircuit({
      devices: [{ id: 'D1', type: 'test-driver', description: driver('high-z') }],
      connections: [],
    });
    const names = compiled.module.memories.map((memory) => memory.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pin_voltage',
        'pin_voltage_intent',
        'pin_low_threshold',
        'pin_high_threshold',
        'electrical_fault',
      ]),
    );
    expect(compiled.memory.voltage).toBeDefined();
    expect(compiled.memory.voltageIntent).toBeDefined();
    expect(compiled.memory.lowThreshold).toBeDefined();
    expect(compiled.memory.highThreshold).toBeDefined();
    expect(compiled.memory.electricalFault).toBeDefined();
  });

  it('seeds thresholds from the declared domain voltage', () => {
    const compiled = compileCircuit({
      devices: [
        {
          id: 'D1',
          type: 'test-driver',
          description: {
            ...driver('push-pull', true),
            powerDomains: [{ name: 'vdd', voltage: 5 }],
          },
        },
      ],
      connections: [],
    });
    const pinId = compiled.pinMap.get('D1.out');
    if (pinId === undefined) throw new Error('D1.out must be allocated');
    const memory = compiled.module.memories.find((entry) => entry.name === 'pin_low_threshold');
    expect(memory?.kind).toBe('array');
    if (memory?.kind === 'array') {
      expect(Number(memory.initial[pinId])).toBeCloseTo(5 * (0.8 / 3.3), 5);
    }
  });

  it('plans a rail node with the rail voltage', () => {
    const compiled = compileCircuit({
      devices: [{ id: 'D1', type: 'test-driver', description: sink() }],
      connections: [{ from: 'D1.in', to: 'VCC' }],
    });
    const net = compiled.netlist.nets[0];
    if (net === undefined) throw new Error('expected one net');
    const plan = planVoltage(net, { supplyVoltage: 3.3 });
    expect(plan.railVoltage).toBe(3.3);
    expect(plan.trackSpread).toBe(false);
  });
});

describe('analog I/O', () => {
  it('drives a node with writeAnalog', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog', description: analogSource(2.5) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('A1', 'out')).toBeCloseTo(2.5, 6);
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(2.5, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('exposes sampleAnalog to device behaviour', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog', description: analogSource(1.6) },
        { id: 'P1', type: 'test-probe', description: analogProbe() },
      ],
      connections: [{ from: 'A1.out', to: 'P1.in' }],
    });
    try {
      circuit.step();
      expect(scalarToNumber(circuit.devices.P1.getState('reading'))).toBeCloseTo(1.6, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('solves the same voltage on the reference engine', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-analog', description: analogSource(2.5) },
          { id: 'P1', type: 'test-probe', description: analogProbe() },
        ],
        connections: [{ from: 'A1.out', to: 'P1.in' }],
      },
      { engine: 'reference' },
    );
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('P1', 'in')).toBeCloseTo(2.5, 6);
      expect(scalarToNumber(circuit.devices.P1.getState('reading'))).toBeCloseTo(2.5, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reports the domain supply for a push-pull high pin', async () => {
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'A1',
          type: 'test-driver',
          description: {
            ...driver('push-pull', true),
            powerDomains: [{ name: 'vdd', voltage: 5 }],
          },
        },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(5, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reports 0 V for a push-pull low pin', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('push-pull', false) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBe(0);

      // A host write to the output latch reaches the next solve.
      circuit.setPin('A1.out', true);
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(3.3, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reports the pull-up bias of a released net', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('high-z') },
        { id: 'R1', type: 'test-pull', description: pullResistor('up') },
      ],
      connections: [{ from: 'A1.out', to: 'R1.io' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('R1', 'io')).toBeCloseTo(3.3, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reports the pull-down bias of a released net', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('high-z') },
        { id: 'R1', type: 'test-pull', description: pullResistor('down') },
      ],
      connections: [{ from: 'A1.out', to: 'R1.io' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('R1', 'io')).toBe(0);
    } finally {
      circuit.dispose();
    }
  });

  it('does not leak the latch of a released open-drain pin', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('open-drain', true) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      // A released open-drain pin (latch 1) contributes nothing: the node
      // floats at 0 V rather than reporting the latch's high level.
      expect(circuit.samplePinVoltage('S1', 'in')).toBe(0);
    } finally {
      circuit.dispose();
    }
  });

  it('does not leak the latch of a high-z pin', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('high-z', true) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBe(0);
    } finally {
      circuit.dispose();
    }
  });

  it('honours the circuit supply option', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'S1', type: 'test-sink', description: sink() },
        ],
        connections: [{ from: 'A1.out', to: 'S1.in' }],
      },
      { electrical: { supplyVoltage: 5 } },
    );
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(5, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reads rail voltages by name', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'S1', type: 'test-sink', description: sink() },
          { id: 'S2', type: 'test-sink', description: sink() },
        ],
        connections: [
          { from: 'S1.in', to: 'VCC' },
          { from: 'S2.in', to: '5V' },
        ],
      },
      { electrical: { rails: { '5V': true } } },
    );
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(3.3, 6);
      expect(circuit.samplePinVoltage('S2', 'in')).toBeCloseTo(5, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('reports 0 V for a pin of an unpowered domain', async () => {
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'A1',
          type: 'test-driver',
          description: {
            ...driver('push-pull', true),
            powerDomains: [{ name: 'vdd', voltage: 3.3 }],
          },
        },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.samplePinVoltage('A1', 'out')).toBeCloseTo(3.3, 6);
      circuit.turnOff('A1', 'vdd');
      circuit.step();
      expect(circuit.samplePinVoltage('A1', 'out')).toBe(0);
    } finally {
      circuit.dispose();
    }
  });

  it('does not drive a net when analog mode only configures thresholds', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-analog', description: analogSource(2.5) },
          {
            id: 'L1',
            type: 'test-analog-listener',
            description: analogListener({ low: 2.0, high: 2.4 }),
          },
        ],
        connections: [{ from: 'A1.out', to: 'L1.io' }],
      },
      // Two role-driver pins share the net, so the compiler needs the opt-in;
      // the listener must still stay released because it never wrote an intent.
      { electrical: { allowMultiDriver: true } },
    );
    try {
      circuit.step();
      expect(circuit.electricalFault).toBe(false);
      expect(circuit.samplePinVoltage('L1', 'io')).toBeCloseTo(2.5, 6);
      expect(circuit.getPin('L1.io')).toBe(true);
    } finally {
      circuit.dispose();
    }
  });

  it('rejects an unknown pin', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'A1', type: 'test-analog', description: analogSource(1) }],
      connections: [],
    });
    try {
      expect(() => circuit.samplePinVoltage('A1', 'nope')).toThrow(/pin-not-found|Pin/);
      expect(() => circuit.samplePinVoltage('NOPE', 'out')).toThrow(/not found/);
    } finally {
      circuit.dispose();
    }
  });

  it('rejects an out-of-range analog voltage at compile time', () => {
    expect(() =>
      compileCircuit({
        devices: [{ id: 'A1', type: 'test-analog', description: analogSource(-1) }],
        connections: [],
      }),
    ).toThrow(/writeAnalog/);
  });

  it('rejects inverted thresholds at compile time', () => {
    expect(() =>
      compileCircuit({
        devices: [
          {
            id: 'S1',
            type: 'test-sink',
            description: sink({ low: 2, high: 1 }),
          },
        ],
        connections: [],
      }),
    ).toThrow(/lowThreshold <= highThreshold/);
  });
});

describe('threshold conversion', () => {
  it('reads an analog voltage above the high threshold as digital 1', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog', description: analogSource(2.5) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(true);
      expect(circuit.samplePin('S1', 'in')).toEqual({ value: 1, ready: true });
    } finally {
      circuit.dispose();
    }
  });

  it('reads an analog voltage below the low threshold as digital 0', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog', description: analogSource(0.5) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('keeps the previous level inside the indeterminate band', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog-var', description: variableAnalogSource(2.5) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(true);

      circuit.devices.A1.setState('level', 1.5);
      circuit.step();
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(1.5, 6);
      // 1.5 V is between 0.8 V and 2.0 V: the last determinate level sticks.
      expect(circuit.getPin('S1.in')).toBe(true);

      circuit.devices.A1.setState('level', 0.5);
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(false);

      circuit.devices.A1.setState('level', 1.5);
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('uses configured thresholds instead of the defaults', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-analog-var', description: variableAnalogSource(1.5) },
        {
          id: 'S1',
          type: 'test-sink',
          description: sink({ low: 1.0, high: 1.2 }),
        },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(true);

      circuit.devices.A1.setState('level', 1.1);
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(true);

      circuit.devices.A1.setState('level', 0.9);
      circuit.step();
      expect(circuit.getPin('S1.in')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });

  it('honours a configured threshold on a rail node', async () => {
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'S1',
          type: 'test-sink',
          description: sink({ low: 4, high: 5 }),
        },
      ],
      connections: [{ from: 'S1.in', to: 'VCC' }],
    });
    try {
      circuit.step();
      // The rail is 3.3 V but the pin's own threshold calls that a low level;
      // the compile-time rail shortcut must not bypass a configured threshold.
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(3.3, 6);
      expect(circuit.getPin('S1.in')).toBe(false);
    } finally {
      circuit.dispose();
    }
  });
});

describe('conflict detection', () => {
  it('pauses the simulation when two drivers disagree', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'A2', type: 'test-driver', description: driver('push-pull', false) },
          { id: 'S1', type: 'test-sink', description: sink() },
        ],
        connections: [
          { from: 'A1.out', to: 'S1.in' },
          { from: 'A2.out', to: 'S1.in' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    try {
      expect(() => circuit.step()).toThrow('electrical conflict');
      expect(circuit.electricalFault).toBe(true);

      circuit.clearElectricalFault();
      expect(circuit.electricalFault).toBe(false);
      expect(() => circuit.runBatch(2)).toThrow('electrical conflict');
    } finally {
      circuit.dispose();
    }
  });

  it('does not fault when both drivers agree', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'A2', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'S1', type: 'test-sink', description: sink() },
        ],
        connections: [
          { from: 'A1.out', to: 'S1.in' },
          { from: 'A2.out', to: 'S1.in' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    try {
      circuit.step();
      expect(circuit.electricalFault).toBe(false);
      expect(circuit.samplePinVoltage('S1', 'in')).toBeCloseTo(3.3, 6);
    } finally {
      circuit.dispose();
    }
  });

  it('detects analog intents outside the tolerance', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-analog', description: analogSource(1) },
          { id: 'A2', type: 'test-analog', description: analogSource(2) },
          { id: 'S1', type: 'test-sink', description: sink() },
        ],
        connections: [
          { from: 'A1.out', to: 'S1.in' },
          { from: 'A2.out', to: 'S1.in' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    try {
      expect(() => circuit.step()).toThrow('electrical conflict');
    } finally {
      circuit.dispose();
    }
  });

  it('keeps a conflict latched while later nets solve', async () => {
    const circuit = await Circuit.create(
      {
        devices: [
          { id: 'A1', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'A2', type: 'test-driver', description: driver('push-pull', false) },
          { id: 'S1', type: 'test-sink', description: sink() },
          { id: 'A3', type: 'test-driver', description: driver('push-pull', true) },
          { id: 'S2', type: 'test-sink', description: sink() },
        ],
        connections: [
          { from: 'A1.out', to: 'S1.in' },
          { from: 'A2.out', to: 'S1.in' },
          { from: 'A3.out', to: 'S2.in' },
        ],
      },
      { electrical: { allowMultiDriver: true } },
    );
    try {
      // The clean net is solved after the conflicting one; it must not clear
      // the latched fault.
      expect(() => circuit.step()).toThrow('electrical conflict');
      expect(circuit.electricalFault).toBe(true);
    } finally {
      circuit.dispose();
    }
  });

  it('does not fault on a single-driver circuit', async () => {
    const circuit = await Circuit.create({
      devices: [
        { id: 'A1', type: 'test-driver', description: driver('push-pull', true) },
        { id: 'S1', type: 'test-sink', description: sink() },
      ],
      connections: [{ from: 'A1.out', to: 'S1.in' }],
    });
    try {
      circuit.step();
      expect(circuit.electricalFault).toBe(false);
    } finally {
      circuit.dispose();
    }
  });
});
