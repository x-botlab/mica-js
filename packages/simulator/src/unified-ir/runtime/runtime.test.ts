import { describe, expect, it } from 'vitest';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';
import { Circuit } from './circuit';
import type { CircuitRuntimeOptions } from './types';
import { CircuitError } from './types';
import {
  counterInput,
  driverOnlyInput,
  driverSinkInput,
  latchDriverSinkInput,
  registerDriverInput,
} from './test-helpers';

describe('Circuit.create', () => {
  it('creates and initializes a circuit', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(circuit.tickCount).toBe(0n);
    expect(circuit.disposed).toBe(false);
    expect(circuit.jit.storage).toBeDefined();

    expect(circuit.devices.drive1.type).toBe('toggle-driver');
    expect(circuit.devices.drive1.pinNames).toEqual(['PA0']);
    expect(circuit.devices.sink1.type).toBe('lamp-sink');
    expect(circuit.devices.sink1.stateNames).toEqual(['lamp']);
    expect(circuit.devices.sink1.getState('lamp')).toBe(false);
    expect(Object.isFrozen(circuit.devices)).toBe(true);
    expect(Object.isFrozen(circuit.devices.drive1)).toBe(true);
  });

  it('runs the initialize entry before returning', async () => {
    const circuit = await Circuit.create(driverOnlyInput());

    // `initialize` configured PA0 push-pull; the latch itself starts low.
    expect(circuit.devices.drive1.readPin('PA0')).toBe(false);
    circuit.setPin('drive1.PA0', true);
    expect(circuit.getPin('drive1.PA0')).toBe(true);
  });

  it('keeps ids that collide with Object.prototype safe', async () => {
    const circuit = await Circuit.create({
      devices: [{ id: '__proto__', type: 'toggle-driver', description: toggleDriverDescription() }],
      connections: [],
    });

    expect(Object.getPrototypeOf(circuit.devices)).toBe(Object.prototype);
    expect(circuit.devices['__proto__']?.type).toBe('toggle-driver');
  });

  it('propagates compiler errors', async () => {
    await expect(Circuit.create({ devices: [], connections: [] })).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'invalid-input',
    });

    await expect(
      Circuit.create({
        devices: [
          { id: 'dup', type: 'toggle-driver', description: toggleDriverDescription() },
          { id: 'dup', type: 'lamp-sink', description: lampSinkDescription() },
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
      await expect(Circuit.create(driverOnlyInput(), options)).rejects.toMatchObject({
        name: 'CircuitError',
        code: 'invalid-options',
      });
    }
  });

  it('accepts a custom instance id and reference engine', async () => {
    const circuit = await Circuit.create(driverSinkInput(), {
      engine: 'reference',
      instanceId: 'my-circuit',
      validateIR: true,
    });
    circuit.step();
    expect(circuit.tickCount).toBe(1n);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);
  });
});

describe('Circuit.runBatch', () => {
  it('accumulates ticks across calls', async () => {
    const circuit = await Circuit.create(driverOnlyInput());

    circuit.runBatch(1000);
    expect(circuit.tickCount).toBe(1000n);

    circuit.runBatch(500);
    expect(circuit.tickCount).toBe(1500n);
  });

  it('treats a zero batch as a no-op', async () => {
    const circuit = await Circuit.create(driverOnlyInput());
    circuit.runBatch(0);
    expect(circuit.tickCount).toBe(0n);
  });

  it('rejects counts outside the u32 range', async () => {
    const circuit = await Circuit.create(driverOnlyInput());
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
    const batched = await Circuit.create(driverSinkInput());
    const stepped = await Circuit.create(driverSinkInput());

    batched.runBatch(7);
    for (let index = 0; index < 7; index += 1) stepped.step();

    expect(batched.tickCount).toBe(7n);
    expect(stepped.tickCount).toBe(7n);
    expect(batched.devices.sink1.getState('lamp')).toBe(stepped.devices.sink1.getState('lamp'));
    expect(batched.devices.drive1.readPin('PA0')).toBe(stepped.devices.drive1.readPin('PA0'));
    expect(batched.getPin('drive1.PA0')).toBe(stepped.getPin('drive1.PA0'));
    expect(batched.getPin('sink1.anode')).toBe(stepped.getPin('sink1.anode'));
  });
});

