import { createDeviceBuilder, types } from '@mica-js/device-model';
import { describe, expect, it } from 'vitest';
import { createBoard, createDeviceLibrary } from '../runtime';
import type { Instance } from '../runtime/instance';
import type { Board } from '../types';

/**
 * Independent integration regressions for the runtime's synchronous reaction cache and
 * per-instance binding. Compiler-level semantics are covered in the compiler package; these
 * tests exercise the real board construction, reaction scheduling, cache and fault paths.
 */

const OBSERVATIONS = Symbol.for('mica-js.simulator/observations');

type ObservationProbe = (board: Board) => {
  reactions: readonly { instance: string; name: string; mode: string }[];
};

function instances(board: Board): readonly Instance[] {
  return (board as unknown as { instances: readonly Instance[] }).instances;
}

function modeOf(board: Board, instance: string, name: string): string | undefined {
  const probe = (board as unknown as Record<symbol, ObservationProbe>)[OBSERVATIONS]!;
  return probe(board).reactions.find(
    (reaction) => reaction.instance === instance && reaction.name === name,
  )?.mode;
}

function cachedModel(label: string, value: number) {
  const builder = createDeviceBuilder({ name: `SynchronousCache${label}` });
  builder.state({ name: 'trigger', type: types.number, initial: 0 });
  builder.state({ name: 'out', type: types.number, initial: 0 });
  builder.fn({ name: 'value', params: [], returns: types.number }, (body) =>
    body.returnValue(body.constant(types.number, value)),
  );
  builder.reaction(
    {
      name: 'watch',
      sourcePath: ['trigger'],
      sourceType: types.number,
      previous: 'previousTrigger',
      current: 'currentTrigger',
      captures: [],
    },
    {},
    (body) => {
      body.writeState('out', body.callValue('value', types.number));
    },
  );
  builder.start((body) => {
    body.writeState('trigger', body.constant(types.number, 1));
  });
  return builder.finish();
}

