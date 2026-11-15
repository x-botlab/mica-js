import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import type { Board, JitTranslate } from '../types';

/**
 * A reaction that calls a model function with side effects. The synchronous backend
 * must bind once per instance, call the callee directly (no host.call/delegate), and
 * report its mode through the existing observation probe.
 */

const CYCLE_PS = 10;

const translate: JitTranslate = ({ pc }, block) => {
  block.instruction({ pc, nextPc: 0 }, (body) => {
    const zero = body.constant(types.number, 0);
    const one = body.constant(types.number, 1);
    const level = body.readState('level', types.number);
    const high = body.combineIntents(
      body.resistor(body.pin('mid'), body.constant(types.number, 1000)),
    );
    const low = body.combineIntents(
      body.resistor(body.pin('gnd'), body.constant(types.number, 1000)),
    );
    body.if(
      body.equal(types.number, level, zero),
      (yes) => {
        yes.writeIntent('drive', high);
        yes.writeState('level', one);
      },
      (no) => {
        no.writeIntent('drive', low);
        no.writeState('level', zero);
      },
    );
    body.elapse(body.constant(types.number, CYCLE_PS));
  });
  return block.finish();
};

function model(scalar = true) {
  const builder = createDeviceBuilder({ name: 'SynchronousReaction' });
  builder.memory({ name: 'code', length: 16 });
  builder.state({ name: 'pc', type: types.number, initial: 0 });
  builder.state({ name: 'level', type: types.number, initial: 0 });
  builder.state({ name: 'sources', type: types.number, initial: 41 });
  builder.state({ name: 'out', type: types.number, initial: 0 });
  builder.state({ name: 'count', type: types.number, initial: 0 });
  builder.pin({ name: 'mid' });
  builder.pin({ name: 'gnd' });
  builder.pin({ name: 'drive', low: 0.8, high: 2.0 });
  builder.fn({ name: 'sourcePlusOne', params: [], returns: types.number }, (body) =>
    body.returnValue(
      body.add(body.readState('sources', types.number), body.constant(types.number, 1)),
    ),
  );
  builder.reaction(
    {
      name: 'watchDrive',
      sourcePath: scalar ? ['drive', 'sample', 'level'] : ['drive', 'sample'],
      sourceType: (scalar ? types.logic : types.sample) as never,
      previous: 'previousLevel',
      current: 'currentLevel',
      captures: [],
    },
    {},
    (body) => {
      body.writeState('out', body.callValue('sourcePlusOne', types.number));
      body.writeState(
        'count',
        body.add(body.readState('count', types.number), body.constant(types.number, 1)),
      );
    },
  );
  return builder.finish();
}

function createScenario(execution: 'throughput' | 'precise', scalar = true) {
  const library = createDeviceLibrary([
    {
      id: 'dut',
      model: model(scalar),
      create: (context) => {
        const registration = context.attachJit({
          entry: 'dut',
          code: 'code',
          pc: 'pc',
          translate,
        });
        return { sync() {}, dispose: () => registration.dispose() };
      },
    },
  ]);
  const board = createBoard(
    library,
    {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [
        { id: 'mid', pins: [{ instance: 'dut', pin: 'mid' }], voltage: 2.5 },
        { id: 'gnd', pins: [{ instance: 'dut', pin: 'gnd' }], voltage: 0 },
      ],
    },
    { execution },
  );
  const instance = (board as unknown as { instances: readonly Instance[] }).instances[0]!;
  return { board, instance };
}

function reactionModes(
  board: Board,
): { instance: string; name: string; mode: string; functions: number }[] {
  const probe = (
    board as unknown as Record<
      symbol,
      () => { reactions: { instance: string; name: string; mode: string; functions: number }[] }
    >
  )[Symbol.for('mica-js.simulator/observations')]!;
  return probe().reactions;
}

describe('synchronous reaction integration', () => {
  it('uses a bound synchronous runner and direct callee calls', () => {
    const { board, instance } = createScenario('throughput');
    try {
      let calls = 0;
      const originalCall = instance.host.call;
      instance.host.call = (...args) => {
        calls += 1;
        return originalCall(...args);
      };
      board.runUntil(15);
      expect(instance.states.get('out')).toBe(42);
      expect(instance.states.get('count')).toBeGreaterThan(0);
      expect(calls).toBe(0);
      expect(reactionModes(board)[0]).toMatchObject({
        instance: 'dut',
        name: 'watchDrive',
        mode: 'sync',
        functions: 1,
      });
    } finally {
      board.dispose();
    }
  });

  it('matches precise execution and keeps the per-instance binding isolated', () => {
    const throughput = createScenario('throughput');
    const precise = createScenario('precise');
    try {
      throughput.board.runUntil(25);
      precise.board.runUntil(25);
      for (const name of ['level', 'sources', 'out', 'count']) {
        expect(throughput.instance.states.get(name)).toBe(precise.instance.states.get(name));
      }
      expect(reactionModes(throughput.board)[0]!.mode).toBe('sync');
      expect(reactionModes(precise.board)[0]!.mode).toBe('sync');
    } finally {
      throughput.board.dispose();
      precise.board.dispose();
    }
  });

  it('keeps generic observation semantics for a non-scalar source', () => {
    const { board, instance } = createScenario('throughput', false);
    try {
      board.runUntil(15);
      expect(instance.states.get('out')).toBe(42);
      expect(reactionModes(board)[0]!.mode).toBe('sync');
    } finally {
      board.dispose();
    }
  });
});
