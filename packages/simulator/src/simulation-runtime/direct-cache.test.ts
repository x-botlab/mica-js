import { compileDirectJit } from '@mica-js/compiler';
import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import type { Jit } from '../runtime/state';
import type { JitTranslate } from '../types';

const translate: JitTranslate = ({ pc, code }, block) => {
  const delta = code[pc] ?? 1;
  block.instruction({ pc, nextPc: 1 }, (b) => {
    b.writeState('tick', b.add(b.readState('tick', types.number), b.constant(types.number, delta)));
    b.elapse(1);
  });
  return block.finish();
};

function model() {
  const builder = createDeviceBuilder({ name: 'DirectCache' });
  builder.memory({ name: 'code', length: 16 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'tick', type: types.number, initial: 0 });
  return builder.finish();
}

describe('direct JIT incremental cache', () => {
  it('clears compiled bodies when code memory changes and recompiles from the new bytes', () => {
    const library = createDeviceLibrary([
      {
        id: 'cache',
        model: model(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'cache',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(16).fill(1));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'cache', type: 'cache' }],
      nets: [],
    });
    try {
      board.runUntil(board.time + 5);
      expect(board.status).toBe('ready');
      const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
      const jit = instance.jits[0] as Jit;
      const cache = jit.directCache;
      expect(cache).toBeDefined();
      expect(compileDirectJit.cacheStats(cache!).entries).toBeGreaterThan(0);
      const initialCompiles = compileDirectJit.cacheStats(cache!).compiledBlocks;
      const before = instance.states.get('tick') as number;

      instance.loadBytes('code', new Uint8Array(16).fill(2), 0);
      board.runUntil(board.time + 5);

      expect(compileDirectJit.cacheStats(cache!).clears).toBe(1);
      expect(compileDirectJit.cacheStats(cache!).compiledBlocks).toBe(initialCompiles + 1);
      expect(instance.states.get('tick')).toBe(before + 10);
    } finally {
      board.dispose();
    }
  });
});
