import { describe, expect, it } from 'vitest';
import { PIN_PULL } from '../pin-space';
import { Circuit } from '../runtime/circuit';
import { compileCircuit, createLedDescription } from './index';
import type { DeviceDescription } from './types';

/**
 * RFC 0002 — the digital electrical model.
 *
 * These fixtures are private to the suite: a pin whose drive mode is fixed and
 * an ideal two-terminal pull resistor. Neither is exported, so the public device
 * surface stays untouched.
 */

type TestDriveMode = 'push-pull' | 'open-drain' | 'high-z';
type TestPull = 'none' | 'up' | 'down';

/** One bidirectional pin held at a configurable drive mode and latch. */
function driver(mode: TestDriveMode, level = false): DeviceDescription {
  return {
    pins: { out: { direction: 'bidirectional' } },
    behaviors: {
      initialize: (api) => {
        const pin = api.pin('out');
        pin.configure({ mode });
        pin.writeDigital(api.builder.const('bool', level));
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

/** Drives one net with `D1` and optionally biases it with `R1`. */
function busInput(mode: TestDriveMode, pull: TestPull, level = false) {
  return {
    devices: [
      { id: 'D1', type: 'test-driver', description: driver(mode, level) },
      { id: 'R1', type: 'test-pull', description: pullResistor(pull) },
    ],
    connections: [{ from: 'D1.out', to: 'R1.io' }],
  } as const;
}

/** Reads the solved level from both pins of the shared net. */
function expectNet(circuit: Circuit, level: boolean, pins = ['D1.out', 'R1.io']): void {
  for (const pin of pins) expect(circuit.getPin(pin)).toBe(level);
}

describe('pin_pull memory', () => {
  it('is allocated next to the other pin memories', () => {
    const compiled = compileCircuit({
      devices: [{ id: 'D1', type: 'test-driver', description: driver('open-drain') }],
      connections: [],
    });

    expect(compiled.module.memories.map((memory) => memory.name)).toContain('pin_pull');
    expect(compiled.memory.pull).toBeDefined();
  });

  it('keeps pull values out of the drive-mode array', async () => {
    const circuit = await Circuit.create(busInput('high-z', 'up'));
    circuit.step();

    // The bias holds the net high although the pin itself is high-z.
    expectNet(circuit, true);
    expect(circuit.getPin('D1.out')).toBe(true);
  });
});

describe('open-drain drive', () => {
  it('pulls the net low while its latch is 0', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'none', false));
    circuit.step();

    expectNet(circuit, false);
  });

  it('releases the net while its latch is 1', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'none', true));
    circuit.step();

    // Nothing holds a released net without a bias: it floats low.
    expectNet(circuit, false);
  });

  it('releases the net when the latch is raised at run time', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'none', false));
    circuit.step();
    expectNet(circuit, false);

    circuit.setPin('D1.out', true);
    circuit.step();
    expectNet(circuit, false);
  });

  it('pulls the net low again when the latch is lowered', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'none', true));
    circuit.setPin('D1.out', false);
    circuit.step();

    expectNet(circuit, false);
  });
});

describe('weak pull bias', () => {
  it('biases a net released by an open-drain pin', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'up', true));
    circuit.step();

    expectNet(circuit, true);
  });

  it('is overridden by an open-drain pin pulling low', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'up', false));
    circuit.step();

    expectNet(circuit, false);
  });

  it('is overridden by a push-pull driver pulling low', async () => {
    const circuit = await Circuit.create(busInput('push-pull', 'up', false));
    circuit.step();

    expectNet(circuit, false);
  });

  it('is overridden by a push-pull driver pulling high', async () => {
    const circuit = await Circuit.create(busInput('push-pull', 'down', true));
    circuit.step();

    expectNet(circuit, true);
  });

  it('holds a high-z net low through a pull-down', async () => {
    const circuit = await Circuit.create(busInput('high-z', 'down'));
    circuit.step();

    expectNet(circuit, false);
  });

  it('leaves a high-z net floating low without a bias', async () => {
    const circuit = await Circuit.create(busInput('high-z', 'none'));
    circuit.step();

    expectNet(circuit, false);
  });

  it('follows the latch while a pull-up biases an open-drain net', async () => {
    const circuit = await Circuit.create(busInput('open-drain', 'up', true));
    circuit.step();
    expectNet(circuit, true);

    circuit.setPin('D1.out', false);
    circuit.step();
    expectNet(circuit, false);

    circuit.setPin('D1.out', true);
    circuit.step();
    expectNet(circuit, true);
  });
});

