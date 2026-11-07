import assert from 'node:assert/strict';
import test from 'node:test';
import { compileDDL } from '@mica-js/ddl';
import { types } from '../../device-model/dist/index.js';
import * as sdk from '../dist/index.js';
import { create as createCameraBench } from './camera-mcu.mjs';

// Everything below goes through the public SDK. `events` keeps the per-message publish
// time and value, so a regression can compare when a value appeared, not only the final
// board time or the value order. The two probes are the read-only diagnostics the
// observation chains and the process engine already expose.

const OBSERVATIONS = Symbol.for('mica-js.simulator/observations');
const PROCESSES = Symbol.for('mica-js.simulator/processes');

function create(model, instances, nets = [], options) {
  const events = [];
  const contexts = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'probe',
      model,
      create(instance) {
        contexts.push(instance);
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? [])
              events.push({ time: message.time, value: message.value });
          },
          dispose() {},
        };
      },
    },
  ]);
  const board =
    options === undefined
      ? sdk.createBoard(library, { instances, nets })
      : sdk.createBoard(library, { instances, nets }, options);
  return {
    board,
    events,
    // Instances are created in declaration order, which is the order used here.
    memory: (index, name) => contexts[index].memory[name],
    admission: () => board[PROCESSES](),
  };
}

// One body shared by two instances. Each instance drives its own pin and reads its own
// sample across suspensions: the bound handles must be per instance and must return the
// current published sample rather than the sample captured when the frame was bound.
const sharedModel = await compileDDL(`device Shared(highFirst: bool default false) {
  pin supply;
  pin reference;
  pin line(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  state seen: number = 0;
  output channel out: number(capacity: 16);

  process start {
    if highFirst { line.intent <- [resistor(to: supply, resistance: 1000)]; }
    await ticks(1);
    if line.sample.level == Logic.high { seen = seen + 1; }
    line.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    if line.sample.level == Logic.high { seen = seen + 1; }
    line.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(1);
    if line.sample.level == Logic.high { seen = seen + 1; }
    out.send(seen);
  }
}`);

function sharedBoard() {
  const nets = [
    { id: 'supplyA', voltage: 3.3, pins: [{ instance: 'a', pin: 'supply' }] },
    { id: 'refA', voltage: 0, pins: [{ instance: 'a', pin: 'reference' }] },
    { id: 'lineA', pins: [{ instance: 'a', pin: 'line' }] },
    { id: 'supplyB', voltage: 3.3, pins: [{ instance: 'b', pin: 'supply' }] },
    { id: 'refB', voltage: 0, pins: [{ instance: 'b', pin: 'reference' }] },
    { id: 'lineB', pins: [{ instance: 'b', pin: 'line' }] },
  ];
  return create(
    sharedModel,
    [
      { id: 'a', type: 'probe', props: { highFirst: true } },
      { id: 'b', type: 'probe', props: { highFirst: false } },
    ],
    nets,
  );
}

test('shared body binds its resources per instance and reads live samples', () => {
  const machine = sharedBoard();
  try {
    // Both processes read three times with a suspension after each read, so nothing is
    // published before the third wake and both values appear at t=3 together.
    machine.board.runUntil(2);
    assert.equal(machine.board.time, 2);
    assert.deepEqual(machine.events, []);
    machine.board.runUntil(10);
    assert.equal(machine.board.status, 'ready');
    // `a` starts high and only the third read is low; `b` starts low, so it sees one high.
    assert.deepEqual(machine.events, [
      { time: 3, value: 2 },
      { time: 3, value: 1 },
    ]);
    const report = machine.admission();
    assert.equal(report.bindings.length, 2, 'one binding table per instance');
    for (const entry of report.bindings) {
      assert.equal(entry.handles, 4, `${entry.instance} resolved its own pin handles`);
      assert.deepEqual(
        entry.bound,
        ['pin\u0000line', 'pin\u0000reference', 'pin\u0000supply', 'state\u0000seen'],
        entry.instance,
      );
      assert.deepEqual(
        entry.processes,
        [{ name: 'start', bound: 4 }],
        `${entry.instance} bound the handles on its own frame`,
      );
    }
    assert.equal(report.bindings[0].instance, 'a');
    assert.equal(report.bindings[1].instance, 'b');
  } finally {
    machine.board.dispose();
  }
});

