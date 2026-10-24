import { describe, expect, it } from 'vitest';
import { createLedDescription, createMcuDescription } from '../compiler';
import { Circuit } from './circuit';
import type { CircuitRuntimeOptions } from './types';
import { CircuitError } from './types';
import {
  counterInput,
  latchMcuLedInput,
  mcuLedInput,
  mcuOnlyInput,
  registerMcuInput,
} from './test-helpers';

describe('Circuit.create', () => {
  it('creates and initializes a circuit', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(circuit.tickCount).toBe(0n);
    expect(circuit.disposed).toBe(false);
    expect(circuit.jit.storage).toBeDefined();

    expect(circuit.devices.mcu1.type).toBe('teaching-mcu');
    expect(circuit.devices.mcu1.pinNames).toEqual(['PA0']);
    expect(circuit.devices.led1.type).toBe('ideal-led');
    expect(circuit.devices.led1.lampState).toBe('lamp');
    expect(circuit.devices.led1.isOn()).toBe(false);
    expect(Object.isFrozen(circuit.devices)).toBe(true);
    expect(Object.isFrozen(circuit.devices.mcu1)).toBe(true);
  });

  it('runs the initialize entry before returning', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());

    // `initialize` configured PA0 push-pull; the latch itself starts low.
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(false);
    circuit.setPin('mcu1.PA0', true);
    expect(circuit.getPin('mcu1.PA0')).toBe(true);
  });

  it('keeps ids that collide with Object.prototype safe', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: '__proto__', type: 'teaching-mcu', description: createMcuDescription() }],
      connections: [],
    });

    expect(Object.getPrototypeOf(circuit.devices)).toBe(Object.prototype);
    expect(circuit.devices['__proto__']?.type).toBe('teaching-mcu');
  });

  it('propagates compiler errors', async () => {
    await expect(Circuit.create({ devices: [], connections: [] })).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'invalid-input',
    });

    await expect(
      Circuit.create({
        devices: [
          { id: 'dup', type: 'teaching-mcu', description: createMcuDescription() },
          { id: 'dup', type: 'ideal-led', description: createLedDescription() },
        ],
        connections: [],
      }),
    ).rejects.toMatchObject({ name: 'UnifiedIRCompilerError', code: 'duplicate-device' });
  });

  it('rejects malformed runtime options', async () => {
    const cases: readonly CircuitRuntimeOptions[] = [
      null as unknown as CircuitRuntimeOptions,
      { engine: 'wasm' } as unknown as CircuitRuntimeOptions,
      { validateIR: 'yes' } as unknown as CircuitRuntimeOptions,
      { instanceId: '' },
      { jit: [] } as unknown as CircuitRuntimeOptions,
      { electrical: null } as unknown as CircuitRuntimeOptions,
      { electrical: { allowMultiDriver: 'yes' } } as unknown as CircuitRuntimeOptions,
    ];
    for (const options of cases) {
      await expect(Circuit.create(mcuOnlyInput(), options)).rejects.toMatchObject({
        name: 'CircuitError',
        code: 'invalid-options',
      });
    }
  });

  it('accepts a custom instance id and reference engine', async () => {
    const circuit = await Circuit.create(mcuLedInput(), {
      engine: 'reference',
      instanceId: 'my-circuit',
      validateIR: true,
    });
    circuit.step();
    expect(circuit.tickCount).toBe(1n);
    expect(circuit.devices.led1.isOn()).toBe(true);
  });
});

describe('Circuit.runBatch', () => {
  it('accumulates ticks across calls', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());

    circuit.runBatch(1000);
    expect(circuit.tickCount).toBe(1000n);

    circuit.runBatch(500);
    expect(circuit.tickCount).toBe(1500n);
  });

  it('treats a zero batch as a no-op', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());
    circuit.runBatch(0);
    expect(circuit.tickCount).toBe(0n);
  });

  it('rejects counts outside the u32 range', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());
    const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32];

    for (const count of invalid) {
      expect(() => circuit.runBatch(count)).toThrowError(CircuitError);
      try {
        circuit.runBatch(count);
      } catch (error) {
        expect((error as CircuitError).code).toBe('invalid-count');
      }
    }
    expect(circuit.tickCount).toBe(0n);
  });

  it('matches the state of the same number of single steps', async () => {
    const batched = await Circuit.create(mcuLedInput());
    const stepped = await Circuit.create(mcuLedInput());

    batched.runBatch(7);
    for (let index = 0; index < 7; index += 1) stepped.step();

    expect(batched.tickCount).toBe(7n);
    expect(stepped.tickCount).toBe(7n);
    expect(batched.devices.led1.isOn()).toBe(stepped.devices.led1.isOn());
    expect(batched.devices.mcu1.readPin('PA0')).toBe(stepped.devices.mcu1.readPin('PA0'));
    expect(batched.getPin('mcu1.PA0')).toBe(stepped.getPin('mcu1.PA0'));
    expect(batched.getPin('led1.anode')).toBe(stepped.getPin('led1.anode'));
  });
});

