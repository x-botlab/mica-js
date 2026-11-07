import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import * as sdk from '../dist/index.js';

// The diagnostic symbol is how the generated observation chains report what they
// compiled. It is deliberately not part of the public SDK: models and oracles above
// still observe only published behaviour.
const OBSERVATIONS = Symbol.for('mica-js.simulator/observations');
const report = (board) => board[OBSERVATIONS]();
const plan = (board, path) => report(board).plans.find((entry) => entry.path.join('.') === path);

function create(model, { nets = [], options } = {}) {
  const messages = [];
  let memory;
  const library = sdk.createDeviceLibrary([
    {
      id: 'probe',
      model,
      create(context) {
        memory = context.memory;
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
    memory: () => memory,
  };
}

// One derived of each generated comparison shape, plus a second receiver on the first
// source. The second receiver sits after sources that belong to other chains, so the
// collapsed chain has to keep the original declaration order when it activates both.
const comparisonModel = await compileDDL(`device Compare {
  state x: number = 0;
  public memory data[4];
  output channel out: number(capacity: 64);

  record Pair {
    n: number;
    flag: bool;
  }

  derived nano: number = x == 0 ? NaN : (x == 1 ? 0 : (x == 2 ? -0 : (x == 4 ? NaN : 1)));
  derived rec: Pair = { n: x, flag: x > 0 };
  derived raw: bytes = copyBytes(data, 0, 2);

  reaction onNano on nano as (previous, current) { out.send(1); }
  reaction onRec on rec as (previous, current) { out.send(2); }
  reaction onRaw on raw as (previous, current) { out.send(3); }
  reaction onNanoPeer on nano as (previous, current) { out.send(4); }

  process start {
    x = 1;
    await ticks(1);
    x = 2;
    await ticks(1);
    store8(data, 0, 1);
    x = 3;
    await ticks(1);
    store8(data, 0, 1);
    x = 4;
    await ticks(1);
    store8(data, 1, 1);
    x = 5;
    await ticks(1);
    x = 1;
    await ticks(1);
  }
}`);

const generatedLevel = await compileDDL(`device Generated {
  pin supply;
  pin reference;
  pin load(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  output channel out: number(capacity: 64);
  derived high: bool = load.sample.level == Logic.high;
  reaction onChange on high as (previous, current) { out.send(current ? 1 : 0); }
  process start {
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
  }
}`);

// A pure function that reads through a resource parameter is legal in the language but
// outside the generated reader, so this source must keep the generic path.
const fallbackLevel = await compileDDL(`device Fallback {
  pin supply;
  pin reference;
  pin load(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  output channel out: number(capacity: 64);
  pure fn isHigh(target: pin) -> bool { return target.sample.level == Logic.high; }
  derived high: bool = isHigh(load);
  reaction onChange on high as (previous, current) { out.send(current ? 1 : 0); }
  process start {
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(1);
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
  }
}`);

const guardedModel = await compileDDL(`device Guarded {
  public memory marker[2];
  state x: number = 0;
  output channel out: number(capacity: 4);

  pure fn checked() -> bool {
    assert x < 2, "x too large";
    return x > 0;
  }
  derived guard: bool = checked();

  reaction onGuard on guard as (previous, current) { store8(marker, 1, 1); }

  process start {
    store8(marker, 0, 1);
    x = 1;
    await ticks(1);
    x = 2;
    await ticks(1);
  }
}`);

const guardedBaselineModel = await compileDDL(`device GuardedBaseline {
  public memory marker[2];
  state x: number = 3;
  output channel out: number(capacity: 4);
  pure fn checked() -> bool {
    assert x < 2, "x too large";
    return x > 0;
  }
  derived guard: bool = checked();
  reaction onGuard on guard as (previous, current) { store8(marker, 1, 1); }
  process start { store8(marker, 0, 1); }
}`);

const shapesModel = await compileDDL(`device Shapes {
  state x: number = 0;
  output channel out: number(capacity: 64);

  pure fn classify() -> number {
    match x {
      0 => { return NaN; }
      1 => { return 0; }
      2 => { return -0; }
      _ => { return 1; }
    }
  }
  pure fn counted() -> number {
    let total: number = 0;
    let index: number = 0;
    while index < x {
      total = total + 1;
      index = index + 1;
    }
    return total;
  }
  derived shape: number = classify();
  derived steps: number = counted();

  reaction onShape on shape as (previous, current) { out.send(1); }
  reaction onSteps on steps as (previous, current) { out.send(2); }

  process start {
    x = 1;
    await ticks(1);
    x = 2;
    await ticks(1);
    x = 3;
    await ticks(1);
  }
}`);

// A record source observed as a whole and through two of its fields. The changes to
// `z` are outside the record, and the record itself has no `z` field, so nothing may
// fire for them. Field receivers must see scalar previous/current values.
const projectionModel = await compileDDL(`device Projection {
  state x: number = 0;
  state y: number = 0;
  state z: number = 0;
  output channel out: number(capacity: 64);

  record Pair {
    x: number;
    y: number;
  }
  derived pair: Pair = { x: x, y: y };
  derived offset: number = x + y;

  reaction onPair on pair as (previous, current) { out.send(1); }
  reaction onPairX on pair.x as (previous, current) { out.send(previous * 100 + current); }
  reaction onPairY on pair.y as (previous, current) { out.send(1000 + current); }
  reaction onOffset on offset as (previous, current) { out.send(2000 + current); }

  process start {
    z = 5;
    await ticks(1);
    y = 1;
    await ticks(1);
    x = 2;
    await ticks(1);
    z = 6;
    await ticks(1);
    x = 3;
    await ticks(1);
  }
}`);

// A sample-typed derived observed through one field, and an optional number source.
const fieldModel = await compileDDL(`device Fields {
  pin supply;
  pin reference;
  pin load(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  state level: number = 0;
  output channel out: number(capacity: 64);

  derived sampleValue: sample = load.sample;
  derived maybe: number? = level == 0 ? none : level;

  reaction onLevel on sampleValue.level as (previous, current) {
    out.send(current == Logic.high ? 1 : 0);
  }
  reaction onMaybe on maybe as (previous, current) {
    out.send(current == none ? 0 : current);
  }

  process start {
    load.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    level = 4;
    await ticks(1);
    load.intent <- [resistor(to: reference, resistance: 1000)];
    level = 0;
    await ticks(1);
  }
}`);

// Memory-derived sources: byte load at a dynamic index, both 16-bit endiannesses at a
// fixed offset, and a bytes snapshot. Every store must reach the chain through the
// memory resource slot.
const memoryModel = await compileDDL(`device MemoryRead {
  public memory data[4];
  state index: number = 0;
  output channel out: number(capacity: 64);

  derived cell: number = load8(data, index);
  derived little: number = load16le(data, 0);
  derived big: number = load16be(data, 0);
  derived chunk: bytes = copyBytes(data, 0, 2);

  reaction onCell on cell as (previous, current) { out.send(100 + current); }
  reaction onLittle on little as (previous, current) { out.send(200 + current); }
  reaction onBig on big as (previous, current) { out.send(300 + current); }
  reaction onChunk on chunk as (previous, current) { out.send(400); }

  process start {
    store8(data, 0, 1);
    await ticks(1);
    store8(data, 1, 2);
    await ticks(1);
    index = 1;
    await ticks(1);
    store8(data, 1, 3);
    await ticks(1);
  }
}`);

// A range failure has to keep the documented model error even when the read happens in
// a generated chain, after earlier published transitions.
const boundsModel = await compileDDL(`device Bounds {
  public memory data[4];
  public memory marker[1];
  state index: number = 0;
  output channel out: number(capacity: 8);

  derived wide: number = load16le(data, index);
  reaction onWide on wide as (previous, current) { out.send(1); }

  process start {
    store8(marker, 0, 1);
    store8(data, 3, 1);
    index = 3;
    await ticks(1);
  }
}`);

// Exact regression for a record source observed through one field: the reader must
// project the field and compare a number, not publish the record as the current value.
const projectedRepro = await compileDDL(`device Projected {
  state x: number = 0;
  state y: number = 0;
  output channel out: number(capacity: 8);
  record Pair {
    x: number;
    y: number;
  }
  derived pair: Pair = { x: x, y: y };
  reaction onX on pair.x as (previous, current) { out.send(current); }
  process start {
    y = 1;
    await ticks(1);
    x = 2;
    await ticks(1);
  }
}`);

function loadNet() {
  return {
    nets: [
      { id: 'supply', voltage: 3.3, pins: [{ instance: 'probe', pin: 'supply' }] },
      { id: 'reference', voltage: 0, pins: [{ instance: 'probe', pin: 'reference' }] },
      { id: 'load', pins: [{ instance: 'probe', pin: 'load' }] },
    ],
  };
}

test('generated readers and comparators drive every derived source of a model', () => {
  const bench = create(comparisonModel);
  try {
    bench.board.runUntil(100);
    assert.equal(bench.board.status, 'ready');
    // nano keeps NaN equal and treats 0 and -0 as equal; rec and raw compare content.
    assert.deepEqual(bench.messages, [1, 2, 4, 2, 1, 2, 3, 4, 1, 2, 4, 1, 2, 3, 4, 1, 2, 4]);

    const nano = plan(bench.board, 'nano');
    const rec = plan(bench.board, 'rec');
    const raw = plan(bench.board, 'raw');
    assert.ok(nano && rec && raw, 'every observed derived node is generated');
    assert.equal(nano.receivers, 2, 'both reaction receivers share one generated chain');
    assert.equal(rec.receivers, 1);
    assert.equal(raw.receivers, 1);
    assert.equal(nano.slots, 1);
    assert.match(nano.comparison, /a !== a && b !== b/, 'number comparison keeps NaN equal');
    assert.match(rec.comparison, /\["n"\]/, 'record comparison is field recursive');
    assert.match(raw.comparison, /sameBytes/, 'bytes comparison is length and content');
    for (const entry of [nano, rec, raw]) {
      assert.match(entry.source, /^function \(\) \{/, 'generated reader is a bound function');
      assert.doesNotMatch(entry.source, /host\.read\(/, 'no generic name-based reads');
      assert.doesNotMatch(entry.source, /\.sample/, 'no source of this model reads a pin');
    }
    assert.match(rec.source, /\.get\(/, 'record source reads the bound state map');
  } finally {
    bench.board.dispose();
  }
});

test('generated readers keep loop and match arms of pure functions', () => {
  const bench = create(shapesModel);
  try {
    bench.board.runUntil(100);
    assert.equal(bench.board.status, 'ready');
    assert.deepEqual(bench.messages, [1, 2, 2, 1, 2]);
    assert.ok(plan(bench.board, 'shape'));
    assert.ok(plan(bench.board, 'steps'));
    assert.match(plan(bench.board, 'shape').source, /else if/);
    assert.match(plan(bench.board, 'steps').source, /while \(true\)/);
    assert.deepEqual(report(bench.board).skipped, []);
  } finally {
    bench.board.dispose();
  }
});

test('a record field source publishes the projected scalar, not the record', () => {
  const bench = create(projectedRepro);
  try {
    bench.board.runUntil(10);
    assert.equal(bench.board.status, 'ready');
    assert.deepEqual(bench.messages, [2]);
    const fieldX = plan(bench.board, 'pair.x');
    assert.ok(fieldX);
    assert.match(fieldX.comparison, /a !== a && b !== b/);
    assert.match(fieldX.source, /return projected;/);
    assert.doesNotMatch(fieldX.source, /return d0\(\);/, 'not the unprojected root value');
  } finally {
    bench.board.dispose();
  }
});

test('field projections keep scalar previous/current and ignore unreferenced fields', () => {
  const bench = create(projectionModel);
  try {
    bench.board.runUntil(100);
    assert.equal(bench.board.status, 'ready');
    // z is not part of the record and not read by offset, so its changes never fire.
    assert.deepEqual(bench.messages, [1, 1001, 2001, 1, 2, 2003, 1, 203, 2004]);

    const root = plan(bench.board, 'pair');
    const fieldX = plan(bench.board, 'pair.x');
    const fieldY = plan(bench.board, 'pair.y');
    const offset = plan(bench.board, 'offset');
    for (const entry of [root, fieldX, fieldY, offset]) assert.ok(entry);
    assert.match(root.comparison, /\["x"\]/, 'record fields are bracketed, never spliced');
    assert.match(root.comparison, /\["y"\]/);
    assert.match(fieldX.comparison, /a !== a && b !== b/, 'projected field uses number compare');
    assert.match(fieldX.source, /projected\[B\[/, 'the reader projects the suffix field');
    assert.equal(fieldY.receivers, 1);
    assert.equal(report(bench.board).skipped.length, 0);
  } finally {
    bench.board.dispose();
  }
});

test('projected sources stay identical in precise mode and under host slicing', () => {
  const sliced = create(projectionModel);
  const precise = create(projectionModel, { options: { execution: 'precise' } });
  try {
    for (let target = 1; target <= 100; target++) sliced.board.runUntil(target);
    precise.board.runUntil(100);
    assert.equal(sliced.board.status, 'ready');
    assert.equal(precise.board.status, 'ready');
    assert.deepEqual(sliced.messages, [1, 1001, 2001, 1, 2, 2003, 1, 203, 2004]);
    assert.deepEqual(precise.messages, sliced.messages);
  } finally {
    sliced.board.dispose();
    precise.board.dispose();
  }
});

test('sample field and optional sources use their own comparison types', () => {
  const bench = create(fieldModel, loadNet());
  try {
    bench.board.runUntil(100);
    assert.equal(bench.board.status, 'ready');
    assert.deepEqual(bench.messages, [1, 4, 0, 0]);
    const level = plan(bench.board, 'sampleValue.level');
    const maybe = plan(bench.board, 'maybe');
    assert.ok(level && maybe);
    assert.match(level.comparison, /\["level"\]|a === b/);
    assert.equal(level.slots, 1, 'the whole pin sample stays subscribed');
    assert.match(maybe.comparison, /=== null/, 'nullable compares none first');
    assert.match(maybe.comparison, /a !== a && b !== b/, 'nullable inner keeps number semantics');
    assert.equal(report(bench.board).skipped.length, 0);
  } finally {
    bench.board.dispose();
  }
});

test('memory loads bind the plan, respect endianness and follow a dynamic index', () => {
  const bench = create(memoryModel);
  try {
    bench.board.runUntil(100);
    assert.equal(bench.board.status, 'ready');
    assert.deepEqual(bench.messages, [101, 201, 556, 400, 713, 558, 400, 102, 103, 969, 559, 400]);
    const cell = plan(bench.board, 'cell');
    const little = plan(bench.board, 'little');
    const big = plan(bench.board, 'big');
    const chunk = plan(bench.board, 'chunk');
    for (const entry of [cell, little, big, chunk]) assert.ok(entry);
    assert.match(cell.source, /H\.load\(B\[/, 'loads are emitted, not rejected');
    assert.match(little.source, /H\.load\(B\[/, '16-bit little endian load is emitted');
    assert.match(big.source, /H\.load\(B\[/, '16-bit big endian load is emitted');
    assert.match(chunk.source, /H\.copyBytes\(/);
    assert.equal(report(bench.board).skipped.length, 0);
  } finally {
    bench.board.dispose();
  }
});

test('memory range failures keep the documented model error in a generated reader', () => {
  const bench = create(boundsModel);
  try {
    assert.throws(
      () => bench.board.runUntil(100),
      (error) => {
        assert.equal(error.code, 'MODEL_EXECUTION_FAILED');
        assert.match(error.message, /Memory range is out of bounds/);
        return true;
      },
    );
    assert.equal(bench.board.status, 'faulted');
    assert.deepEqual(bench.messages, []);
    assert.deepEqual(Array.from(bench.memory().marker), [1], 'the start body ran first');
    assert.ok(plan(bench.board, 'wide'));
  } finally {
    bench.board.dispose();
  }
});

test('unsupported generated shapes fall back to the generic source path unchanged', () => {
  const generated = create(generatedLevel, loadNet());
  const fallback = create(fallbackLevel, loadNet());
  try {
    generated.board.runUntil(100);
    fallback.board.runUntil(100);
    assert.equal(generated.board.status, 'ready');
    assert.equal(fallback.board.status, 'ready');
    assert.deepEqual(fallback.messages, generated.messages, 'fallback keeps identical events');
    assert.deepEqual(fallback.messages, [1, 0, 1]);

    assert.ok(plan(generated.board, 'high'), 'the equivalent direct read is generated');
    assert.equal(plan(fallback.board, 'high'), undefined, 'resource parameters are not generated');
    const skipped = report(fallback.board).skipped;
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /parameterised pin/);
    assert.doesNotMatch(
      skipped[0].reason,
      /unexpected code generation failure/,
      'fallback is an explicit support decision, not a code generation accident',
    );
  } finally {
    generated.board.dispose();
    fallback.board.dispose();
  }
});

test('generated readers execute pure asserts and report the model failure', () => {
  const bench = create(guardedModel);
  try {
    assert.throws(
      () => bench.board.runUntil(100),
      (error) => {
        assert.equal(error.code, 'MODEL_EXECUTION_FAILED');
        assert.match(error.message, /x too large/);
        return true;
      },
    );
    assert.equal(bench.board.status, 'faulted');
    assert.deepEqual(bench.messages, [], 'no batch is delivered after the fault');
    assert.ok(plan(bench.board, 'guard'), 'the failing read came from a generated chain');
    // The start body ran to its wait and the first reaction body completed before the
    // failing publication round: both write the public memory marker.
    assert.deepEqual(Array.from(bench.memory().marker), [1, 1]);
  } finally {
    bench.board.dispose();
  }
});

test('initial baseline failures keep the pre-start failure order and skip every body', () => {
  const bench = create(guardedBaselineModel);
  try {
    assert.throws(
      () => bench.board.runUntil(10),
      (error) => {
        assert.equal(error.code, 'MODEL_EXECUTION_FAILED');
        assert.match(error.message, /x too large/);
        return true;
      },
    );
    assert.equal(bench.board.status, 'faulted');
    assert.deepEqual(bench.messages, [], 'no reaction body runs');
    assert.deepEqual(Array.from(bench.memory().marker), [0, 0], 'the start body never runs');
  } finally {
    bench.board.dispose();
  }
});
