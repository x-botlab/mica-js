import { describe, expect, test } from 'vitest';
import { createTestCircuit } from '../compiler/test-helpers';
import { deviceBoundaryOf, type Circuit } from './circuit';

for (const engine of ['reference', 'jit'] as const)
  describe(`fault progress (${engine})`, () => {
    async function circuit(): Promise<{ probe: Circuit; counter: () => unknown }> {
      const probe = await createTestCircuit(
        {
          devices: [
            {
              id: 'faulty',
              type: 'fault-counter',
              description: {
                pins: {},
                states: { counter: { type: 'u32', initial: 0 } },
                factory: () => undefined,
                flushOutputs: (io) => io.publish('counter', io.readState('counter')),
                kernel: ({ module, bind }) => {
                  const tick = module.func('fault_counter_tick', { params: [], results: [] });
                  tick.body((b) => {
                    const counter = bind(b).state<'u32'>('counter');
                    const next = b.int.add(counter.load(), b.const('u32', 1));
                    counter.store(next);
                    const failed = b.block([]);
                    const done = b.block([]);
                    b.branch(
                      b.int.cmp('eq', next, b.const('u32', 3)),
                      { target: failed, args: [] },
                      { target: done, args: [] },
                    );
                    b.at(failed, (b) => b.trap('test/third-tick'));
                    b.at(done, (b) => b.return([]));
                  });
                  return { tick };
                },
              },
            },
          ],
          connections: [],
        },
        { engine, electrical: { interpretation: 'two-state' } },
      );
      return {
        probe,
        counter: () => {
          let value: unknown;
          deviceBoundaryOf(probe).publishOutputs('faulty', (_port, payload) => {
            value = payload;
          });
          return value;
        },
      };
    }

    test('advances only the completed prefix of a failed batch, retaining failed-phase writes', async () => {
      const { probe, counter } = await circuit();
      probe.runBatch(1);
      expect(probe.tickCount).toBe(1n);
      expect(() => probe.runBatch(10)).toThrow();
      expect(probe.tickCount).toBe(2n);
      expect(probe.virtualTime).toBe(2);
      expect(counter()).toBe(3);
      expect(() => probe.runBatch(10)).toThrow();
      expect(probe.tickCount).toBe(2n);
      expect(probe.virtualTime).toBe(2);
    });

    test('does not count a failed individual step', async () => {
      const { probe, counter } = await circuit();
      probe.step();
      probe.step();
      expect(probe.tickCount).toBe(2n);
      expect(() => probe.step()).toThrow();
      expect(probe.tickCount).toBe(2n);
      expect(probe.virtualTime).toBe(2);
      expect(counter()).toBe(3);
    });
  });
