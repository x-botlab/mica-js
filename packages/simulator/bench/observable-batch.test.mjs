import assert from 'node:assert/strict';
import test from 'node:test';
import * as model from '@mica-js/device-model';
import * as simulator from '../dist/index.js';
import { withCheckpointDiagnostics } from './batch-execution-fixture.mjs';
import { CHECKPOINTS, fixture, PIXEL, STEP } from './observable-batch-fixture.mjs';

function compare(kind, targets, options) {
  return withCheckpointDiagnostics(() => {
    const workload = fixture(simulator, model, kind, options);
    const slow = workload.create(false);
    const fast = workload.create(true);
    try {
      const snapshots = new Map();
      for (const at of targets) {
        slow.board.runUntil(at);
        fast.board.runUntil(at);
        const actual = fast.snapshot();
        assert.deepEqual(actual, slow.snapshot(), `Difference at ${at} ps`);
        snapshots.set(at, actual);
      }
      return { snapshots, stats: fast.board[CHECKPOINTS]().batchExecution };
    } finally {
      slow.board.dispose();
      fast.board.dispose();
    }
  });
}

function messages(snapshots, name) {
  return [...snapshots.values()].flatMap(({ outputs }) =>
    outputs.flatMap(({ outputs }) => outputs[name] ?? []),
  );
}

test('LCD RGB565 batches preserve strobe order and code-generation changes', () => {
  for (const mutateAt of [39, 40, 41]) {
    const { snapshots, stats } = compare('Lcd', [39, 40, 41, 99, 159, 160, 161], { mutateAt });
    assert.ok(stats.jit.registered >= 2);
    assert.ok(stats.jit.committed > 0);
    assert.equal(stats.jit.admitted, stats.jit.executed);
    assert.equal(stats.jit.committed, stats.jit.published);
    const edges = messages(snapshots, 'edges');
    assert.deepEqual(
      edges,
      Array.from({ length: 16 }, (_, i) => [
        { time: i * STEP, value: false },
        { time: i * STEP, value: true },
      ]).flat(),
    );
    const final = snapshots.get(161);
    assert.equal(final.states.cursor, 32);
    assert.equal(final.states.dirtyLast, 30);
    assert.equal(final.states.strobe, true);
    assert.deepEqual(messages(snapshots, 'frame'), [{ time: 160 }]);
    assert.equal(final.bytes.pixels[9], (PIXEL & 0xff) + (mutateAt <= 40 ? 1 : 0));
    assert.deepEqual(snapshots.get(40).bytes.pixels.slice(8), Array(24).fill(0));
  }
});

test('LCD keeps per-item writebacks when an observer watches the dirty region', () => {
  const { snapshots, stats } = compare('Lcd', [159, 160, 161], { observe: true });
  assert.deepEqual(
    messages(snapshots, 'observed'),
    Array.from({ length: 16 }, (_, i) => ({
      time: i * STEP,
      value: i * 2,
    })),
  );
  assert.equal(stats.jit.committed, 0);
  assert.ok(stats.jit.declines.observed > 0);
});

test('LCD shortens batches to fit the channel and leaves overflow to the original path', () => {
  const { snapshots, stats } = compare('Lcd', [161], { edgeCapacity: 5 });
  assert.equal(stats.jit.committed, 1);
  assert.ok(stats.jit.declines.capacity > 0);
  assert.deepEqual(messages(snapshots, 'edges'), [
    { time: 0, value: false },
    { time: 0, value: true },
    { time: 10, value: false },
    { time: 10, value: true },
    { time: 20, value: false },
  ]);
});

test('a cursor-valued output preserves negative zero on the first round', () => {
  const { snapshots, stats } = compare('Lcd', [161], {
    initialCursor: -0,
    reportAddress: true,
  });
  assert.ok(Object.is(messages(snapshots, 'address')[0].value, -0));
  assert.ok(stats.jit.committed > 0);
});