test('two boards of one shared body keep their bindings isolated', () => {
  const first = sharedBoard();
  const second = sharedBoard();
  try {
    first.board.runUntil(4);
    second.board.runUntil(12);
    const expected = [
      { time: 3, value: 2 },
      { time: 3, value: 1 },
    ];
    assert.deepEqual(first.events, expected);
    assert.deepEqual(second.events, expected);
    assert.equal(first.board.time, 4);
    assert.equal(second.board.time, 12);
    assert.notEqual(first.admission().bindings[0].bound.length, 0);
    assert.notEqual(second.admission().bindings[0].bound.length, 0);
  } finally {
    first.board.dispose();
    second.board.dispose();
  }
});

// Bound memory handles keep the documented load/store semantics: width, endianness,
// dynamic index, bounds failures and the memory changed barrier for observers.
const memoryModel = await compileDDL(`device Memory {
  public memory data[8];
  state index: number = 1;
  output channel out: number(capacity: 16);

  derived cell: number = load8(data, index);
  reaction onCell on cell as (previous, current) { out.send(100 + current); }

  process start {
    store8(data, 0, 255);
    store16be(data, 1, 4660);
    store32le(data, 3, 305419896);
    out.send(load16be(data, index));
    out.send(load32le(data, index + 2));
    out.send(load8(data, index - 1));
    let shot = copyBytes(data, 0, 8);
    out.send(shot.length);
    index = 0;
    await ticks(1);
    out.send(load8(data, 0));
  }
}`);

test('bound memory handles keep width, endianness, dynamic index and the change barrier', () => {
  const machine = create(memoryModel, [{ id: 'm', type: 'probe' }]);
  try {
    // Value and timing together: the stores and four reads run in the first activation,
    // the derived barrier fires at the 1 ps suspension, and the last read only runs once
    // that suspension resumes.
    machine.board.runUntil(0);
    assert.equal(machine.board.time, 0);
    assert.deepEqual(machine.events, [
      { time: 0, value: 4660 },
      { time: 0, value: 305419896 },
      { time: 0, value: 255 },
      { time: 0, value: 8 },
      { time: 0, value: 100 + 255 },
    ]);
    machine.board.runUntil(1);
    assert.equal(machine.board.time, 1);
    assert.equal(machine.events.length, 6);
    assert.deepEqual(machine.events.at(-1), { time: 1, value: 255 });
    machine.board.runUntil(10);
    assert.equal(machine.board.status, 'ready');
    assert.deepEqual([...machine.memory(0, 'data')], [255, 0x12, 0x34, 0x78, 0x56, 0x34, 0x12, 0]);
  } finally {
    machine.board.dispose();
  }
});

const boundsModel = await compileDDL(`device Bounds {
  public memory data[4];
  output channel out: number(capacity: 8);

  process start {
    store8(data, 3, 7);
    out.send(1);
    await ticks(1);
    store8(data, 4, 1);
    out.send(2);
  }
}`);

test('an out-of-bounds bound store faults with the documented message and keeps the prefix', () => {
  const machine = create(boundsModel, [{ id: 'm', type: 'probe' }]);
  try {
    assert.throws(
      () => machine.board.runUntil(10),
      (error) => {
        assert.equal(error.name, 'SimulationError');
        assert.match(error.message, /Memory range is out of bounds/u);
        return true;
      },
    );
    assert.equal(machine.board.status, 'faulted');
    assert.deepEqual(machine.events, [], 'a faulted run never flushes the batch');
    assert.deepEqual([...machine.memory(0, 'data')], [0, 0, 0, 7], 'the prefix store persisted');
    assert.equal(machine.board.time, 1, 'the fault stops at the failing step');
  } finally {
    machine.board.dispose();
  }
});

