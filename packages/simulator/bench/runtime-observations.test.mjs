import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import { types } from '../../device-model/dist/index.js';
import * as sdk from '../dist/index.js';

// Everything here runs through the public SDK only. The models observe published
// samples, reaction order, capture values and reported errors; no runtime internals
// are inspected. The checkpoint diagnostics opt-in and report use the symbol-keyed
// surfaces that the simulator already exposes for experiments.
const CHECKPOINT_EXPERIMENT = Symbol.for('mica-js.simulator/checkpoint-experiment');
const CHECKPOINTS = Symbol.for('mica-js.simulator/checkpoints');

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

// Each instruction writes one pin intent and then only advances time, so the compiler emits
// an inline empty suffix. Publication happens inside the prefix checkpoint; the second,
// empty-suffix checkpoint is the one the experiment skips when nothing is pending.
const checkpointModel = await compileDDL(`device Checkpoint {
  public memory code[4];
  pin supply;
  pin reference;
  pin drive(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];

  state pc: number = 0;
  state steps: number = 0;
  state hits: number = 0;
  state mirror: number = 0;
  output channel out: number(capacity: 512);

  derived high: bool = drive.sample.level == Logic.high;
  derived mirrorHigh: bool = mirror == 1;

  reaction lead on high as (previous, current) capture before = hits {
    hits = hits + 1;
    if current { mirror = 1; } else { mirror = 2; }
    out.send(100 + before);
  }
  reaction peer on high as (previous, current) capture before = hits {
    hits = hits + 1;
    out.send(200 + before);
  }
  reaction follow on mirrorHigh as (previous, current) {
    out.send(300 + (current ? 1 : 2));
  }

  process start {
    await ticks(100);
    out.send(999);
  }
}`);

function checkpointBoard() {
  const messages = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'checkpoint',
      model: checkpointModel,
      create(context) {
        const registration = context.attachJit({
          entry: 'checkpoint',
          code: 'code',
          pc: 'pc',
          translate: ({ pc }, block) => {
            block.instruction({ pc, nextPc: pc === 0 ? 1 : 0 }, (body) => {
              const one = body.constant(types.number, 1);
              body.writeState('steps', body.add(body.readState('steps', types.number), one));
              body.writeIntent(
                'drive',
                body.combineIntents(
                  body.resistor(
                    body.pin(pc === 0 ? 'supply' : 'reference'),
                    body.constant(types.number, 1000),
                  ),
                ),
              );
              body.elapse(body.constant(types.number, 10));
            });
            return block.finish();
          },
        });
        try {
          context.loadBytes('code', new Uint8Array(4));
        } catch (cause) {
          registration.dispose();
          throw cause;
        }
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? [])
              messages.push({ time: message.time, value: message.value });
          },
          dispose: () => registration.dispose(),
        };
      },
    },
  ]);
  const board = sdk.createBoard(library, {
    instances: [{ id: 'checkpoint', type: 'checkpoint' }],
    nets: [
      { id: 'supply', voltage: 3.3, pins: [{ instance: 'checkpoint', pin: 'supply' }] },
      { id: 'reference', voltage: 0, pins: [{ instance: 'checkpoint', pin: 'reference' }] },
      { id: 'drive', pins: [{ instance: 'checkpoint', pin: 'drive' }] },
    ],
  });
  return { board, messages };
}

function runCheckpoints(until, diagnostics = true) {
  const previous = Object.hasOwn(globalThis, CHECKPOINT_EXPERIMENT)
    ? globalThis[CHECKPOINT_EXPERIMENT]
    : undefined;
  if (diagnostics) globalThis[CHECKPOINT_EXPERIMENT] = { diagnostics: true };
  else delete globalThis[CHECKPOINT_EXPERIMENT];
  let board;
  let messages;
  try {
    ({ board, messages } = checkpointBoard());
  } finally {
    if (previous === undefined) delete globalThis[CHECKPOINT_EXPERIMENT];
    else globalThis[CHECKPOINT_EXPERIMENT] = previous;
  }
  try {
    board.runUntil(until);
    assert.equal(board.status, 'ready');
    return { messages: [...messages], time: board.time, report: board[CHECKPOINTS]() };
  } finally {
    board.dispose();
  }
}

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

