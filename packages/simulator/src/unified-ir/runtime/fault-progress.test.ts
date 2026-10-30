import type { StateRef } from '@mica-js/ir';
import { describe, expect, test } from 'vitest';
import { Circuit } from './circuit';

for (const engine of ['reference', 'jit'] as const)
  describe(`fault progress (${engine})`, () => {
    async function circuit() {
      let counter: StateRef<'u32'>;
      const result = await Circuit.create(
        {
          devices: [
            {
              id: 'faulty',
              type: 'fault-counter',
              description: {
                pins: {},
                kernel: ({ module }) => {
                  counter = module.state('counter', 'u32', 0);
                  const tick = module.func('fault_counter_tick', { params: [], results: [] });
                  tick.body((b) => {
                    const next = b.int.add(b.state.load(counter), b.const('u32', 1));
                    b.state.store(counter, next);
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
        { engine },
      );
      return { result, counter: () => result.jit.storage.loadState(counter) };
    }

    test('advances only the completed prefix of a failed batch, retaining failed-phase writes', async () => {
      const { result, counter } = await circuit();
      result.runBatch(1);
      expect(result.tickCount).toBe(1n);
      expect(() => result.runBatch(10)).toThrow();
      expect(result.tickCount).toBe(2n);
      expect(result.virtualTime).toBe(2);
      expect(counter()).toBe(3);
      expect(() => result.runBatch(10)).toThrow();
      expect(result.tickCount).toBe(2n);
      expect(result.virtualTime).toBe(2);
      result.dispose();
    });

    test('does not count a failed individual step', async () => {
      const { result, counter } = await circuit();
      result.step();
      result.step();
      expect(result.tickCount).toBe(2n);
      expect(() => result.step()).toThrow();
      expect(result.tickCount).toBe(2n);
      expect(result.virtualTime).toBe(2);
      expect(counter()).toBe(3);
      result.dispose();
    });
  });
