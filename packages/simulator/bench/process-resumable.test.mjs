import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import * as sdk from '../dist/index.js';

// Every assertion here goes through the public SDK. The process probe is the same kind
// of read-only diagnostic the observation chains expose; models above it only observe
// published messages, memories and status.

const PROCESSES = Symbol.for('mica-js.simulator/processes');
const admission = (board) => {
  const report = board[PROCESSES]();
  return { resumable: report.resumable, generic: report.generic, bindings: report.bindings };
};
const engine = (report) => ({ resumable: report.resumable, generic: report.generic });

function create(model, { nets = [], options } = {}) {
  const messages = [];
  let context;
  let inputs;
  const library = sdk.createDeviceLibrary([
    {
      id: 'probe',
      model,
      create(instance) {
        context = instance;
        inputs = instance.inputs;
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? []) messages.push(message.value);
          },
          dispose() {},
        };
      },
    },
  ]);
  const description = { instances: [{ id: 'probe', type: 'probe' }], nets };
  return {
    board:
      options === undefined
        ? sdk.createBoard(library, description)
        : sdk.createBoard(library, description, options),
    messages,
    memory: (name) => context.memory[name],
    inputs: () => inputs,
  };
}

// Nested loops carry a suspension inside an inner `while`, a `continue` that skips it,
// a `match` with `break`, and locals (`row`, `column`, `index`, `total` is a state)
// that must survive every suspension.
const machineModel = await compileDDL(`device Machine {
  state total: number = 0;
  output channel out: number(capacity: 256);

  process start {
    let row = 0;
    while row < 2 {
      let column = 0;
      while column < 3 {
        column = column + 1;
        if column == 2 { continue; }
        total = total + 1;
        await ticks(1);
        out.send(total);
      }
      row = row + 1;
    }
    let index = 0;
    loop {
      index = index + 1;
      match index {
        1 => { out.send(101); }
        2 => { out.send(102); }
        _ => { out.send(103); break; }
      }
      await ticks(1);
    }
    out.send(9);
  }
}`);

// `before` is captured before the suspension; the post-suspension read must see the
// current state, not the value that was live when the fragment ended.
const localsModel = await compileDDL(`device Locals {
  state counter: number = 0;
  output channel out: number(capacity: 64);

  process start {
    let before = counter;
    counter = counter + 5;
    await ticks(1);
    out.send(before);
    out.send(counter);
    assert before == 0;
    assert counter == 5;
  }
}`);

// Call delegation is not part of this round's admission, so a body containing a call
// falls back whole and keeps running on the generator path with the same output.
const callModel = await compileDDL(`device Caller {
  state n: number = 0;
  output channel out: number(capacity: 64);

  fn poke() { n = n + 1; }

  process start {
    poke();
    await ticks(1);
    out.send(n);
  }
}`);

// Zero-length waits end the fragment and re-queue the process at the same instant.
const sameInstantModel = await compileDDL(`device Order {
  state ping: number = 0;
  output channel out: number(capacity: 64);

  derived tick: number = ping;

  process start { ping = 1; }

  process first on tick { await ticks(0); out.send(1); }
  process second on tick { await ticks(0); out.send(2); }
}`);

// The process re-arms its own source while running: the change is applied at the
// fragment boundary, so the second activation is pending rather than re-entrant.
const pendingModel = await compileDDL(`device Pending {
  state flag: bool = false;
  state passes: number = 0;
  output channel out: number(capacity: 64);

  derived observed: bool = flag;

  process start { flag = true; }

  process watch on observed {
    passes = passes + 1;
    out.send(passes);
    if passes < 2 { flag = !flag; }
    await ticks(1);
  }
}`);

// Received values and the local counter survive empty receives; a non-empty receive
// does not suspend.
const receiveModel = await compileDDL(`device Receiver {
  input channel inbox: number(capacity: 8);
  output channel out: number(capacity: 64);

  process start {
    let count = 0;
    loop {
      const value = await inbox.receive();
      count = count + 1;
      out.send(value + count);
      if count == 3 { break; }
    }
    out.send(99);
  }
}`);

// The public marker records the prefix that ran before the failing assertion.
const faultModel = await compileDDL(`device Faulty {
  public memory marker[4];

  process start {
    store8(marker, 0, 7);
    await ticks(1);
    store8(marker, 1, 9);
    assert false, "boom";
    store8(marker, 2, 11);
  }
}`);