// The published sample version drives every dependency guard. A derived that is only
// read inside a process body is not an observation subscriber, so its cache is validated
// purely by the sample slot version; a publication that forgot to invalidate would keep
// returning the pre-publication value.
const cachedDerivedModel = await compileDDL(`device Cached {
  pin supply;
  pin reference;
  pin line(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  output channel out: number(capacity: 16);

  pure fn lineHigh() -> bool { return line.sample.level == Logic.high; }
  derived high: bool = lineHigh();
  derived cached: number = lineHigh() ? 33 : 0;

  reaction onHigh on high as (previous, current) { out.send(current ? 1 : 0); }

  process start {
    out.send(cached);
    line.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(1);
    out.send(cached);
  }
}`);

const cachedNets = [
  { id: 'supply', voltage: 3.3, pins: [{ instance: 'c', pin: 'supply' }] },
  { id: 'reference', voltage: 0, pins: [{ instance: 'c', pin: 'reference' }] },
  { id: 'line', pins: [{ instance: 'c', pin: 'line' }] },
];

test('an unsubscribed cached derived sees the published sample after the edge', () => {
  const machine = create(cachedDerivedModel, [{ id: 'c', type: 'probe' }], cachedNets);
  try {
    machine.board.runUntil(10);
    assert.equal(machine.board.status, 'ready');
    // (t=0, cached before the intent) → (t=0, rising reaction) → (t=1, cached after the
    // edge). The last value must be the cached 33, not a stale 0.
    assert.deepEqual(machine.events, [
      { time: 0, value: 0 },
      { time: 0, value: 1 },
      { time: 1, value: 33 },
    ]);
  } finally {
    machine.board.dispose();
  }
});

// A compiled chain always subscribes to the `line` sample slot while generic observers
// join and leave that same slot as `phase` changes. Wake-up bookkeeping must follow the
// live subscriber set, including replacements inside a non-empty set, so the event stream
// equals the all-generic twin exactly, time and value included.
const swapTracked = await compileDDL(`device Swap {
  pin supply;
  pin reference;
  pin sel(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  pin line(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  state phase: number = 0;
  output channel out: number(capacity: 64);

  pure fn lineHigh() -> bool { return line.sample.level == Logic.high; }
  pure fn levelOf(p: pin) -> bool { return p.sample.level == Logic.high; }

  derived tracked: bool = lineHigh();
  derived altA: bool = phase == 1 ? levelOf(line) : false;
  derived altB: bool = phase == 2 ? levelOf(line) : false;

  reaction onTracked on tracked as (previous, current) { out.send(100); }
  reaction onAltA on altA as (previous, current) { out.send(200); }
  reaction onAltB on altB as (previous, current) { out.send(300); }

  process start {
    let cycle = 0;
    while cycle < 2 {
      phase = 1;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      phase = 2;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      phase = 0;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      sel.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      sel.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      cycle = cycle + 1;
    }
  }
}`);

// The all-generic twin observes exactly the same events, so any divergence caused by
// stale subscriber bookkeeping shows up as an event difference.
const swapGeneric = await compileDDL(`device Swap {
  pin supply;
  pin reference;
  pin sel(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  pin line(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  state phase: number = 0;
  output channel out: number(capacity: 64);

  pure fn levelOf(p: pin) -> bool { return p.sample.level == Logic.high; }

  derived tracked: bool = levelOf(line);
  derived altA: bool = phase == 1 ? levelOf(line) : false;
  derived altB: bool = phase == 2 ? levelOf(line) : false;

  reaction onTracked on tracked as (previous, current) { out.send(100); }
  reaction onAltA on altA as (previous, current) { out.send(200); }
  reaction onAltB on altB as (previous, current) { out.send(300); }

  process start {
    let cycle = 0;
    while cycle < 2 {
      phase = 1;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      phase = 2;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      phase = 0;
      await ticks(1);
      line.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      line.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      sel.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      sel.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      cycle = cycle + 1;
    }
  }
}`);

const swapNets = [
  { id: 'supply', voltage: 3.3, pins: [{ instance: 's', pin: 'supply' }] },
  { id: 'reference', voltage: 0, pins: [{ instance: 's', pin: 'reference' }] },
  { id: 'sel', pins: [{ instance: 's', pin: 'sel' }] },
  { id: 'line', pins: [{ instance: 's', pin: 'line' }] },
];

