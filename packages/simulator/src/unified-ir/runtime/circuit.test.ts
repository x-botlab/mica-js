import { describe, expect, it } from 'vitest';
import type { Value } from '@mica-js/ir';
import type { DeviceDescription } from '../compiler';
import { PIN_MODE } from '../pin-space';
import { Circuit } from './circuit';

/**
 * Probe surface of `Circuit` (G3): a host reads pins and switch states without
 * touching the IR storage, and the readings follow the electrical solve.
 */

/** Two-terminal switch driven by a `pressed` topic, like `mica:ideal-button`. */
function contactDescription(): DeviceDescription {
  return {
    pins: {
      A: { direction: 'passive' },
      B: { direction: 'passive' },
    },
    connections: {
      contact: { pins: ['A', 'B'], initial: 'open' },
    },
    ports: {
      pressed: { direction: 'input', type: 'boolean' },
    },
    behaviors: {
      initialize: (api) => {
        api.connection.apply([{ connection: 'contact', closed: false }]);
        api.topics.subscribe('pressed', (handler) => {
          const pressed = handler.args[0];
          if (pressed === undefined) return;
          handler.connection.apply([{ connection: 'contact', closed: pressed as Value<'bool'> }]);
        });
      },
    },
  };
}

/** Push-pull driver whose latch follows the `level` topic. */
function driverDescription(): DeviceDescription {
  return {
    pins: {
      OUT: { direction: 'output' },
    },
    ports: {
      level: { direction: 'input', type: 'boolean' },
    },
    behaviors: {
      initialize: (api) => {
        api.pin('OUT').configure(PIN_MODE.pushPull);
        api.topics.subscribe('level', (handler) => {
          const level = handler.args[0];
          if (level === undefined) return;
          handler.pin('OUT').writeDigital(level as Value<'bool'>);
        });
      },
    },
  };
}

/** Two passive pins: one on the VCC rail, one left floating. */
function probeDescription(): DeviceDescription {
  return {
    pins: {
      SUPPLY: { direction: 'input' },
      FLOATING: { direction: 'input' },
    },
    behaviors: {
      initialize: () => {},
    },
  };
}

describe('Circuit probe API', () => {
  it('samples pin levels from the solved netlist', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'probe1', type: 'probe', description: probeDescription() }],
      connections: [{ from: 'probe1.SUPPLY', to: 'VCC' }],
    });
    try {
      // The net solve runs at the start of every tick, so the first reading is
      // taken after one step — the same point a host's probe table samples.
      circuit.step();
      expect(circuit.samplePin('probe1', 'SUPPLY')).toEqual({ value: 1, ready: true });
      expect(circuit.samplePin('probe1', 'FLOATING')).toEqual({ value: 0, ready: true });
    } finally {
      circuit.dispose();
    }
  });

  it('follows the level a driver writes', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'drv1', type: 'driver', description: driverDescription() }],
      connections: [],
    });
    try {
      expect(circuit.samplePin('drv1', 'OUT')).toEqual({ value: 0, ready: true });
      circuit.deliverTopic('drv1', 'level', true);
      circuit.step();
      expect(circuit.samplePin('drv1', 'OUT')).toEqual({ value: 1, ready: true });
    } finally {
      circuit.dispose();
    }
  });

  it('samples a connection and follows the patch a device applies', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'sw1', type: 'contact', description: contactDescription() }],
      connections: [{ from: 'sw1.A', to: 'VCC' }],
    });
    try {
      expect(circuit.sampleConnection('sw1', 'contact')).toEqual({
        state: 'open',
        ready: true,
      });
      expect(circuit.samplePin('sw1', 'B')).toEqual({ value: 0, ready: true });

      circuit.deliverTopic('sw1', 'pressed', true);
      expect(circuit.sampleConnection('sw1', 'contact')).toEqual({
        state: 'closed',
        ready: true,
      });
      // Closing merges B into the VCC net, so the contact carries the rail.
      expect(circuit.samplePin('sw1', 'B')).toEqual({ value: 1, ready: true });

      circuit.deliverTopic('sw1', 'pressed', false);
      expect(circuit.sampleConnection('sw1', 'contact')).toEqual({
        state: 'open',
        ready: true,
      });
      expect(circuit.samplePin('sw1', 'B')).toEqual({ value: 0, ready: true });
    } finally {
      circuit.dispose();
    }
  });

  it('throws on a missing device', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'probe1', type: 'probe', description: probeDescription() }],
      connections: [],
    });
    try {
      expect(() => circuit.samplePin('MISSING', 'pin1')).toThrow('Device MISSING not found');
      expect(() => circuit.sampleConnection('MISSING', 'contact')).toThrow(
        'Device MISSING not found',
      );
    } finally {
      circuit.dispose();
    }
  });

  it('throws on a missing pin', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'probe1', type: 'probe', description: probeDescription() }],
      connections: [],
    });
    try {
      expect(() => circuit.samplePin('probe1', 'MISSING')).toThrow('Pin probe1.MISSING not found');
    } finally {
      circuit.dispose();
    }
  });

  it('throws on a missing connection', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: 'sw1', type: 'contact', description: contactDescription() }],
      connections: [],
    });
    try {
      expect(() => circuit.sampleConnection('sw1', 'MISSING')).toThrow(
        'Connection sw1.MISSING not found',
      );
    } finally {
      circuit.dispose();
    }
  });
});