// Endpoint handling: the wake at exactly `T` runs when the board reaches `T`, and
// repeating a finished endpoint does nothing.
const endpointModel = await compileDDL(`device Step {
  state n: number = 0;
  output channel out: number(capacity: 64);

  process start {
    n = n + 1;
    out.send(n);
    await ticks(2);
    n = n + 1;
    out.send(n);
  }
}`);

test('supported process bodies run as resumable blocks and calls fall back whole', () => {
  const machine = create(machineModel);
  const caller = create(callModel);
  try {
    machine.board.runUntil(20);
    assert.equal(machine.board.status, 'ready');
    assert.deepEqual(admission(machine.board).resumable, ['probe/start']);
    assert.deepEqual(admission(machine.board).generic, []);
    // Two rows of two counted pixels, then the match arms and the final marker.
    assert.deepEqual(machine.messages, [1, 2, 3, 4, 101, 102, 103, 9]);

    caller.board.runUntil(20);
    assert.equal(caller.board.status, 'ready');
    assert.deepEqual(admission(caller.board).generic, ['probe/start']);
    assert.deepEqual(admission(caller.board).resumable, []);
    assert.deepEqual(caller.messages, [1], 'the fallback path keeps its behaviour');
  } finally {
    machine.board.dispose();
    caller.board.dispose();
  }
});

test('locals keep pre-suspension values while reads see current state', () => {
  const { board, messages } = create(localsModel);
  try {
    board.runUntil(10);
    assert.equal(board.status, 'ready');
    assert.deepEqual(messages, [0, 5]);
    assert.deepEqual(admission(board).resumable, ['probe/start']);
  } finally {
    board.dispose();
  }
});

test('nested loops, continue, match and break stay exact under slicing', () => {
  const sliced = create(machineModel);
  const precise = create(machineModel, { options: { execution: 'precise' } });
  try {
    for (let target = 0; target <= 20; target++) sliced.board.runUntil(target);
    precise.board.runUntil(20);
    assert.equal(sliced.board.status, 'ready');
    assert.equal(precise.board.status, 'ready');
    assert.deepEqual(sliced.messages, [1, 2, 3, 4, 101, 102, 103, 9]);
    assert.deepEqual(precise.messages, sliced.messages);
  } finally {
    sliced.board.dispose();
    precise.board.dispose();
  }
});

test('zero-length waits re-queue in declaration order at the same instant', () => {
  const { board, messages } = create(sameInstantModel);
  try {
    board.runUntil(0);
    assert.equal(board.status, 'ready');
    assert.deepEqual(messages, [1, 2]);
    assert.deepEqual(admission(board).resumable, ['probe/start', 'probe/first', 'probe/second']);
    board.runUntil(0);
    assert.deepEqual(messages, [1, 2], 'a finished instant does not re-run');
  } finally {
    board.dispose();
  }
});

test('a process that re-arms its own source is pending, not re-entrant', () => {
  const { board, messages } = create(pendingModel);
  try {
    board.runUntil(10);
    assert.equal(board.status, 'ready');
    assert.deepEqual(messages, [1, 2]);
    const report = admission(board);
    assert.deepEqual(report.generic, []);
    assert.deepEqual(report.resumable, ['probe/start', 'probe/watch']);
  } finally {
    board.dispose();
  }
});

test('receive keeps locals across batches and takes queued input without suspending', () => {
  const { board, messages, inputs } = create(receiveModel);
  try {
    board.runUntil(1);
    assert.equal(board.status, 'ready');
    assert.deepEqual(messages, [], 'an empty receive suspends');
    inputs().inbox.send(10);
    board.runUntil(2);
    assert.deepEqual(messages, [11]);
    inputs().inbox.send(20);
    inputs().inbox.send(30);
    board.runUntil(3);
    assert.deepEqual(messages, [11, 22, 33, 99], 'the queued message resumes without a batch');
  } finally {
    board.dispose();
  }
});