test('dynamic non-empty subscriptions keep the generated chain event stream exact', () => {
  const tracked = create(swapTracked, [{ id: 's', type: 'probe' }], swapNets);
  const generic = create(swapGeneric, [{ id: 's', type: 'probe' }], swapNets);
  try {
    tracked.board.runUntil(200);
    generic.board.runUntil(200);
    assert.equal(tracked.board.status, 'ready');
    assert.equal(generic.board.status, 'ready');
    assert.ok(generic.events.length > 6, 'the observers fired repeatedly');
    assert.deepEqual(tracked.events, generic.events, 'chain admissions change no event or time');
    assert.ok(
      tracked.board[OBSERVATIONS]().plans.length >= 1,
      'the compiled chain kept its generated plan',
    );
    for (let index = 1; index < tracked.events.length; index++)
      assert.ok(tracked.events[index].time >= tracked.events[index - 1].time);
  } finally {
    tracked.board.dispose();
    generic.board.dispose();
  }
});

// A store into JIT code RAM must drop the cached translation. The firmware below runs
// opcode 1 (+1 per instruction) until the model rewrites the byte at PC 0 through its
// bound memory handle; the next execution must translate opcode 2 (+100) instead.
const selfModifyingModel = await compileDDL(`device Rewrite {
  public memory code[4];
  state pc: number = 0;
  state value: number = 0;
  output channel out: number(capacity: 16);

  process start {
    await ticks(1000);
    out.send(value);
    store8(code, 0, 2);
    await ticks(1000);
    out.send(value);
  }
}`);

function createRewritingBoard() {
  const events = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'cpu',
      model: selfModifyingModel,
      create(ctx) {
        ctx.attachJit({
          entry: 'cpu',
          code: 'code',
          pc: 'pc',
          translate: ({ pc, code: bytes }, block) => {
            const opcode = bytes[pc];
            block.instruction({ pc, nextPc: pc }, (b) => {
              const value = b.readState('value', types.number);
              if (opcode === 1) b.writeState('value', b.add(value, 1));
              else if (opcode === 2) b.writeState('value', b.add(value, 100));
              else throw new Error(`unexpected opcode ${opcode}`);
              b.redirect(0, 10);
            });
            return block.finish();
          },
        });
        ctx.loadBytes('code', Uint8Array.from([1, 0, 0, 0]));
        return {
          sync(batch) {
            for (const message of batch.outputs.out ?? [])
              events.push({ time: message.time, value: message.value });
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = sdk.createBoard(library, { instances: [{ id: 'cpu', type: 'cpu' }], nets: [] });
  return { board, events };
}

test('a bound store into code RAM invalidates the cached instruction', () => {
  const machine = createRewritingBoard();
  try {
    machine.board.runUntil(5000);
    assert.equal(machine.board.status, 'ready');
    assert.equal(machine.events.length, 2);
    const [first, second] = machine.events;
    assert.equal(first.time, 1000);
    // Opcode 1 ran for 1000 ps at 10 ps per instruction: a small positive count.
    assert.ok(first.value > 0 && first.value < 1000, `opcode 1 ran: ${first.value}`);
    assert.equal(second.time, 2000);
    // Only the rewritten opcode can add hundreds per instruction after the store.
    assert.ok(
      second.value >= first.value + 1000,
      `opcode 2 ran after the code store: ${first.value} -> ${second.value}`,
    );
  } finally {
    machine.board.dispose();
  }
});

test('the camera workload keeps its generated chains and admitted processes', () => {
  const bench = createCameraBench(sdk, { execution: 'throughput', sliceMs: 0 });
  try {
    for (let frame = 0; frame < 2; frame++) {
      const sample = bench.stepFrame();
      const gate = bench.verifyFrame(sample.frame, { digestBytes: true });
      assert.equal(gate.rawMismatches, 0);
      assert.equal(gate.binaryMismatches, 0);
    }
    const report = bench.board[OBSERVATIONS]();
    assert.ok(report.plans.length >= 2, 'both pin derivations kept a generated chain');
    const processes = bench.board[PROCESSES]();
    assert.deepEqual(processes.generic, []);
    assert.ok(processes.bindings.every((entry) => entry.handles >= 4));
  } finally {
    bench.dispose();
  }
});