test('DMA bounds each batch by source rewrites, other JITs, half-transfer and completion', () => {
  for (const mutateAt of [39, 40, 41]) {
    const targets = [39, 40, 41, 49, 50, 51, 79, 80, 81, 169, 170, 171];
    const { snapshots, stats } = compare('Dma', targets, { mutateAt, competitorAt: 50 });
    assert.ok(stats.process.committed > 0);
    assert.equal(stats.process.committed, stats.process.published);
    const at40 = snapshots.get(40);
    assert.equal(at40.bytes.dst[8], mutateAt <= 40 ? 0x6a : 0x11);
    assert.equal(at40.states.cursor, 10);
    for (const snapshot of snapshots.values()) {
      const { cursor, remaining, srcAddress, dstAddress } = snapshot.states;
      assert.equal(remaining, 32 - cursor);
      assert.equal(srcAddress, 1000 + cursor);
      assert.equal(dstAddress, 2000 + cursor);
      assert.deepEqual(snapshot.bytes.dst.slice(cursor), Array(32 - cursor).fill(0));
      assert.equal(snapshot.bytes.src[8], snapshot.time >= mutateAt ? 0x6a : 0x11);
    }
    assert.deepEqual(messages(snapshots, 'other'), [{ time: 50, value: 1 }]);
    assert.deepEqual(messages(snapshots, 'counts'), [
      { time: 80, value: 16 },
      { time: 170, value: 0 },
    ]);
    assert.deepEqual(messages(snapshots, 'half'), [{ time: 80 }]);
    assert.deepEqual(messages(snapshots, 'complete'), [{ time: 170 }]);
    assert.equal(snapshots.get(80).states.flags, 1);
    assert.equal(snapshots.get(80).states.pc, 0);
    assert.equal(snapshots.get(80).states.stacked, -1);
    assert.equal(snapshots.get(170).states.flags, 2);
    assert.deepEqual(messages(snapshots, 'irqEntry'), [
      { time: 80, value: 2 },
      { time: 170, value: 2 },
    ]);
  }
});

test('a three-block parked prefix follows ordinary instruction and IRQ cuts', () => {
  for (const mutateAt of [4, 5, 6, 9, 10, 11]) {
    const { snapshots } = compare('Parking', [4, 5, 6, 9, 10, 11, 14, 15, 16], {
      mutateAt,
      competitorAt: 5,
    });
    assert.equal(snapshots.get(5).states.pc, 2);
    assert.equal(snapshots.get(5).states.clockRead, -1);
    const trace = messages(snapshots, 'trace');
    assert.deepEqual(trace.at(-1), {
      time: mutateAt <= 5 ? 5 : mutateAt <= 10 ? 10 : 15,
      value: mutateAt <= 5 ? 2 : mutateAt <= 10 ? 4 : 0,
    });
  }
});

test('read-only cuts retain the reservation and invalidated code resumes after the old prefix', () => {
  const targets = [4, 5, 6, 9, 10, 11, 14, 15, 16, 20, 21, 29, 30, 31];
  const stable = compare('Parking', targets);
  assert.deepEqual(
    messages(stable.snapshots, 'trace'),
    Array.from({ length: 3 }, (_, round) => [
      { time: round * 15, value: 1 },
      { time: round * 15 + 5, value: 0x12345678 },
      { time: round * 15 + 10, value: 3 },
    ])
      .flat()
      .slice(0, 7),
  );

  const changed = compare('Parking', targets, { mutateAt: 6, mutation: 'code' });
  assert.deepEqual(messages(changed.snapshots, 'trace').slice(0, 4), [
    { time: 0, value: 1 },
    { time: 5, value: 0x12345678 },
    { time: 6, value: 0x12345678 },
    { time: 10, value: 33 },
  ]);
});

test('service queues once at its deadline and starts on the next eligible JIT turn', () => {
  for (const mutateAt of [undefined, 14]) {
    const workload = fixture(simulator, model, 'Parking', { reportService: true, mutateAt });
    const { board, snapshot } = workload.create(true);
    try {
      board.runUntil(4);
      const reservation = board.instances[0].jits[0].pollingReservation;
      assert.ok(reservation);
      snapshot();
      board.runUntil(5);
      assert.equal(board.instances[0].jits[0].pollingReservation, reservation);
      board.runUntil(15);
      const due = snapshot();
      assert.equal(due.states.pc, mutateAt === undefined ? 7 : 0);
      assert.deepEqual(
        due.outputs.at(-1).outputs.queuedService,
        mutateAt === undefined ? [{ time: 15, value: 15 }] : [],
      );
      assert.deepEqual(due.outputs.at(-1).outputs.startedService, []);
      board.runUntil(16);
      const dispatched = snapshot().outputs.at(-1).outputs;
      assert.deepEqual(
        dispatched.startedService,
        mutateAt === undefined ? [{ time: 15, value: 7 }] : [],
      );
      if (mutateAt !== undefined) assert.deepEqual(dispatched.trace, [{ time: 15, value: 0 }]);
      board.runUntil(31);
      assert.deepEqual(snapshot().outputs.at(-1).outputs.queuedService, []);
    } finally {
      board.dispose();
    }
  }
});

test('recreating a board drops the old timed prefix and starts at time zero', () => {
  const workload = fixture(simulator, model, 'Parking');
  const first = workload.create(true);
  first.board.runUntil(6);
  assert.equal(first.snapshot().states.clockRead, 0x12345678);
  first.board.dispose();
  const rebuilt = workload.create(true);
  try {
    rebuilt.board.runUntil(5);
    assert.equal(rebuilt.snapshot().states.clockRead, -1);
    rebuilt.board.runUntil(6);
    assert.equal(rebuilt.snapshot().states.clockRead, 0x12345678);
  } finally {
    rebuilt.board.dispose();
  }
});
