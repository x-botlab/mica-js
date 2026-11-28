import {
  buildJitFunctions,
  createDeviceBuilder,
  types,
  type DeviceIR,
} from '@mica-js/device-model';
import { expect, it, vi } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { DeviceContext } from '../types';

it.each(['precise', 'throughput'] as const)(
  'loads helper groups on demand and keeps prior translated blocks executable (%s)',
  (execution) => {
    const model = createDeviceBuilder({ name: 'LazyJitFunctions' });
    model.memory({ name: 'code', length: 3 });
    model.state({ name: 'pc', type: types.number, initial: 0 });
    model.state({ name: 'result', type: types.number, initial: 0 });
    const add = vi.fn((base: DeviceIR) =>
      buildJitFunctions(base, (f) => {
        f.fn({ name: 'inc', params: [] }, (b) => {
          b.writeState('result', b.add(b.readState('result', types.number), 1));
        });
      }),
    );
    const double = vi.fn((base: DeviceIR) =>
      buildJitFunctions(base, (f) => {
        f.fn({ name: 'incTwice', params: [] }, (b) => {
          b.call('inc');
          b.call('inc');
        });
      }),
    );
    const unused = vi.fn(() => {
      throw new Error('The unused group must remain unloaded');
    });
    const library = createDeviceLibrary([
      {
        id: 'probe',
        model: model.finish(),
        create(context: DeviceContext) {
          const registration = context.attachJit({
            entry: 'cpu',
            code: 'code',
            pc: 'pc',
            functionGroups: { add, double, unused },
            translate(input, builder) {
              const { pc } = input;
              const block =
                pc === 0 ? builder : input.withFunctions!('add', ...(pc === 2 ? ['double'] : []));
              block.instruction({ pc, nextPc: (pc + 1) % 3 }, (b) => {
                if (pc === 1) b.call('inc');
                if (pc === 2) b.call('incTwice');
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
      { execution },
    );
    try {
      expect(add).not.toHaveBeenCalled();
      expect(double).not.toHaveBeenCalled();
      for (let time = 1; time <= 12; time++) board.runUntil(time);
      const instance = (board as unknown as { instances: Instance[] }).instances[0]!;
      expect(instance.states.get('result')).toBe(12);
      expect(add).toHaveBeenCalledTimes(1);
      expect(double).toHaveBeenCalledTimes(1);
      expect(unused).not.toHaveBeenCalled();
      if (execution === 'throughput')
        expect(directJitStats(instance.jits[0]!)?.directRoutes).toBe(3);
    } finally {
      board.dispose();
    }
  },
);

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
        expect(stats.directDispatchMisses).toBeGreaterThan(0);
        expect(jit.direct?.session.has(0)).toBe(true);
        expect(jit.direct?.session.has(1)).toBe(true);
        expect(stats.directRoutes).toBe(2);
        expect(stats.directShards).toBeGreaterThan(0);
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