describe('Circuit.step', () => {
  it('advances one tick at a time', async () => {
    const circuit = await Circuit.create(driverOnlyInput());

    circuit.step();
    expect(circuit.tickCount).toBe(1n);
    expect(circuit.devices.drive1.readPin('PA0')).toBe(true);

    circuit.step();
    expect(circuit.tickCount).toBe(2n);
    expect(circuit.devices.drive1.readPin('PA0')).toBe(false);
  });
});

describe('Circuit.reset', () => {
  it('restores the initial state and restarts the tick counter', async () => {
    const circuit = await Circuit.create(driverSinkInput());
    circuit.runBatch(5);
    expect(circuit.tickCount).toBe(5n);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);

    circuit.reset();

    expect(circuit.tickCount).toBe(0n);
    expect(circuit.devices.sink1.getState('lamp')).toBe(false);
    expect(circuit.devices.drive1.readPin('PA0')).toBe(false);
    expect(circuit.getPin('drive1.PA0')).toBe(false);
    // `initialize` ran again: the driver pin is push-pull once more, so a host
    // write reaches the net.
    circuit.setPin('drive1.PA0', true);
    expect(circuit.getPin('drive1.PA0')).toBe(true);
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
    const reused = await Circuit.create(driverSinkInput());
    const fresh = await Circuit.create(driverSinkInput());

    reused.runBatch(9);
    reused.reset();

    const reusedTrace: unknown[] = [];
    const freshTrace: unknown[] = [];
    for (let index = 0; index < 8; index += 1) {
      reused.step();
      fresh.step();
      reusedTrace.push(reused.devices.sink1.getState('lamp'));
      freshTrace.push(fresh.devices.sink1.getState('lamp'));
    }

    expect(reusedTrace).toEqual(freshTrace);
    expect(reused.tickCount).toBe(8n);
  });
});

describe('device accessors', () => {
  it('reads and writes sink state', async () => {
    const circuit = await Circuit.create(driverSinkInput());
    const sink = circuit.devices.sink1;

    expect(sink.stateNames).toEqual(['lamp']);
    expect(sink.getState('lamp')).toBe(false);

    sink.setState('lamp', true);
    expect(sink.getState('lamp')).toBe(true);

    sink.setState('lamp', false);
    expect(sink.getState('lamp')).toBe(false);
  });

  it('reports available state names for unknown states', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(() => circuit.devices.sink1.getState('glow')).toThrowError(CircuitError);
    expect(() => circuit.devices.sink1.getState('glow')).toThrowError(/Available: \[lamp\]/);
  });

  it('validates state values against the declared type', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(() => circuit.devices.sink1.setState('lamp', 1)).toThrowError(/needs true or false/);
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

  it('reads and writes driver pins', async () => {
    const circuit = await Circuit.create(driverOnlyInput());
    const driver = circuit.devices.drive1;

    expect(driver.readPin('PA0')).toBe(false);
    driver.writePin('PA0', true);
    expect(driver.readPin('PA0')).toBe(true);
    expect(circuit.getPin('drive1.PA0')).toBe(true);

    expect(() => driver.readPin('PA1')).toThrowError(/Available: \[PA0\]/);
    expect(() => driver.writePin('PA0', 'high' as unknown as boolean)).toThrowError(
      /needs a boolean level/,
    );
  });

  it('rejects writes on non-driver pins', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(() => circuit.devices.sink1.writePin('anode', true)).toThrowError(CircuitError);
    expect(() => circuit.devices.sink1.writePin('anode', true)).toThrowError(
      /only driver pins can be written/,
    );
  });

  it('reads and writes float states as numbers or FloatBits', async () => {
    const circuit = await Circuit.create(registerDriverInput());
    const driver = circuit.devices.drive1;

    driver.setState('acc', 1.5);
    expect(driver.getState('acc')).toMatchObject({ type: 'f32' });

    driver.setState('acc', { type: 'f32', bits: '0x3f800000' });
    expect(driver.getState('acc')).toEqual({ type: 'f32', bits: '0x3f800000' });

    expect(() => driver.setState('acc', 'fast')).toThrowError(/needs a number or FloatBits/);
  });

  it('validates integer states against the declared type', async () => {
    const circuit = await Circuit.create(registerDriverInput());
    const driver = circuit.devices.drive1;

    expect(driver.stateNames).toEqual(['R0', 'R1', 'flag', 'acc']);
    driver.setState('R0', 42);
    expect(driver.getState('R0')).toBe(42);

    driver.setState('R1', -7);
    expect(driver.getState('R1')).toBe(-7);

    expect(() => driver.setState('R0', 2 ** 70)).toThrowError(CircuitError);
    expect(() => driver.setState('R0', -1)).toThrowError(CircuitError);
    expect(() => driver.setState('R0', 1n)).toThrowError(/needs an integer/);
  });
});