test('a failing body keeps its executed prefix and stops the suffix', () => {
  const { board, memory } = create(faultModel);
  try {
    assert.throws(
      () => board.runUntil(10),
      (error) => {
        assert.equal(board.status, 'faulted');
        assert.match(String(error.message), /boom/);
        return true;
      },
    );
    const marker = memory('marker');
    assert.equal(marker[0], 7, 'the prefix write survives the fault');
    assert.equal(marker[1], 9, 'the write before the assertion survives');
    assert.equal(marker[2], 0, 'the suffix after the assertion never ran');
    assert.throws(() => board.runUntil(11), { code: 'BOARD_FAULTED' });
  } finally {
    board.dispose();
  }
});

test('a wake exactly on the endpoint runs once and repeats stably', () => {
  const { board, messages } = create(endpointModel);
  try {
    board.runUntil(0);
    assert.deepEqual(messages, [1]);
    board.runUntil(0);
    assert.deepEqual(messages, [1], 'the same endpoint does not repeat work');
    board.runUntil(2);
    assert.deepEqual(messages, [1, 2]);
    board.runUntil(2);
    assert.deepEqual(messages, [1, 2], 'the wake is not replayed at the same endpoint');
    board.runUntil(3);
    assert.deepEqual(messages, [1, 2], 'nothing is left to run');
  } finally {
    board.dispose();
  }
});

// One model combines nested loops with a `continue`, a bytes and a number local that
// both cross a suspension, a second process that mutates the state the reader observes,
// and a reaction capture. Its isomorphic twin only adds a side-effect-free call, which
// keeps the whole `start` body on the generator path; messages, simulated time and
// public RAM must stay identical either way.
function combinedModel(waitPs, call) {
  return `device Combined {
  state shared: number = 0;
  state passes: number = 0;
  public memory ram[8];
  public memory tail[8];
  output channel out: number(capacity: 256);

  derived snap: number = shared;

  reaction onSnap on snap as (previous, current) capture seen = shared {
    out.send(1000 + seen);
  }
  ${call ? 'fn noOp() { }' : ''}

  process start {${call ? ' noOp();' : ''}
    store8(ram, 0, 7);
    store8(ram, 1, 8);
    let row = 0;
    while row < 2 {
      let column = 0;
      while column < 2 {
        column = column + 1;
        if column == 2 { continue; }
        const shot = copyBytes(ram, 0, 4);
        const scalar = shared;
        shared = shared + 1;
        await ticks(${waitPs});
        assert shot == copyBytes(ram, 0, 4), "snapshot bytes changed";
        out.send(scalar);
        out.send(shared);
        out.send(shot.length);
      }
      row = row + 1;
    }
    store8(tail, 0, 1);
    store8(tail, 1, 2);
  }

  process bump on snap {
    passes = passes + 1;
    store32le(tail, 4, passes);
    if passes < 3 { shared = shared + 10; }
  }
}`;
}

const combinedVariants = await Promise.all(
  [0, 1, 2, 0, 1, 2].map(async (waitPs, seed) => ({
    waitPs,
    seed,
    admitted: await compileDDL(combinedModel(waitPs, false)),
    fallback: await compileDDL(combinedModel(waitPs, true)),
  })),
);

test('a seeded combined model equals its whole-body fallback twin', () => {
  for (const variant of combinedVariants) {
    const label = `waits ${variant.waitPs} ps, seed ${variant.seed}`;
    const fast = create(variant.admitted, { options: { seed: variant.seed } });
    const slow = create(variant.fallback, { options: { seed: variant.seed } });
    try {
      fast.board.runUntil(50);
      slow.board.runUntil(50);
      assert.equal(fast.board.status, 'ready', label);
      assert.equal(slow.board.status, 'ready', label);
      assert.deepEqual(
        engine(admission(fast.board)),
        { resumable: ['probe/start', 'probe/bump'], generic: [] },
        label,
      );
      assert.deepEqual(
        engine(admission(slow.board)),
        { resumable: ['probe/bump'], generic: ['probe/start'] },
        label,
      );
      assert.deepEqual(fast.messages, slow.messages, label);
      assert.deepEqual([...fast.memory('ram')], [...slow.memory('ram')], label);
      assert.deepEqual([...fast.memory('tail')], [...slow.memory('tail')], label);
      assert.equal(fast.board.time, slow.board.time, label);
      assert.equal(slow.board.time, 50, label);
      assert.ok(fast.messages.length > 0, label);
      assert.ok(
        fast.messages.some((value) => value >= 1000),
        `${label}: the captured reaction fired`,
      );
    } finally {
      fast.board.dispose();
      slow.board.dispose();
    }
  }
});
