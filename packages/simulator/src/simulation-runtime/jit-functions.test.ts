import { buildJitFunctions, createDeviceBuilder, types } from '@mica-js/device-model';
import { expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { DeviceContext } from '../types';

it.each(['precise', 'throughput'] as const)(
  'executes JIT-local functions on the current instruction state (%s)',
  (execution) => {
    const model = createDeviceBuilder({ name: 'JitFunctions' });
    model.memory({ name: 'code', length: 4 });
    model.memory({ name: 'scratch', length: 4 });
    for (const name of ['pc', 'counter', 'result', 'guarded', 'observed'])
      model.state({ name, type: types.number, initial: 0 });
    model.on({ name: 'watch', sourcePath: ['guarded'] }, (b) => {
      b.writeState('observed', b.readState('guarded', types.number));
    });
    let functions: ReturnType<typeof buildJitFunctions> | undefined;
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: model.finish(),
        create(context: DeviceContext) {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            pc: 'pc',
            functions: (base) =>
              (functions ??= buildJitFunctions(base, (fns) => {
                fns.fn(
                  {
                    name: 'update',
                    params: [{ name: 'increment', type: types.number }],
                    returns: types.number,
                  },
                  (b, { increment }) => {
                    const value = b.add(b.readState('counter', types.number), increment);
                    b.writeState('counter', value);
                    const before = b.load8('scratch', 0);
                    b.store8('scratch', 0, b.add(before, value));
                    b.returnValue(before);
                  },
                );
                fns.fn({ name: 'guardedUpdate', params: [] }, (b) => {
                  b.writeState('guarded', b.callValue('update', types.number, 2));
                });
              })),
            translate({ pc }, block) {
              block.instruction({ pc, nextPc: 1 - pc }, (b) => {
                if (pc === 0) {
                  b.writeState('counter', 1);
                  b.store8('scratch', 0, 10);
                  b.callValue('update', types.number, 2);
                  b.writeState('result', b.callValue('update', types.number, 4));
                } else {
                  b.call('guardedUpdate');
                }
                b.elapse(1);
              });
              return block.finish();
            },
          });
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const create = () =>
      createBoard(
        library,
        { instances: [{ id: 'probe', type: 'probe' }], nets: [] },
        { execution },
      );
    const instanceOf = (board: ReturnType<typeof create>) =>
      (board as unknown as { instances: Instance[] }).instances[0]!;
    const board = create();
    try {
      for (let horizon = 1; horizon <= 20; horizon++) board.runUntil(horizon);
      const instance = instanceOf(board);
      const jit = instance.jits[0]!;
      expect(instance.states.get('result')).toBe(13);
      expect(instance.states.get('observed')).toBe(20);
      expect(instance.states.get('counter')).toBe(9);
      expect(instance.memories.get('scratch')![0]).toBe(29);
      if (execution === 'throughput') {
        const stats = directJitStats(jit)!;
        expect(stats.directCalls - stats.directFallbacks).toBeGreaterThan(0);
        expect(stats.directFallbacks).toBeGreaterThan(0);
        expect(jit.direct?.program.writeStates).toContain('guarded');
        expect(jit.direct?.program.writeMemories).toContain('scratch');
      }
      const second = create();
      try {
        expect(instanceOf(second).jits[0]?.model).toBe(jit.model);
        expect(instanceOf(second).states.get('counter')).toBe(0);
      } finally {
        second.dispose();
      }
    } finally {
      board.dispose();
    }
  },
);

it('falls back before partially executing a caller with an unsupported JIT-local function', () => {
  const model = createDeviceBuilder({ name: 'JitFunctionsFallback' });
  model.memory({ name: 'code', length: 4 });
  model.property({ name: 'increment', type: types.number, default: 2 });
  for (const name of ['pc', 'counter']) model.state({ name, type: types.number, initial: 0 });
  const library = createDeviceLibrary([
    {
      id: 'probe',
      model: model.finish(),
      create(context: DeviceContext) {
        const registration = context.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          functions: (base) =>
            buildJitFunctions(base, (fns) => {
              fns.pureFn({ name: 'readIncrement', params: [], returns: types.number }, (b) => {
                b.returnValue(b.readProperty('increment', types.number));
              });
            }),
          translate({ pc }, block) {
            block.instruction({ pc, nextPc: 1 - pc }, (b) => {
              if (pc === 1) {
                b.writeState('counter', b.add(b.readState('counter', types.number), 1));
                const increment = b.callValue('readIncrement', types.number);
                b.writeState('counter', b.add(b.readState('counter', types.number), increment));
              }
              b.elapse(1);
            });
            return block.finish();
          },
        });
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(
    library,
    { instances: [{ id: 'probe', type: 'probe' }], nets: [] },
    { execution: 'throughput' },
  );
  try {
    for (let horizon = 1; horizon <= 20; horizon++) board.runUntil(horizon);
    const instance = (board as unknown as { instances: Instance[] }).instances[0]!;
    const jit = instance.jits[0]!;
    expect(instance.states.get('counter')).toBe(30);
    expect(jit.cache.has(1)).toBe(true);
    expect(jit.direct?.pcs.has(0)).toBe(true);
    expect(jit.direct?.pcs.has(1)).toBe(false);
  } finally {
    board.dispose();
  }
});