describe('driver-less nets', () => {
  /**
   * A lone pin never becomes a net — the analyzer builds nets from wires — so
   * the bias is observed through a net shared with a passive LED anode.
   */
  function biasedInput(pull: TestPull) {
    return {
      devices: [
        { id: 'R1', type: 'test-pull', description: pullResistor(pull) },
        { id: 'led1', type: 'ideal-led', description: createLedDescription() },
      ],
      connections: [{ from: 'R1.io', to: 'led1.anode' }],
    } as const;
  }

  it('reads high from a pull-up and lights the load', async () => {
    const circuit = await Circuit.create(biasedInput('up'));
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(true);
    expect(circuit.getPin('led1.anode')).toBe(true);
    expect(circuit.devices.led1.isOn()).toBe(true);
  });

  it('reads low from a pull-down', async () => {
    const circuit = await Circuit.create(biasedInput('down'));
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(false);
    expect(circuit.getPin('led1.anode')).toBe(false);
    expect(circuit.devices.led1.isOn()).toBe(false);
  });

  it('reads low from a lone unbias', async () => {
    const circuit = await Circuit.create(biasedInput('none'));
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(false);
    expect(circuit.devices.led1.isOn()).toBe(false);
  });
});

describe('I2C-style wired-OR bus', () => {
  /** Two open-drain drivers and one pull-up on `sda`. */
  function busInput() {
    return {
      devices: [
        { id: 'D1', type: 'test-driver', description: driver('open-drain', true) },
        { id: 'D2', type: 'test-driver', description: driver('open-drain', true) },
        { id: 'R1', type: 'test-pull', description: pullResistor('up') },
      ],
      connections: [
        { from: 'D1.out', to: 'R1.io' },
        { from: 'D2.out', to: 'R1.io' },
      ],
    } as const;
  }

  it('is high while every driver releases', async () => {
    const circuit = await Circuit.create(busInput(), { electrical: { allowMultiDriver: true } });
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(true);
    expect(circuit.getPin('D1.out')).toBe(true);
    expect(circuit.getPin('D2.out')).toBe(true);
  });

  it('is pulled low by any single driver', async () => {
    const circuit = await Circuit.create(busInput(), { electrical: { allowMultiDriver: true } });
    circuit.setPin('D2.out', false);
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(false);
    expect(circuit.getPin('D1.out')).toBe(false);
  });

  it('returns high once every driver releases again', async () => {
    const circuit = await Circuit.create(busInput(), { electrical: { allowMultiDriver: true } });
    circuit.setPin('D1.out', false);
    circuit.step();
    expect(circuit.getPin('R1.io')).toBe(false);

    circuit.setPin('D1.out', true);
    circuit.setPin('D2.out', false);
    circuit.step();
    expect(circuit.getPin('R1.io')).toBe(false);

    circuit.setPin('D2.out', true);
    circuit.step();
    expect(circuit.getPin('R1.io')).toBe(true);
  });

  it('still rejects several drivers unless wired-OR is enabled', async () => {
    await expect(Circuit.create(busInput())).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'driver-conflict',
    });
  });
});

describe('pin.pull API', () => {
  it('accepts the numeric PIN_PULL constants', async () => {
    const circuit = await Circuit.create({
      devices: [
        {
          id: 'R1',
          type: 'test-pull',
          description: {
            pins: { io: { direction: 'passive' } },
            behaviors: {
              initialize: (api) => {
                api.pin('io').pull(PIN_PULL.up);
              },
            },
          },
        },
        { id: 'led1', type: 'ideal-led', description: createLedDescription() },
      ],
      connections: [{ from: 'R1.io', to: 'led1.anode' }],
    });
    circuit.step();

    expect(circuit.getPin('R1.io')).toBe(true);
  });

  it('rejects an unknown bias name', async () => {
    await expect(
      Circuit.create({
        devices: [
          {
            id: 'R1',
            type: 'test-pull',
            description: {
              pins: { io: { direction: 'passive' } },
              behaviors: {
                initialize: (api) => {
                  api.pin('io').pull('sideways' as never);
                },
              },
            },
          },
        ],
        connections: [],
      }),
    ).rejects.toMatchObject({ name: 'UnifiedIRCompilerError', code: 'invalid-input' });
  });

  it('rejects an unknown drive-mode name', async () => {
    await expect(
      Circuit.create({
        devices: [
          {
            id: 'D1',
            type: 'test-driver',
            description: {
              pins: { out: { direction: 'output' } },
              behaviors: {
                initialize: (api) => {
                  api.pin('out').configure({ mode: 'half-drain' as never });
                },
              },
            },
          },
        ],
        connections: [],
      }),
    ).rejects.toMatchObject({ name: 'UnifiedIRCompilerError', code: 'invalid-input' });
  });
});