describe('Circuit.step', () => {
  it('advances one tick at a time', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());

    circuit.step();
    expect(circuit.tickCount).toBe(1n);
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(true);

    circuit.step();
    expect(circuit.tickCount).toBe(2n);
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(false);
  });
});

describe('Circuit.reset', () => {
  it('restores the initial state and restarts the tick counter', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    circuit.runBatch(5);
    expect(circuit.tickCount).toBe(5n);
    expect(circuit.devices.led1.isOn()).toBe(true);

    circuit.reset();

    expect(circuit.tickCount).toBe(0n);
    expect(circuit.devices.led1.isOn()).toBe(false);
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(false);
    expect(circuit.getPin('mcu1.PA0')).toBe(false);
    // `initialize` ran again: the driver pin is push-pull once more, so a host
    // write reaches the net.
    circuit.setPin('mcu1.PA0', true);
    expect(circuit.getPin('mcu1.PA0')).toBe(true);
  });

  it('restores device state arrays to their declared initial values', async () => {
    const circuit = await Circuit.create(counterInput());
    circuit.runBatch(4);
    expect(circuit.devices.count1.getState('count')).toBe(4);
    expect(circuit.devices.count1.getState('last')).toBe(false);

    circuit.reset();

    expect(circuit.devices.count1.getState('count')).toBe(0);
    expect(circuit.devices.count1.getState('last')).toBe(false);
  });

  it('replays the same trace as a freshly created circuit', async () => {
    const reused = await Circuit.create(mcuLedInput());
    const fresh = await Circuit.create(mcuLedInput());

    reused.runBatch(9);
    reused.reset();

    const reusedTrace: boolean[] = [];
    const freshTrace: boolean[] = [];
    for (let index = 0; index < 8; index += 1) {
      reused.step();
      fresh.step();
      reusedTrace.push(reused.devices.led1.isOn());
      freshTrace.push(fresh.devices.led1.isOn());
    }

    expect(reusedTrace).toEqual(freshTrace);
    expect(reused.tickCount).toBe(8n);
  });
});

describe('device accessors', () => {
  it('reads and writes LED state', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    const led = circuit.devices.led1;

    expect(led.stateNames).toEqual(['lamp']);
    expect(led.getState('lamp')).toBe(false);

    led.setState('lamp', true);
    expect(led.getState('lamp')).toBe(true);
    expect(led.isOn()).toBe(true);
  });

  it('reports available state names for unknown states', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(() => circuit.devices.led1.getState('glow')).toThrowError(CircuitError);
    expect(() => circuit.devices.led1.getState('glow')).toThrowError(/Available: \[lamp\]/);
  });

  it('validates state values against the declared type', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(() => circuit.devices.led1.setState('lamp', 1)).toThrowError(/needs true or false/);
  });

  it('exposes the generic state surface of custom devices', async () => {
    const circuit = await Circuit.create(counterInput());
    const counter = circuit.devices.count1;

    expect(counter.type).toBe('counter');
    expect(counter.stateNames).toEqual(['count', 'last']);
    expect(counter.getState('count')).toBe(0);

    counter.setState('count', 5);
    expect(counter.getState('count')).toBe(5);
    expect(() => counter.setState('count', 1.5)).toThrowError(/needs an integer/);
  });

  it('reads and writes MCU pins', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());
    const mcu = circuit.devices.mcu1;

    expect(mcu.readPin('PA0')).toBe(false);
    mcu.writePin('PA0', true);
    expect(mcu.readPin('PA0')).toBe(true);
    expect(circuit.getPin('mcu1.PA0')).toBe(true);

    expect(() => mcu.readPin('PA1')).toThrowError(/Available: \[PA0\]/);
    expect(() => mcu.writePin('PA0', 'high' as unknown as boolean)).toThrowError(
      /needs a boolean level/,
    );
  });

  it('rejects writes on non-driver pins', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(() => circuit.devices.led1.writePin('anode', true)).toThrowError(CircuitError);
    expect(() => circuit.devices.led1.writePin('anode', true)).toThrowError(
      /only driver pins can be written/,
    );
  });

  it('reads and writes MCU registers', async () => {
    const circuit = await Circuit.create(registerMcuInput());
    const mcu = circuit.devices.mcu1;

    expect(mcu.registerNames).toEqual(['R0', 'R1', 'flag']);
    expect(mcu.readRegister('R0')).toBe(0n);

    mcu.writeRegister('R0', 42n);
    expect(mcu.readRegister('R0')).toBe(42n);

    mcu.writeRegister('R1', -7n);
    expect(mcu.readRegister('R1')).toBe(-7n);

    mcu.writeRegister('flag', 1n);
    expect(mcu.readRegister('flag')).toBe(1n);
    mcu.writeRegister('flag', 0n);
    expect(mcu.readRegister('flag')).toBe(0n);
  });

  it('reads and writes float states as numbers or FloatBits', async () => {
    const circuit = await Circuit.create(registerMcuInput());
    const mcu = circuit.devices.mcu1;

    mcu.setState('acc', 1.5);
    expect(mcu.getState('acc')).toMatchObject({ type: 'f32' });

    mcu.setState('acc', { type: 'f32', bits: '0x3f800000' });
    expect(mcu.getState('acc')).toEqual({ type: 'f32', bits: '0x3f800000' });

    expect(() => mcu.setState('acc', 'fast')).toThrowError(/needs a number or FloatBits/);
  });

  it('reports register errors with the register list', async () => {
    const circuit = await Circuit.create(registerMcuInput());
    const mcu = circuit.devices.mcu1;

    expect(() => mcu.readRegister('acc')).toThrowError(/registers must be bool or integer/);
    expect(() => mcu.readRegister('nope')).toThrowError(/Registers: \[R0, R1, flag\]/);
    expect(() => mcu.writeRegister('R0', 2n ** 70n)).toThrowError(
      /outside the exact integer range/,
    );
    expect(() => mcu.writeRegister('R0', -1n)).toThrowError(CircuitError);
    expect(() => mcu.writeRegister('R0', 1 as unknown as bigint)).toThrowError(/needs a bigint/);
  });
});