describe('synchronous reaction runtime cache', () => {
  it('keeps programs isolated when two DeviceIR models share one root RegionIR', () => {
    const first = cachedModel('A', 41);
    const second = cachedModel('B', 99);
    const firstReaction = first.declarations.find((declaration) => declaration.kind === 'reaction');
    const secondReaction = second.declarations.find(
      (declaration) => declaration.kind === 'reaction',
    );
    expect(firstReaction?.kind).toBe('reaction');
    expect(secondReaction?.kind).toBe('reaction');
    if (firstReaction?.kind !== 'reaction' || secondReaction?.kind !== 'reaction') return;

    // The body calls the same-named function but the models' function tables differ.
    const secondDeclarations = second.declarations.map((declaration) =>
      declaration.kind === 'reaction' ? { ...declaration, body: firstReaction.body } : declaration,
    );
    const sharedSecond = { ...second, declarations: secondDeclarations };

    const library = createDeviceLibrary([
      { id: 'first', model: first, create: () => ({ sync() {}, dispose() {} }) },
      { id: 'second', model: sharedSecond, create: () => ({ sync() {}, dispose() {} }) },
    ]);
    const board = createBoard(library, {
      instances: [
        { id: 'first', type: 'first' },
        { id: 'second', type: 'second' },
      ],
      nets: [],
    });

    try {
      board.runUntil(0);
      const [a, b] = instances(board);
      expect(a!.reactions[0]!.synchronousProgram).not.toBe(b!.reactions[0]!.synchronousProgram);
      expect(a!.states.get('out')).toBe(41);
      expect(b!.states.get('out')).toBe(99);
      expect(modeOf(board, 'first', 'watch')).toBe('sync');
      expect(modeOf(board, 'second', 'watch')).toBe('sync');
    } finally {
      board.dispose();
    }
  });

  it('shares one model program but keeps per-instance handle bindings isolated', () => {
    const builder = createDeviceBuilder({ name: 'SynchronousPerInstance' });
    builder.pin({ name: 'line', low: 0.8, high: 2.0 });
    builder.state({ name: 'trigger', type: types.number, initial: 0 });
    builder.state({ name: 'out', type: types.number, initial: 0 });
    builder.reaction(
      {
        name: 'watch',
        sourcePath: ['trigger'],
        sourceType: types.number,
        previous: 'previousTrigger',
        current: 'currentTrigger',
        captures: [],
      },
      {},
      (body) => {
        const level = body.field(body.readSample('line'), 'level');
        body.if(
          body.equal(types.logic, level, types.logic.members.high),
          (high) => high.writeState('out', high.constant(types.number, 1)),
          (low) => low.writeState('out', low.constant(types.number, 2)),
        );
      },
    );
    builder.start((body) => {
      body.writeState('trigger', body.constant(types.number, 1));
    });
    const model = builder.finish();
    const library = createDeviceLibrary([
      { id: 'dut', model, create: () => ({ sync() {}, dispose() {} }) },
    ]);
    const board = createBoard(library, {
      instances: [
        { id: 'a', type: 'dut' },
        { id: 'b', type: 'dut' },
      ],
      nets: [
        { id: 'lineA', pins: [{ instance: 'a', pin: 'line' }], voltage: 3.3 },
        { id: 'lineB', pins: [{ instance: 'b', pin: 'line' }], voltage: 0 },
      ],
    });

    try {
      board.runUntil(0);
      const [a, b] = instances(board);
      expect(a!.reactions[0]!.synchronousProgram).toBe(b!.reactions[0]!.synchronousProgram);
      expect(a!.states.get('out')).toBe(1);
      expect(b!.states.get('out')).toBe(2);
      expect(modeOf(board, 'a', 'watch')).toBe('sync');
      expect(modeOf(board, 'b', 'watch')).toBe('sync');
    } finally {
      board.dispose();
    }
  });

  it('propagates an assert failure after the prefix and never replays it', () => {
    const builder = createDeviceBuilder({ name: 'SynchronousAssertFault' });
    builder.state({ name: 'trigger', type: types.number, initial: 0 });
    builder.state({ name: 'marker', type: types.number, initial: 0 });
    builder.state({ name: 'calls', type: types.number, initial: 0 });
    builder.reaction(
      {
        name: 'fail',
        sourcePath: ['trigger'],
        sourceType: types.number,
        previous: 'previousTrigger',
        current: 'currentTrigger',
        captures: [],
      },
      {},
      (body) => {
        body.writeState('marker', body.constant(types.number, 7));
        body.writeState(
          'calls',
          body.add(body.readState('calls', types.number), body.constant(types.number, 1)),
        );
        body.assert(body.constant(types.bool, false), (message) =>
          message.constant(types.string, 'synchronous boom'),
        );
      },
    );
    builder.start((body) => {
      body.writeState('trigger', body.constant(types.number, 1));
    });
    const library = createDeviceLibrary([
      { id: 'dut', model: builder.finish(), create: () => ({ sync() {}, dispose() {} }) },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [],
    });

    try {
      expect(() => board.runUntil(0)).toThrow(/synchronous boom/u);
      const [instance] = instances(board);
      expect(instance!.states.get('marker')).toBe(7);
      expect(instance!.states.get('calls')).toBe(1);
      expect(board.status).toBe('faulted');
      expect(() => board.runUntil(1)).toThrow(/faulted/u);
      expect(instance!.states.get('marker')).toBe(7);
      expect(instance!.states.get('calls')).toBe(1);
    } finally {
      board.dispose();
    }
  });

  it('propagates a memory-range failure after the prefix and never replays it', () => {
    const builder = createDeviceBuilder({ name: 'SynchronousMemoryFault' });
    builder.memory({ name: 'ram', length: 4 });
    builder.state({ name: 'trigger', type: types.number, initial: 0 });
    builder.state({ name: 'marker', type: types.number, initial: 0 });
    builder.state({ name: 'calls', type: types.number, initial: 0 });
    builder.reaction(
      {
        name: 'fail',
        sourcePath: ['trigger'],
        sourceType: types.number,
        previous: 'previousTrigger',
        current: 'currentTrigger',
        captures: [],
      },
      {},
      (body) => {
        body.writeState('marker', body.constant(types.number, 9));
        body.writeState(
          'calls',
          body.add(body.readState('calls', types.number), body.constant(types.number, 1)),
        );
        body.store8('ram', body.constant(types.number, 99), body.constant(types.number, 1));
      },
    );
    builder.start((body) => {
      body.writeState('trigger', body.constant(types.number, 1));
    });
    const library = createDeviceLibrary([
      { id: 'dut', model: builder.finish(), create: () => ({ sync() {}, dispose() {} }) },
    ]);
    const board = createBoard(library, {
      instances: [{ id: 'dut', type: 'dut' }],
      nets: [],
    });

    try {
      expect(() => board.runUntil(0)).toThrow(/Memory range is out of bounds/u);
      const [instance] = instances(board);
      expect(instance!.states.get('marker')).toBe(9);
      expect(instance!.states.get('calls')).toBe(1);
      expect(board.status).toBe('faulted');
      expect(() => board.runUntil(1)).toThrow(/faulted/u);
      expect(instance!.states.get('marker')).toBe(9);
      expect(instance!.states.get('calls')).toBe(1);
    } finally {
      board.dispose();
    }
  });
});