function directCheckpointStats(result) {
  const [stats] = result.report.checkpoints;
  assert.ok(stats, 'the direct JIT exposed checkpoint counters');
  return stats;
}

test('checkpoint counters classify publication, finish and empty suffix', () => {
  const observed = runCheckpoints(90);
  const quiet = runCheckpoints(90, false);
  assert.deepEqual(quiet.messages, observed.messages, 'diagnostics do not change the event stream');
  assert.equal(quiet.time, observed.time);
  assert.equal(quiet.report.diagnostics, false);
  assert.equal(quiet.report.boundary.calls, 0);
  assert.equal(quiet.report.boundary.sources.checkpointPublish, 0);
  assert.deepEqual(quiet.report.checkpoints[0], {
    instance: 'checkpoint',
    publications: 0,
    finishes: 0,
    emptySuffixes: 0,
    boundaryCalls: 0,
    continues: 0,
    exits: 0,
  });

  const stats = directCheckpointStats(observed);
  assert.ok(stats.publications > 0);
  assert.ok(stats.finishes > 0);
  assert.ok(stats.emptySuffixes > 0, 'the workload exercises empty suffixes');
  assert.ok(stats.emptySuffixes <= stats.finishes);
  assert.equal(stats.boundaryCalls, stats.publications + stats.finishes);
  assert.equal(stats.continues + stats.exits, stats.boundaryCalls);
  // The first empty suffix lands on a successor whose route is still being assembled.
  assert.ok(stats.exits <= 1, `unexpected checkpoint exits ${stats.exits}`);
  assert.ok(stats.continues > 0);

  const boundary = observed.report.boundary;
  assert.equal(boundary.sources.checkpointPublish, stats.publications);
  assert.equal(boundary.sources.checkpointFinish, stats.finishes);
  assert.equal(
    Object.values(boundary.sources).reduce((sum, count) => sum + count, 0),
    boundary.calls,
  );
  assert.ok(boundary.publishes > 0);
  assert.ok(boundary.batches > 0);
  assert.ok(boundary.reactions > 0);
  assert.ok(boundary.captures > 0);
  assert.ok(boundary.empty > 0);
});

test('same-tick wake keeps capture order and feedback batches exact', () => {
  const result = runCheckpoints(250);
  assert.equal(result.time, 250);
  assert.deepEqual(
    result.messages.filter(({ value }) => value === 999),
    [{ time: 100, value: 999 }],
    'the process keeps its same-tick wake',
  );
  // Capture barrier: both `high` reactions read the same pre-boundary `hits`, and the
  // follow-up reaction on `mirror` runs after both bodies in the next observation batch.
  assert.deepEqual(
    result.messages.slice(0, 6).map(({ value }) => value),
    [100, 200, 301, 102, 202, 302],
  );
  const stats = directCheckpointStats(result);
  const boundary = result.report.boundary;
  assert.ok(stats.continues > 0);
  assert.equal(boundary.sources.checkpointPublish, stats.publications);
  assert.equal(boundary.sources.checkpointFinish, stats.finishes);
  assert.equal(
    Object.values(boundary.sources).reduce((sum, count) => sum + count, 0),
    boundary.calls,
  );
  assert.ok(boundary.sources.process > 0, 'process suspension and wake are attributed');
  assert.ok(
    boundary.sources.jitSignal > 0 || boundary.sources.runDirect > 0,
    'instruction suspension or direct checkpoint completion is attributed',
  );
  assert.ok(
    boundary.sources.runJit > 0 || boundary.sources.runDirect > 0,
    'instruction or direct completion is attributed',
  );
});