describe('pin access', () => {
  it('reads the solved level of a sensing pin', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(circuit.getPin('led1.anode')).toBe(false);
    expect(circuit.getPin('led1.cathode')).toBe(false);

    circuit.step();
    expect(circuit.getPin('led1.anode')).toBe(true);

    circuit.step();
    expect(circuit.getPin('led1.anode')).toBe(false);
  });

  it('lists available pins when the name is unknown', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(() => circuit.getPin('GND')).toThrowError(CircuitError);
    expect(() => circuit.getPin('GND')).toThrowError(/Pin "GND" not found/);
    expect(() => circuit.getPin('GND')).toThrowError(/mcu1\.PA0/);
    expect(() => circuit.getPin('GND')).toThrowError(/led1\.anode, led1\.cathode/);
  });

  it('reports unknown device prefixes in pin names', async () => {
    const circuit = await Circuit.create(mcuLedInput());

    expect(() => circuit.getPin('ghost.PA0')).toThrowError(/Pin "ghost\.PA0" not found/);
    expect(() => circuit.getPin('ghost.PA0')).toThrowError(/mcu1\.PA0/);
  });

  it('drives driver pins and overrides sensing pins', async () => {
    const circuit = await Circuit.create(latchMcuLedInput());

    circuit.devices.mcu1.writePin('PA0', true);
    circuit.step();
    expect(circuit.getPin('mcu1.PA0')).toBe(true);
    expect(circuit.getPin('led1.anode')).toBe(true);
    expect(circuit.devices.led1.isOn()).toBe(true);

    // A host override of a sensed pin lasts until the next solve recomputes it.
    circuit.setPin('led1.anode', false);
    expect(circuit.getPin('led1.anode')).toBe(false);
    circuit.step();
    expect(circuit.getPin('led1.anode')).toBe(true);

    circuit.setPin('mcu1.PA0', false);
    expect(circuit.getPin('mcu1.PA0')).toBe(false);
    expect(circuit.devices.mcu1.readPin('PA0')).toBe(false);
  });

  it('rejects non-boolean pin levels', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());

    expect(() => circuit.setPin('mcu1.PA0', 1 as unknown as boolean)).toThrowError(
      /needs a boolean level/,
    );
  });
});

describe('Circuit.dispose', () => {
  it('releases the runtime and rejects further use', async () => {
    const circuit = await Circuit.create(mcuLedInput());
    const led = circuit.devices.led1;

    circuit.dispose();
    expect(circuit.disposed).toBe(true);

    expect(() => circuit.step()).toThrowError(CircuitError);
    expect(() => circuit.runBatch(1)).toThrowError(CircuitError);
    expect(() => circuit.reset()).toThrowError(CircuitError);
    expect(() => circuit.getPin('mcu1.PA0')).toThrowError(CircuitError);
    expect(() => circuit.setPin('mcu1.PA0', true)).toThrowError(CircuitError);
    expect(() => circuit.tickCount).toThrowError(CircuitError);
    expect(() => circuit.jit).toThrowError(CircuitError);
    expect(() => led.isOn()).toThrowError(CircuitError);
    expect(() => circuit.devices.mcu1.getState('lamp')).toThrowError(CircuitError);
  });

  it('is idempotent', async () => {
    const circuit = await Circuit.create(mcuOnlyInput());
    circuit.dispose();
    expect(() => circuit.dispose()).not.toThrow();
  });
});
