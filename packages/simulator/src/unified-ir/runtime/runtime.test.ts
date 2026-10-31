import { createTestCircuit } from '../compiler/test-helpers';
import { describe, expect, it } from 'vitest';
import { lampSinkDescription, toggleDriverDescription } from '../compiler/test-helpers';
import type { CircuitRuntimeOptions } from './types';
import { CircuitError } from './types';
import { deviceBoundaryOf, type Circuit } from './circuit';
import { driverOnlyInput, driverSinkInput } from './test-helpers';

async function counterCircuit() {
  return createTestCircuit({
    devices: [
      {
        id: 'counter',
        type: 'counter',
        description: {
          pins: {},
          states: { count: { type: 'u32', initial: 3 } },
          factory: () => ({
            initialize(api) {
              api.state<'u32'>('count').store(api.builder.const('u32', 7));
            },
            tick(api) {
              const count = api.state<'u32'>('count');
              count.store(api.builder.int.add(count.load(), api.builder.const('u32', 1)));
            },
            flushOutputs(io) {
              io.publish('count', io.readState('count'));
            },
          }),
        },
      },
    ],
    connections: [],
  });
}

function countOutput(circuit: Circuit): unknown {
  let value: unknown;
  deviceBoundaryOf(circuit).publishOutputs('counter', (_port, payload) => {
    value = payload;
  });
  return value;
}

describe('Circuit.create', () => {
  it('creates and initializes a circuit', async () => {
    const circuit = await createTestCircuit(driverSinkInput());

    expect(circuit.tickCount).toBe(0n);
    expect(circuit.virtualTime).toBe(0);
    expect(circuit.disposed).toBe(false);
  });

  it('runs the initialize entry before returning', async () => {
    const circuit = await counterCircuit();
    expect(countOutput(circuit)).toBe(7);
    expect(circuit.tickCount).toBe(0n);
    circuit.dispose();
  });

  it('propagates compiler errors', async () => {
    await expect(createTestCircuit({ devices: [], connections: [] })).rejects.toMatchObject({
      name: 'UnifiedIRCompilerError',
      code: 'invalid-input',
    });

    await expect(
      createTestCircuit({
        devices: [
          {
            id: 'dup',
            type: 'toggle-driver',
            description: toggleDriverDescription(),
          },
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
    ];
    for (const options of cases) {
      await expect(createTestCircuit(driverOnlyInput(), options)).rejects.toMatchObject({
        name: 'CircuitError',
        code: 'invalid-options',
      });
    }
  });

  it('accepts a custom instance id and reference engine', async () => {
    const circuit = await createTestCircuit(driverSinkInput(), {
      engine: 'reference',
      instanceId: 'my-circuit',
      validateIR: true,
    });
    circuit.step();
    expect(circuit.tickCount).toBe(1n);
  });
});

describe('Circuit.runBatch', () => {
  it('accumulates ticks across calls', async () => {
    const circuit = await createTestCircuit(driverOnlyInput());

    circuit.runBatch(1000);
    expect(circuit.tickCount).toBe(1000n);

    circuit.runBatch(500);
    expect(circuit.tickCount).toBe(1500n);
  });

  it('treats a zero batch as a no-op', async () => {
    const circuit = await createTestCircuit(driverOnlyInput());
    circuit.runBatch(0);
    expect(circuit.tickCount).toBe(0n);
  });

  it('rejects counts outside the u32 range', async () => {
    const circuit = await createTestCircuit(driverOnlyInput());
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
    const batched = await counterCircuit();
    const stepped = await counterCircuit();
    batched.runBatch(7);
    for (let index = 0; index < 7; index += 1) stepped.step();
    expect(batched.tickCount).toBe(7n);
    expect(stepped.tickCount).toBe(7n);
    expect(countOutput(batched)).toBe(14);
    expect(countOutput(stepped)).toBe(14);
    batched.dispose();
    stepped.dispose();
  });
});

describe('Circuit.step', () => {
  it('advances one tick at a time', async () => {
    const circuit = await counterCircuit();
    circuit.step();
    expect(circuit.tickCount).toBe(1n);
    expect(countOutput(circuit)).toBe(8);
    circuit.step();
    expect(circuit.tickCount).toBe(2n);
    expect(countOutput(circuit)).toBe(9);
    circuit.dispose();
  });
});

describe('Circuit.reset', () => {
  it('restores initial memory, reruns initialization and resets the clock', async () => {
    const circuit = await counterCircuit();
    circuit.runBatch(5, 10);
    expect(countOutput(circuit)).toBe(12);
    expect(circuit.tickCount).toBe(5n);
    expect(circuit.virtualTime).toBe(50);
    circuit.reset();
    expect(circuit.tickCount).toBe(0n);
    expect(circuit.virtualTime).toBe(0);
    expect(countOutput(circuit)).toBe(7);
    circuit.step();
    expect(countOutput(circuit)).toBe(8);
    circuit.dispose();
  });

  it('replays the same output trace as a freshly created circuit', async () => {
    const reused = await counterCircuit();
    const fresh = await counterCircuit();
    reused.runBatch(9);
    reused.reset();
    const reusedTrace: unknown[] = [];
    const freshTrace: unknown[] = [];
    for (let index = 0; index < 8; index += 1) {
      reused.step();
      fresh.step();
      reusedTrace.push(countOutput(reused));
      freshTrace.push(countOutput(fresh));
    }
    expect(reusedTrace).toEqual(freshTrace);
    expect(reused.tickCount).toBe(8n);
    reused.dispose();
    fresh.dispose();
  });
});

describe('Circuit.dispose', () => {
  it('releases the runtime and rejects further use', async () => {
    const circuit = await createTestCircuit(driverSinkInput());

    circuit.dispose();
    expect(circuit.disposed).toBe(true);

    expect(() => circuit.step()).toThrowError(CircuitError);
    expect(() => circuit.runBatch(1)).toThrowError(CircuitError);
    expect(() => circuit.reset()).toThrowError(CircuitError);
    expect(() => circuit.tickCount).toThrowError(CircuitError);
    expect(() => circuit.virtualTime).toThrowError(CircuitError);
  });

  it('is idempotent', async () => {
    const circuit = await createTestCircuit(driverOnlyInput());
    circuit.dispose();
    expect(() => circuit.dispose()).not.toThrow();
  });
});
