import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import * as sdk from '../dist/index.js';

// Everything here runs through the public SDK only. The models observe published
// samples, reaction order, capture values and reported errors; no runtime internals
// are inspected.

// A derived source whose dependency branch follows `sel`: while `sel` is high the
// derived reads only `a`, otherwise only `b`. Two reactions share `active`, and a
// nested derived `either` depends on both `active` and `both`. Each cycle switches the
// branch and then writes the branch that is no longer read, so a stale subscription or
// a botched dependency diff changes the published event sequence.
const observationModel = await compileDDL(`device Probe {
  pin supply;
  pin reference;
  pin sel(low: 0.8, high: 2.0);
  pin a(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  pin b(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];

  state hits: number = 0;
  output channel out: number(capacity: 4096);

  pure fn aLevel() -> bool { return a.sample.level == Logic.high; }
  pure fn bLevel() -> bool { return b.sample.level == Logic.high; }
  pure fn activeLevel() -> bool {
    if sel.sample.level == Logic.high {
      return a.sample.level == Logic.high;
    }
    return b.sample.level == Logic.high;
  }

  derived aHigh: bool = aLevel();
  derived bHigh: bool = bLevel();
  derived both: bool = aHigh && bHigh;
  derived active: bool = activeLevel();
  derived either: bool = active || both;

  reaction onActive on active as (previous, current) {
    hits = hits + 1;
    out.send(1);
  }
  reaction onActivePeer on active as (previous, current) capture before = hits {
    assert before == hits - 1;
    out.send(2);
  }
  reaction onEither on either as (previous, current) {
    out.send(3);
  }

  process start {
    let cycle = 0;
    while cycle < 4 {
      sel.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      a.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      a.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      sel.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      a.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      a.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      b.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      b.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      cycle = cycle + 1;
    }
  }
}`);

// Every instance repeats the same immutable intent three times, churns past the
// Per-pin resistance cache with distinct resistances (more than its per-name bound), then
// returns to values that were used before the cache was cleared. Each instance owns its
// pins, so a shared construction
// cache or a stale sample would change the observed transitions.
const intentModel = await compileDDL(`device Stable(label: string default "") {
  pin supply;
  pin reference;
  pin load(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  output channel out: number(capacity: 4096);

  pure fn loadLevel() -> bool { return load.sample.level == Logic.high; }
  derived high: bool = loadLevel();
  reaction onChange on high as (previous, current) {
    if current { out.send(1); } else { out.send(0); }
  }

  process start {
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    let index = 0;
    while index < 520 {
      load.intent <- [resistor(to: supply, resistance: 1000 + index)];
      await ticks(1);
      index = index + 1;
    }
    load.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
  }
}`);

const faultModels = await Promise.all(
  [false, true].map((churn) =>
    compileDDL(`device Faulty(label: string default "") {
  pin supply;
  pin reference;
  pin load(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  process start {
    ${
      churn
        ? `let index = 0;
    while index < 520 {
      load.intent <- [resistor(to: supply, resistance: 1000 + index)];
      await ticks(1);
      index = index + 1;
    }
    `
        : ''
    }load.intent <- [resistor(to: supply, resistance: 0.0005)];
    await ticks(1);
  }
}`),
  ),
);

function observationBoard() {
  const messages = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'probe',
      model: observationModel,
      create() {
        return {
          sync(batch) {
            for (const message of batch.outputs.out) messages.push(message.value);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = sdk.createBoard(library, {
    instances: [{ id: 'probe', type: 'probe' }],
    nets: [
      { id: 'supply', voltage: 3.3, pins: [{ instance: 'probe', pin: 'supply' }] },
      { id: 'reference', voltage: 0, pins: [{ instance: 'probe', pin: 'reference' }] },
      { id: 'sel', pins: [{ instance: 'probe', pin: 'sel' }] },
      { id: 'a', pins: [{ instance: 'probe', pin: 'a' }] },
      { id: 'b', pins: [{ instance: 'probe', pin: 'b' }] },
    ],
  });
  return { board, messages };
}

function intentBoard(model) {
  const messages = { left: [], right: [] };
  const library = sdk.createDeviceLibrary([
    {
      id: 'stable',
      model,
      create(context) {
        const log = messages[context.props.label];
        return {
          sync(batch) {
            for (const message of batch.outputs.out) log.push(message.value);
          },
          dispose() {},
        };
      },
    },
  ]);
  const instances = ['left', 'right'].map((id) => ({ id, type: 'stable', props: { label: id } }));
  const board = sdk.createBoard(library, {
    instances,
    nets: [
      {
        id: 'supply',
        voltage: 3.3,
        pins: instances.map(({ id }) => ({ instance: id, pin: 'supply' })),
      },
      {
        id: 'reference',
        voltage: 0,
        pins: instances.map(({ id }) => ({ instance: id, pin: 'reference' })),
      },
      ...instances.map(({ id }) => ({ id: `${id}-load`, pins: [{ instance: id, pin: 'load' }] })),
    ],
  });
  return { board, messages };
}

test('derived sources rebind dependencies across alternating branches', () => {
  const { board, messages } = observationBoard();
  try {
    board.runUntil(1_000_000);
    assert.equal(board.status, 'ready');
    // Per cycle: switching `sel` keeps `active` false and must not fire; the branch that
    // is still read fires twice; the abandoned branch is written twice without firing.
    // Both `active` observers report in declaration order, then the nested `either`.
    assert.deepEqual(messages, Array.from({ length: 8 }, () => [1, 2, 3]).flat());

    // The observed sources run through generated readers: one chain serves both
    // `active` receivers, and its static dependency set covers every branch.
    const compiled = board[Symbol.for('mica-js.simulator/observations')]();
    const active = compiled.plans.find((entry) => entry.path[0] === 'active');
    const either = compiled.plans.find((entry) => entry.path[0] === 'either');
    assert.equal(active?.receivers, 2, 'both reactions share one generated chain');
    assert.equal(active?.slots, 3, 'both branches stay subscribed');
    assert.match(active.source, /\.sample/, 'samples are read through bound pins');
    assert.doesNotMatch(active.source, /host\.read\(/, 'no generic name-based reads');
    assert.equal(either?.receivers, 1);
    assert.deepEqual(compiled.skipped, []);
  } finally {
    board.dispose();
  }
});

test('immutable intent reuse stays exact across repeats, instances and eviction', () => {
  const { board, messages } = intentBoard(intentModel);
  try {
    board.runUntil(1_000_000);
    assert.equal(board.status, 'ready');
    // Repeated identical assignments produce no extra transitions, and values reused
    // after the per-pin cache was cleared still publish the same boundaries.
    assert.deepEqual(messages.left, [1, 0, 1]);
    assert.deepEqual(messages.right, [1, 0, 1], 'each instance drives only its own pins');
  } finally {
    board.dispose();
  }
});

test('invalid resistances report the documented error before and after eviction', () => {
  const messages = [];
  for (const model of faultModels) {
    const { board } = intentBoard(model);
    try {
      assert.throws(
        () => board.runUntil(1_000_000),
        (error) => {
          assert.equal(error.code, 'INVALID_ELECTRICAL_PARAMETER');
          assert.match(error.message, /Resistance outside/);
          messages.push(error.message);
          return true;
        },
      );
      assert.equal(board.status, 'faulted');
      assert.throws(() => board.runUntil(1_000_001), { code: 'BOARD_FAULTED' });
    } finally {
      board.dispose();
    }
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1], 'eviction does not change parameter diagnostics');
});
