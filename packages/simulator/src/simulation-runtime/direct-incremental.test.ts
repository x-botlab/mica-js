import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import { directJitStats } from '../runtime/jit';
import type { Jit } from '../runtime/state';
import type { JitCodeMetadata, JitCodeMetadataInput, JitTranslate } from '../types';

function instanceOf(board: ReturnType<typeof createBoard>): Instance {
  return (board as unknown as { instances: readonly Instance[] }).instances[0]!;
}

function jitOf(board: ReturnType<typeof createBoard>): Jit {
  return instanceOf(board).jits[0] as Jit;
}

describe('direct JIT incremental session', () => {
  it('grows routes and shards without replacing the fixed dispatcher', () => {
    const builder = createDeviceBuilder({ name: 'DirectIncremental' });
    builder.memory({ name: 'code', length: 80 });
    builder.state({ name: 'pc', type: types.number, initial: 0 });
    builder.state({ name: 'counts', type: types.number, initial: 0 });
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: (pc + 1) % 80 }, (body) => {
        body.writeState(
          'counts',
          body.add(body.readState('counts', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'inc',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'inc',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(80));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'inc', type: 'inc' }],
      nets: [],
    });
    try {
      board.runUntil(80);
      const jit = jitOf(board);
      const stats = directJitStats(jit)!;
      expect(instanceOf(board).states.get('counts')).toBe(80);
      expect(stats.directCompiles).toBe(1);
      expect(stats.directSessions).toBe(1);
      expect(stats.directRoutes).toBe(80);
      expect(stats.directShards).toBeGreaterThan(1);
      expect(stats.directShardCompiles).toBeGreaterThanOrEqual(stats.directShards);
      expect(stats.directRouteInstalls).toBeGreaterThanOrEqual(80);
      expect(stats.directBodyBytes).toBeGreaterThan(0);
      expect(stats.directShardBytes).toBeGreaterThan(0);
      expect(stats.directDispatcherBytes).toBeGreaterThan(0);
      expect(jit.direct!.session.routeCount).toBe(80);
      expect(jit.direct!.session.shardCount).toBe(stats.directShards);
    } finally {
      board.dispose();
    }
  });

  it('does not repeat polling consume when a zero-time suffix requests assembly', () => {
    const builder = createDeviceBuilder({ name: 'DirectAssemblyPolling' });
    builder.memory({ name: 'code', length: 4 });
    for (const name of ['pc', 'rounds', 'consumeRuns'])
      builder.state({ name, type: types.number, initial: 0 });
    builder.pureFn({ name: 'awakeNow', params: [], returns: types.bool }, (body) => {
      body.returnValue(body.constant(types.bool, true));
    });
    builder.fn({ name: 'consumeWake', params: [] }, (body) => {
      body.writeState(
        'consumeRuns',
        body.add(body.readState('consumeRuns', types.number), body.constant(types.number, 1)),
      );
    });
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: 1 - pc }, (body) => {
        body.writeState(
          'rounds',
          body.add(body.readState('rounds', types.number), body.constant(types.number, 1)),
        );
        body.elapse(1);
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'poll',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'poll',
            code: 'code',
            pc: 'pc',
            polling: [{ pc: 0, predicate: 'awakeNow', consume: 'consumeWake' }],
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(4));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'poll', type: 'poll' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      board.runUntil(4);
      const instance = instanceOf(board);
      const jit = jitOf(board);
      expect(instance.states.get('rounds')).toBe(4);
      // PC 0 is never direct-admitted because it owns the polling declaration. Every return
      // from direct PC 1 yields to the scheduler, so consume runs exactly once per PC 0 turn.
      expect(instance.states.get('consumeRuns')).toBe(2);
      expect(directJitStats(jit)!.directSessions).toBe(1);
      expect(directJitStats(jit)!.directGenericInstructions).toBe(2);
      expect(jit.direct!.session.has(0)).toBe(false);
      expect(jit.direct!.session.has(1)).toBe(true);
    } finally {
      board.dispose();
    }
  });

  it('invalidates the session when the hook entry barrier discovers a new dependency', () => {
    const builder = createDeviceBuilder({ name: 'DirectHookBarrier' });
    builder.memory({ name: 'code', length: 4 });
    for (const name of ['pc', 'extra', 'hookRuns'])
      builder.state({ name, type: types.number, initial: 0 });
    builder.state({ name: 'phase', type: types.bool, initial: false });
    builder.derived({ name: 'shouldHook', type: types.bool }, (body) => {
      body.if(
        body.readState('phase', types.bool),
        (yes) => {
          yes.returnValue(
            yes.greaterThan(yes.readState('extra', types.number), yes.constant(types.number, 0)),
          );
        },
        (no) => no.returnValue(no.constant(types.bool, false)),
      );
    });
    builder.fn({ name: 'enterHook', params: [] }, (body) => {
      body.writeState(
        'hookRuns',
        body.add(body.readState('hookRuns', types.number), body.constant(types.number, 1)),
      );
    });
    builder.start((body) => {
      body.wait(1);
      body.writeState('phase', body.constant(types.bool, true));
    });
    const translate: JitTranslate = ({ pc }, block) => {
      block.instruction({ pc, nextPc: pc }, (body) => body.elapse(1));
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'hook',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'hook',
            code: 'code',
            pc: 'pc',
            beforeInstruction: { when: 'shouldHook', call: 'enterHook' },
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array(4));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'hook', type: 'hook' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      board.runUntil(1);
      const instance = instanceOf(board);
      const jit = jitOf(board);
      const first = jit.direct!.session;
      expect(directJitStats(jit)!.directSessions).toBe(1);

      board.runUntil(3);
      // The derived hook predicate now reads `extra`. That is an entry-barrier generation
      // change even though the hook still returns false.
      expect(jit.directHookReads.has(instance.stateResources.get('extra')!)).toBe(true);
      expect(jit.directHookReads.has(instance.stateResources.get('phase')!)).toBe(true);
      expect(directJitStats(jit)!.directSessions).toBe(2);
      expect(directJitStats(jit)!.directCompiles).toBe(2);
      expect(jit.direct!.session).not.toBe(first);
      expect(first.routeCount).toBe(0);
      expect(instance.states.get('hookRuns')).toBe(0);
    } finally {
      board.dispose();
    }
  });

  it('finishes one old suffix then enters the new body and nextPc after a code write', () => {
    const builder = createDeviceBuilder({ name: 'DirectCodeInvalidation' });
    builder.memory({ name: 'code', length: 4 });
    for (const name of ['pc', 'prefixes', 'suffixes', 'marker'])
      builder.state({ name, type: types.number, initial: 0 });
    builder.start((body) => {
      body.wait(10);
      body.store8('code', body.constant(types.number, 0), body.constant(types.number, 1));
      body.store8('code', body.constant(types.number, 1), body.constant(types.number, 7));
    });
    const translate: JitTranslate = ({ pc, code }, block) => {
      if (pc === 0) {
        const target = code[0] || 0;
        const tail = code[1] || 1;
        block.instruction({ pc, nextPc: target }, (body) => {
          body.writeState(
            'prefixes',
            body.add(body.readState('prefixes', types.number), body.constant(types.number, 1)),
          );
          body.elapse(10);
          body.writeState(
            'suffixes',
            body.add(body.readState('suffixes', types.number), body.constant(types.number, tail)),
          );
          body.writeState(
            'marker',
            body.add(body.readState('marker', types.number), body.constant(types.number, tail)),
          );
        });
      } else {
        block.instruction({ pc, nextPc: pc }, (body) => {
          body.writeState(
            'marker',
            body.add(body.readState('marker', types.number), body.constant(types.number, 100)),
          );
          body.stop();
        });
      }
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'code-write',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'code-write',
            code: 'code',
            pc: 'pc',
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array([0, 1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'code-write', type: 'code-write' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      board.runUntil(21);
      const instance = instanceOf(board);
      const jit = jitOf(board);
      // The old suffix contributes the old tail (1) exactly once. The new PC 0 instruction
      // uses the new nextPc and tail (7), then PC 1 enters the freshly translated body.
      expect(instance.states.get('prefixes')).toBe(2);
      expect(instance.states.get('suffixes')).toBe(8);
      expect(instance.states.get('marker')).toBe(108);
      expect(directJitStats(jit)!.directSessions).toBe(2);
      expect(jit.direct!.session.has(0)).toBe(true);
      expect(jit.direct!.session.has(1)).toBe(true);
    } finally {
      board.dispose();
    }
  });

  it('finishes one old suffix and rebuilds after a metadata refresh at a suspended write', () => {
    const builder = createDeviceBuilder({ name: 'DirectMetadataInvalidation' });
    builder.memory({ name: 'code', length: 8 });
    builder.memory({ name: 'scratch', length: 1 });
    for (const name of ['pc', 'prefixes', 'suffixes', 'marker'])
      builder.state({ name, type: types.number, initial: 0 });
    builder.start((body) => {
      body.wait(10);
      body.store8('code', body.constant(types.number, 0), body.constant(types.number, 2));
    });
    const providerCalls: string[] = [];
    const metadata = (input: JitCodeMetadataInput): JitCodeMetadata => {
      providerCalls.push(input.region.memory);
      return { polling: [], delays: new Map() };
    };
    const translate: JitTranslate = ({ pc, code }, block) => {
      const increment = code[0] || 1;
      block.instruction({ pc, nextPc: 0 }, (body) => {
        body.writeState(
          'prefixes',
          body.add(body.readState('prefixes', types.number), body.constant(types.number, 1)),
        );
        body.elapse(10);
        body.writeState(
          'suffixes',
          body.add(
            body.readState('suffixes', types.number),
            body.constant(types.number, increment),
          ),
        );
        body.writeState(
          'marker',
          body.add(body.readState('marker', types.number), body.constant(types.number, increment)),
        );
      });
      return block.finish();
    };
    const library = createDeviceLibrary([
      {
        id: 'meta',
        model: builder.finish(),
        create: (context) => {
          const registration = context.attachJit({
            entry: 'meta',
            code: 'code',
            pc: 'pc',
            codeMetadata: metadata,
            translate,
          });
          try {
            context.loadBytes('code', new Uint8Array([1]));
          } catch (cause) {
            registration.dispose();
            throw cause;
          }
          return { sync() {}, dispose: () => registration.dispose() };
        },
      },
    ]);
    const board = createBoard(
      library,
      { instances: [{ id: 'meta', type: 'meta' }], nets: [] },
      { execution: 'throughput' },
    );
    try {
      board.runUntil(31);
      const instance = instanceOf(board);
      const jit = jitOf(board);
      // One old suffix contributes 1 and the two completed new suffixes contribute 2 each.
      // The fourth prefix is suspended at the cutoff.
      expect(instance.states.get('prefixes')).toBe(4);
      expect(instance.states.get('suffixes')).toBe(5);
      expect(instance.states.get('marker')).toBe(5);
      expect(directJitStats(jit)!.directSessions).toBe(2);
      expect(directJitStats(jit)!.directCompiles).toBe(2);
      expect(providerCalls.filter((memory) => memory === 'code').length).toBeGreaterThan(1);
      expect(jit.direct!.session.has(0)).toBe(true);
    } finally {
      board.dispose();
    }
  });
});
