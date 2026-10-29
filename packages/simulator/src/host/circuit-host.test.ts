import { describe, expect, it } from 'vitest';
import { Circuit } from '../unified-ir/runtime';
import { createCircuitDeviceSimulationHost } from './circuit-host';
import { TOGGLE_TYPE, toggleDescription } from './test-helpers';
import type { DeviceTopic } from './types';

const TOPICS: readonly DeviceTopic[] = [
  {
    symbol: 'K1',
    designator: 'K1',
    port: 'lamp',
    direction: 'input',
    type: 'boolean',
  },
];

async function createCircuit(): Promise<Circuit> {
  return Circuit.create({
    devices: [{ id: 'K1', type: TOGGLE_TYPE, description: toggleDescription() }],
    connections: [],
  });
}

describe('createCircuitDeviceSimulationHost', () => {
  it('wraps an already loaded circuit without taking ownership of its loading', async () => {
    const circuit = await createCircuit();
    const delivered: string[] = [];
    const host = createCircuitDeviceSimulationHost({
      circuit,
      topics: TOPICS,
      deliver: (symbol, port, payload) => delivered.push(`${symbol}.${port}:${String(payload)}`),
    });

    try {
      expect(await host.getTopics()).toBe(TOPICS);
      expect(await host.getSchematic()).toBeUndefined();
      expect(await host.tick(10_000)).toEqual({ simTime: 10_000, executed: 1 });
      await host.deliver({ symbol: 'K1', port: 'lamp' }, true);
      expect(delivered).toEqual(['K1.lamp:true']);
      await host.reset();
      expect(await host.getSimTime()).toBe(0);
    } finally {
      await host.dispose();
    }
    expect(circuit.disposed).toBe(true);
  });

  it('leaves disposal to the caller when it retains ownership', async () => {
    const circuit = await createCircuit();
    const host = createCircuitDeviceSimulationHost({
      circuit,
      ownsCircuit: false,
      deliver: () => {},
    });
    await host.dispose();
    expect(circuit.disposed).toBe(false);
    circuit.dispose();
  });
});