describe('pin access', () => {
  it('reads the solved level of a sensing pin', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(circuit.getPin('sink1.anode')).toBe(false);
    expect(circuit.getPin('sink1.cathode')).toBe(false);

    circuit.step();
    expect(circuit.getPin('sink1.anode')).toBe(true);

    circuit.step();
    expect(circuit.getPin('sink1.anode')).toBe(false);
  });

  it('lists available pins when the name is unknown', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(() => circuit.getPin('GND')).toThrowError(CircuitError);
    expect(() => circuit.getPin('GND')).toThrowError(/Pin "GND" not found/);
    expect(() => circuit.getPin('GND')).toThrowError(/drive1\.PA0/);
    expect(() => circuit.getPin('GND')).toThrowError(/sink1\.anode, sink1\.cathode/);
  });

  it('reports unknown device prefixes in pin names', async () => {
    const circuit = await Circuit.create(driverSinkInput());

    expect(() => circuit.getPin('ghost.PA0')).toThrowError(/Pin "ghost\.PA0" not found/);
    expect(() => circuit.getPin('ghost.PA0')).toThrowError(/drive1\.PA0/);
  });

  it('drives driver pins and overrides sensing pins', async () => {
    const circuit = await Circuit.create(latchDriverSinkInput());

    circuit.devices.drive1.writePin('PA0', true);
    circuit.step();
    expect(circuit.getPin('drive1.PA0')).toBe(true);
    expect(circuit.getPin('sink1.anode')).toBe(true);
    expect(circuit.devices.sink1.getState('lamp')).toBe(true);

    // A host override of a sensed pin lasts until the next solve recomputes it.
    circuit.setPin('sink1.anode', false);
    expect(circuit.getPin('sink1.anode')).toBe(false);
    circuit.step();
    expect(circuit.getPin('sink1.anode')).toBe(true);

    circuit.setPin('drive1.PA0', false);
    expect(circuit.getPin('drive1.PA0')).toBe(false);
    expect(circuit.devices.drive1.readPin('PA0')).toBe(false);
  });

  it('rejects non-boolean pin levels', async () => {
    const circuit = await Circuit.create(driverOnlyInput());

    expect(() => circuit.setPin('drive1.PA0', 1 as unknown as boolean)).toThrowError(
      /needs a boolean level/,
    );
  });
});

describe('Circuit.dispose', () => {
  it('releases the runtime and rejects further use', async () => {
    const circuit = await Circuit.create(driverSinkInput());
    const sink = circuit.devices.sink1;

    circuit.dispose();
    expect(circuit.disposed).toBe(true);

    expect(() => circuit.step()).toThrowError(CircuitError);
    expect(() => circuit.runBatch(1)).toThrowError(CircuitError);
    expect(() => circuit.reset()).toThrowError(CircuitError);
    expect(() => circuit.getPin('drive1.PA0')).toThrowError(CircuitError);
    expect(() => circuit.setPin('drive1.PA0', true)).toThrowError(CircuitError);
    expect(() => circuit.tickCount).toThrowError(CircuitError);
    expect(() => circuit.jit).toThrowError(CircuitError);
    expect(() => sink.getState('lamp')).toThrowError(CircuitError);
    expect(() => circuit.devices.drive1.getState('lamp')).toThrowError(CircuitError);
  });

  it('is idempotent', async () => {
    const circuit = await Circuit.create(driverOnlyInput());
    circuit.dispose();
    expect(() => circuit.dispose()).not.toThrow();
  });
});
