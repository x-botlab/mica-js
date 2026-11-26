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
    b.writeState(
      'tick',
      b.add(b.readState('tick', types.number), b.constant(types.number, delta * 10)),
    );
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
  it('finishes the active direct suffix before recompiling from changed code bytes', () => {
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
      const active = jit.direct!;
      const activeSession = active.session;
      expect(active.frame.resume).not.toBe(0);
      expect(cache).toBeDefined();
      expect(compileDirectJit.cacheStats(cache!).entries).toBeGreaterThan(0);
      const initialCompiles = compileDirectJit.cacheStats(cache!).compiledBlocks;
      const before = instance.states.get('tick') as number;

      instance.loadBytes('code', new Uint8Array(16).fill(2), 0);
      board.runUntil(board.time);
      expect(jit.direct).toBe(active);
      expect(instance.states.get('tick')).toBe(before);

      board.runUntil(board.time + 5);

      expect(compileDirectJit.cacheStats(cache!).clears).toBe(1);
      expect(compileDirectJit.cacheStats(cache!).compiledBlocks).toBe(initialCompiles + 1);
      expect(jit.direct!.session).not.toBe(activeSession);
      expect(activeSession.routeCount).toBe(0);
      // One old suffix, five new prefixes, four new suffixes. The last suffix waits at the cutoff.
      expect(instance.states.get('tick')).toBe(before + 10 + 5 * 2 + 4 * 20);
    } finally {
      board.dispose();
    }
  });
});
