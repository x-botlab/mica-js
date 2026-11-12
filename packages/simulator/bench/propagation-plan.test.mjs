import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { compileDDL } from '@mica-js/ddl';
import * as sdk from '../dist/index.js';

// The electrical network is exercised from source because its plan counters are an
// internal diagnostic surface: `leafPlans` counts admitted leaf shapes and
// `leafPropagations` counts solves served by replaying one. Both fields only exist for
// these assertions; nothing here reads runtime internals.
//
// The public-SDK cases below use several real instances sharing electrical nets. They
// observe published samples, reaction order, capture values, memory content and errors.

const source = await readFile(new URL('../src/electrical.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'electrical.ts',
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length ?? 0, 0, 'electrical source must transpile cleanly');
const { createElectricalNetwork } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);

const resistance = 1000;

function pin(id, thresholds = false) {
  return {
    id,
    instance: 'plan',
    name: id,
    ...(thresholds ? { low: 0.8, high: 2.0 } : {}),
    intent: [],
    sample: { voltage: null, level: 'unknown', status: 'floating' },
  };
}

// One driven leaf on a two-endpoint signal net, exactly the shape a camera bus has:
// the sender keeps a single branch onto a fixed rail while the receiver only samples.
function leafFixture(prefix = 'plan') {
  const high = pin(`${prefix}.high`);
  const low = pin(`${prefix}.low`);
  const sender = pin(`${prefix}.sender`, true);
  const receiver = pin(`${prefix}.receiver`, true);
  const senderHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
  const senderLow = Object.freeze([Object.freeze({ to: low, resistance })]);
  sender.intent = senderLow;
  return {
    high,
    low,
    sender,
    receiver,
    senderHigh,
    senderLow,
    network: createElectricalNetwork(
      [high, low, sender, receiver],
      [
        { id: 'high', pins: [high], voltage: 3.3 },
        { id: 'low', pins: [low], voltage: 0 },
        { id: 'signal', pins: [sender, receiver] },
      ],
    ),
  };
}

test('an admitted leaf plan is replayed for repeated reference switches', () => {
  const fixture = leafFixture();
  const { network, sender, receiver, senderHigh, senderLow } = fixture;
  network.solve();
  assert.equal(receiver.sample.voltage, 0, 'baseline publishes the initial branch');
  const admitted = network.stats.leafPlans;
  const before = network.stats.leafPropagations;
  // Two shapes mean the first visit to each still needs the general solver to admit it;
  // every later switch must replay an admitted shape.
  for (let round = 0; round < 6; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : senderLow;
    const changed = network.solve([sender]);
    const voltage = round % 2 === 0 ? 3.3 : 0;
    assert.deepEqual(
      changed.map((endpoint) => endpoint.id),
      ['plan.sender', 'plan.receiver'],
      'a switch publishes both endpoints of the net in board order',
    );
    assert.equal(sender.sample.voltage, voltage);
    assert.equal(receiver.sample.voltage, voltage, 'the whole net publishes atomically');
    assert.equal(sender.sample.level, round % 2 === 0 ? 'high' : 'low');
  }
  assert.ok(network.stats.leafPlans >= admitted + 2, 'both reference shapes were admitted');
  assert.ok(
    network.stats.leafPropagations - before >= 4,
    'repeated switches replay the precomputed plan',
  );

  // Published order stays board order even when the dirty hints arrive reversed.
  const order = [];
  for (const intent of [senderHigh, senderLow, senderHigh]) {
    sender.intent = intent;
    order.push(network.solve(new Set([sender, receiver])).map((endpoint) => endpoint.id));
  }
  assert.deepEqual(order, [
    ['plan.sender', 'plan.receiver'],
    ['plan.sender', 'plan.receiver'],
    ['plan.sender', 'plan.receiver'],
  ]);
  assert.equal(network.stats.components, 2, 'the signal net stays attached to one rail only');
});

test('an idle sibling network keeps its own counters and samples', () => {
  const driven = leafFixture('driven');
  const untouched = leafFixture('untouched');
  // `untouched` only ever sees its own baseline solve.
  untouched.network.solve();
  const baselineStats = untouched.network.stats;
  const baselineSamples = [untouched.sender.sample, untouched.receiver.sample];
  for (let round = 0; round < 6; round++) {
    driven.sender.intent = round % 2 === 0 ? driven.senderHigh : driven.senderLow;
    driven.network.solve([driven.sender]);
  }
  assert.ok(driven.network.stats.leafPropagations > 0, 'the driven network replays its plan');
  assert.deepEqual(
    untouched.network.stats,
    baselineStats,
    'a second network shares no counters with the first',
  );
  assert.equal(untouched.sender.sample, baselineSamples[0], 'no foreign publication reached it');
  assert.equal(untouched.receiver.sample, baselineSamples[1]);
  assert.equal(untouched.sender.sample.voltage, 0);
  assert.equal(untouched.receiver.sample.voltage, 0);
  assert.equal(untouched.network.stats.leafPropagations, 0);
});

test('a coupled branch invalidates the guard and falls back to the general solver', () => {
  const fixture = leafFixture();
  const { sender, receiver, senderHigh, senderLow } = fixture;
  const peer = pin('plan.peer', true);
  peer.intent = [{ to: fixture.low, resistance }];
  const bridged = createElectricalNetwork(
    [fixture.high, fixture.low, sender, receiver, peer],
    [
      { id: 'high', pins: [fixture.high], voltage: 3.3 },
      { id: 'low', pins: [fixture.low], voltage: 0 },
      { id: 'signal', pins: [sender, receiver] },
      { id: 'peer', pins: [peer] },
    ],
  );
  bridged.solve();
  for (let round = 0; round < 4; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : senderLow;
    bridged.solve([sender]);
  }
  assert.ok(bridged.stats.leafPropagations > 0, 'the leaf shape is admitted first');
  // Two branches onto unknown nodes make the pin a divider, so the leaf plan must be
  // rejected. The published result is the solver's own divider, not a rail.
  const replayable = bridged.stats.leafPropagations;
  sender.intent = [
    { to: fixture.high, resistance },
    { to: peer, resistance },
  ];
  bridged.solve([sender]);
  assert.equal(
    bridged.stats.leafPropagations,
    replayable,
    'a coupled pin never replays a leaf plan',
  );
  assert.ok(
    Math.abs(sender.sample.voltage - (3.3 * 2) / 3) < 1e-9,
    'the divider result is published',
  );
  assert.ok(
    Math.abs(peer.sample.voltage - 3.3 / 3) < 1e-9,
    'both pins of the coupled component publish together',
  );
  // Returning to the single-branch shape must still publish the rail exactly.
  sender.intent = senderLow;
  bridged.solve([sender]);
  assert.equal(sender.sample.voltage, 0);
  assert.equal(receiver.sample.voltage, 0);
});

test('single branches between unknown nodes are never admitted as leaves', () => {
  const high = pin('pair.high');
  const low = pin('pair.low');
  const first = pin('pair.first', true);
  const second = pin('pair.second', true);
  first.intent = [{ to: second, resistance }];
  second.intent = [{ to: low, resistance }];
  const network = createElectricalNetwork(
    [high, low, first, second],
    [
      { id: 'high', pins: [high], voltage: 5 },
      { id: 'low', pins: [low], voltage: 0 },
    ],
  );
  network.solve();
  for (let round = 0; round < 4; round++) {
    first.intent = [{ to: round % 2 === 0 ? second : low, resistance }];
    network.solve([first]);
  }
  assert.equal(network.stats.leafPlans, 0, 'an unknown-node target is not a leaf reference');
  assert.equal(first.sample.status, 'valid');
});

// A real board bridges its rails with a load, so VCC and GND end up inside one component.
// That is exactly the shape in which "every fixed potential in the component agrees" is
// false while a leaf branch is still pinned to its target by KCL alone.
function bridgedLeafFixture(prefix = 'bridged') {
  const high = pin(`${prefix}.high`);
  const low = pin(`${prefix}.low`);
  const bridge = pin(`${prefix}.bridge`);
  const sender = pin(`${prefix}.sender`, true);
  const receiver = pin(`${prefix}.receiver`, true);
  const senderHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
  const senderLow = Object.freeze([Object.freeze({ to: low, resistance })]);
  bridge.intent = Object.freeze([Object.freeze({ to: low, resistance: 470 })]);
  sender.intent = senderHigh;
  return {
    high,
    low,
    bridge,
    sender,
    receiver,
    senderHigh,
    senderLow,
    network: createElectricalNetwork(
      [high, low, bridge, sender, receiver],
      [
        // The load keeps both rails in one component with two different potentials.
        { id: 'high', pins: [high, bridge], voltage: 5 },
        { id: 'low', pins: [low], voltage: 0 },
        { id: 'signal', pins: [sender, receiver] },
      ],
    ),
  };
}

test('a leaf onto a mixed-reference component still takes the target reference', () => {
  const { network, sender, receiver, senderHigh, senderLow } = bridgedLeafFixture();
  network.solve();
  assert.equal(sender.sample.voltage, 5);
  assert.equal(receiver.sample.voltage, 5);
  const replays = network.stats.leafPropagations;
  for (let round = 1; round <= 6; round++) {
    const towardsLow = round % 2 === 1;
    sender.intent = towardsLow ? senderLow : senderHigh;
    const voltage = towardsLow ? 0 : 5;
    assert.deepEqual(
      network.solve([sender]).map((endpoint) => endpoint.id),
      ['bridged.sender', 'bridged.receiver'],
      'the whole leaf net publishes atomically',
    );
    assert.equal(sender.sample.voltage, voltage);
    assert.equal(receiver.sample.voltage, voltage);
    assert.equal(sender.sample.level, towardsLow ? 'low' : 'high');
  }
  assert.ok(
    network.stats.leafPropagations - replays === 6,
    'every switch is served by the leaf path, not by a matrix',
  );
  assert.equal(network.stats.components, 1, 'both rails stay inside one component');
});

test('a batch of leaves onto a mixed-reference component publishes every switch', () => {
  const high = pin('batch.high');
  const low = pin('batch.low');
  const bridge = pin('batch.bridge');
  const first = pin('batch.first', true);
  const firstReceiver = pin('batch.firstReceiver', true);
  const second = pin('batch.second', true);
  const secondReceiver = pin('batch.secondReceiver', true);
  const firstHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
  const firstLow = Object.freeze([Object.freeze({ to: low, resistance })]);
  const secondHigh = Object.freeze([Object.freeze({ to: high, resistance: 2200 })]);
  const secondLow = Object.freeze([Object.freeze({ to: low, resistance: 2200 })]);
  bridge.intent = Object.freeze([Object.freeze({ to: low, resistance: 470 })]);
  first.intent = firstHigh;
  second.intent = secondLow;
  const network = createElectricalNetwork(
    [high, low, bridge, first, firstReceiver, second, secondReceiver],
    [
      { id: 'high', pins: [high, bridge], voltage: 5 },
      { id: 'low', pins: [low], voltage: 0 },
      { id: 'first', pins: [first, firstReceiver] },
      { id: 'second', pins: [second, secondReceiver] },
    ],
  );
  network.solve();
  const replays = network.stats.leafPropagations;
  for (let round = 1; round <= 4; round++) {
    const towardsLow = round % 2 === 1;
    first.intent = towardsLow ? firstLow : firstHigh;
    second.intent = towardsLow ? secondHigh : secondLow;
    // Both leaves switch in one batch, so the joint solve is skipped for both of them.
    const changed = network.solve([first, second]);
    assert.deepEqual(
      changed.map((endpoint) => endpoint.id),
      ['batch.first', 'batch.firstReceiver', 'batch.second', 'batch.secondReceiver'],
      'one batch publishes both nets in board order',
    );
    assert.equal(firstReceiver.sample.voltage, towardsLow ? 0 : 5);
    assert.equal(secondReceiver.sample.voltage, towardsLow ? 5 : 0);
  }
  assert.equal(network.stats.leafPropagations - replays, 4, 'one batch is one propagated solve');
  assert.equal(network.stats.components, 1);
});

test('a full solve after leaf replay publishes nothing and keeps components exact', () => {
  const { network, sender, receiver, senderHigh, senderLow } = bridgedLeafFixture('exact');
  network.solve();
  for (let round = 1; round <= 5; round++) {
    sender.intent = round % 2 === 1 ? senderLow : senderHigh;
    network.solve([sender]);
  }
  assert.ok(network.stats.leafPropagations > 0, 'the leaf path served the switches');
  const voltage = sender.sample.voltage;
  assert.equal(receiver.sample.voltage, voltage);
  // The incremental node arrays are only correct if a partition rebuilt from scratch
  // reproduces the same voltages and disagrees with nothing.
  assert.deepEqual(network.solve(), [], 'the rebuilt partition corrects no pin');
  assert.equal(sender.sample.voltage, voltage);
  assert.equal(receiver.sample.voltage, voltage);
  assert.equal(network.stats.components, 1);
  const replays = network.stats.leafPropagations;
  sender.intent = voltage === 5 ? senderLow : senderHigh;
  network.solve([sender]);
  assert.equal(
    network.stats.leafPropagations,
    replays + 1,
    'the leaf path still replays across the rebuilt partition',
  );
});

test('a branch onto a floating node keeps the general solver', () => {
  const high = pin('float.high');
  const low = pin('float.low');
  const dangler = pin('float.dangler', true);
  const floater = pin('float.floater', true);
  const peer = pin('float.peer', true);
  const danglerHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
  dangler.intent = danglerHigh;
  const network = createElectricalNetwork(
    [high, low, dangler, floater, peer],
    [
      { id: 'high', pins: [high], voltage: 5 },
      { id: 'low', pins: [low], voltage: 0 },
      { id: 'dangling', pins: [dangler] },
      // No reference anywhere in this component.
      { id: 'floating', pins: [floater, peer] },
    ],
  );
  network.solve();
  assert.equal(dangler.sample.voltage, 5);
  for (let round = 0; round < 4; round++) {
    dangler.intent = round % 2 === 0 ? [{ to: floater, resistance }] : danglerHigh;
    network.solve([dangler]);
  }
  assert.equal(network.stats.leafPlans, 0, 'a floating target never admits a leaf shape');
  assert.equal(network.stats.leafPropagations, 0, 'the general solver keeps the floating net');
  assert.equal(dangler.sample.voltage, 5);
  dangler.intent = [{ to: floater, resistance }];
  network.solve([dangler]);
  assert.equal(dangler.sample.voltage, null);
  assert.equal(dangler.sample.status, 'floating');
  assert.equal(floater.sample.status, 'floating');
  assert.equal(peer.sample.status, 'floating');
});

test('a board-sized leaf batch stays off the general solver', () => {
  const drivers = [];
  const pins = [];
  const nets = [];
  const high = pin('board.high');
  const low = pin('board.low');
  const bridge = pin('board.bridge');
  bridge.intent = Object.freeze([Object.freeze({ to: low, resistance: 470 })]);
  pins.push(high, low, bridge);
  nets.push(
    { id: 'high', pins: [high, bridge], voltage: 3.3 },
    { id: 'low', pins: [low], voltage: 0 },
  );
  for (let index = 0; index < 48; index++) {
    const driver = pin(`board.driver${index}`, true);
    const reader = pin(`board.reader${index}`, true);
    const driverHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
    const driverLow = Object.freeze([Object.freeze({ to: low, resistance })]);
    driver.intent = index % 2 === 0 ? driverHigh : driverLow;
    pins.push(driver, reader);
    nets.push({ id: `board.signal${index}`, pins: [driver, reader] });
    drivers.push({ driver, reader, driverHigh, driverLow });
  }
  const network = createElectricalNetwork(pins, nets);
  network.solve();
  const replays = network.stats.leafPropagations;
  for (let round = 0; round < 4; round++) {
    const towardsLow = round % 2 === 0;
    for (const entry of drivers)
      entry.driver.intent = towardsLow ? entry.driverLow : entry.driverHigh;
    network.solve(drivers.map((entry) => entry.driver));
    for (const entry of drivers) {
      assert.equal(entry.reader.sample.voltage, towardsLow ? 0 : 3.3);
    }
  }
  assert.equal(
    network.stats.leafPropagations - replays,
    4,
    'each whole-board batch is one propagated solve',
  );
  assert.equal(network.stats.components, 1);
  assert.deepEqual(network.solve(), [], 'the rebuilt partition corrects no pin');
});

test('an invalid intent in an admitted leaf batch publishes and admits nothing', () => {
  const fixture = leafFixture();
  const { sender, receiver, senderHigh, senderLow } = fixture;
  const spare = pin('plan.spare', true);
  spare.intent = senderLow;
  const batch = createElectricalNetwork(
    [fixture.high, fixture.low, sender, receiver, spare],
    [
      { id: 'high', pins: [fixture.high], voltage: 3.3 },
      { id: 'low', pins: [fixture.low], voltage: 0 },
      { id: 'signal', pins: [sender, receiver] },
      { id: 'spare', pins: [spare] },
    ],
  );
  batch.solve();
  for (let round = 0; round < 4; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : senderLow;
    spare.intent = round % 2 === 0 ? senderHigh : senderLow;
    batch.solve([sender, spare]);
  }
  assert.ok(batch.stats.leafPropagations > 0, 'both leaf pins replay admitted plans');
  const frozenStats = batch.stats;
  const frozenSamples = [sender.sample, receiver.sample, spare.sample];
  // A second pin in the same batch now carries an out-of-range resistance, so the batch
  // cannot be replayed. The general path rejects it before publishing anything.
  sender.intent = senderHigh;
  spare.intent = [{ to: fixture.high, resistance: 0.0005 }];
  assert.throws(
    () => batch.solve([sender, spare]),
    (error) => {
      assert.equal(error.code, 'INVALID_ELECTRICAL_PARAMETER');
      assert.equal(error.resource, 'plan.spare');
      assert.equal(error.instanceId, 'plan');
      return true;
    },
  );
  assert.deepEqual(batch.stats, frozenStats, 'a rejected batch changes no counters');
  assert.equal(sender.sample, frozenSamples[0], 'no pin published a partial sample');
  assert.equal(receiver.sample, frozenSamples[1]);
  assert.equal(spare.sample, frozenSamples[2]);
  // Both intents stayed uncommitted, so a later valid solve still publishes them.
  spare.intent = senderHigh;
  const recovered = batch.solve([sender, spare]);
  assert.deepEqual(
    recovered.map((endpoint) => endpoint.id),
    ['plan.sender', 'plan.receiver', 'plan.spare'],
    'the rejected batch left both intents uncommitted',
  );
  assert.equal(spare.sample.voltage, 3.3);
  assert.equal(sender.sample.voltage, 3.3);
  assert.equal(receiver.sample.voltage, 3.3);
});

// The publish path accepts `Iterable<number>`; a caller may pass a one-shot generator.
// The fast path may not probe such an input and then re-iterate it, because the probe
// would consume the iterator and the remaining dirty slots would be silently dropped.
function publishFixture() {
  const high = pin('publish.high');
  const low = pin('publish.low');
  const sender = pin('publish.sender', true);
  const receiver = pin('publish.receiver', true);
  const fresh = pin('publish.fresh', true);
  const freshReceiver = pin('publish.freshReceiver', true);
  const senderHigh = Object.freeze([Object.freeze({ to: high, resistance })]);
  const senderLow = Object.freeze([Object.freeze({ to: low, resistance })]);
  sender.intent = senderLow;
  fresh.intent = senderLow;
  return {
    sender,
    receiver,
    fresh,
    freshReceiver,
    senderHigh,
    senderLow,
    network: createElectricalNetwork(
      [high, low, sender, receiver, fresh, freshReceiver],
      [
        { id: 'high', pins: [high], voltage: 3.3 },
        { id: 'low', pins: [low], voltage: 0 },
        { id: 'signal', pins: [sender, receiver] },
        { id: 'fresh', pins: [fresh, freshReceiver] },
      ],
    ),
    slots: { sender: 2, fresh: 4 },
  };
}

test('a one-shot iterable is consumed once, so no dirty slot is dropped', () => {
  const fixture = publishFixture();
  const { network, sender, receiver, fresh, freshReceiver, senderHigh, slots } = fixture;
  network.solve();
  for (let round = 0; round < 3; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : fixture.senderLow;
    network.solve([sender]);
  }
  assert.ok(network.stats.leafPropagations > 0, 'the sender leaf shape is admitted');
  // The first slot replays its admitted plan; the second pin was never switched, so it
  // has no plan and the batch has to fall back to the general solver.
  sender.intent = senderHigh;
  fresh.intent = senderHigh;
  const driver = function* () {
    yield slots.sender;
    yield slots.fresh;
  };
  network.solveSlots(driver());
  assert.equal(sender.sample.voltage, 3.3, 'the replayable prefix was published');
  assert.equal(receiver.sample.voltage, 3.3);
  assert.equal(fresh.sample.voltage, 3.3, 'the unmatched tail slot was not dropped');
  assert.equal(freshReceiver.sample.voltage, 3.3);
});

test('a one-shot iterable with an invalid intent stays atomic and throws', () => {
  const fixture = publishFixture();
  const { network, sender, receiver, fresh, freshReceiver, senderHigh, slots } = fixture;
  network.solve();
  for (let round = 0; round < 3; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : fixture.senderLow;
    network.solve([sender]);
  }
  assert.ok(network.stats.leafPropagations > 0);
  const frozenStats = network.stats;
  const frozenSamples = [sender.sample, receiver.sample, fresh.sample, freshReceiver.sample];
  sender.intent = senderHigh;
  fresh.intent = [{ to: fixture.senderHigh[0].to, resistance: Number.NaN }];
  const driver = function* () {
    yield slots.sender;
    yield slots.fresh;
  };
  assert.throws(
    () => network.solveSlots(driver()),
    (error) => {
      assert.equal(error.code, 'INVALID_ELECTRICAL_PARAMETER');
      assert.equal(error.resource, 'publish.fresh');
      return true;
    },
    'the invalid tail must still be validated, not skipped',
  );
  assert.deepEqual(network.stats, frozenStats, 'a rejected batch changes no counters');
  assert.equal(sender.sample, frozenSamples[0], 'no partial publish from the replayable prefix');
  assert.equal(receiver.sample, frozenSamples[1]);
  assert.equal(fresh.sample, frozenSamples[2]);
  assert.equal(freshReceiver.sample, frozenSamples[3]);
});

test('a set batch with an invalid intent is rejected atomically too', () => {
  const fixture = publishFixture();
  const { network, sender, receiver, fresh, freshReceiver, senderHigh, slots } = fixture;
  network.solve();
  for (let round = 0; round < 3; round++) {
    sender.intent = round % 2 === 0 ? senderHigh : fixture.senderLow;
    network.solve([sender]);
  }
  const frozenStats = network.stats;
  const frozenSamples = [sender.sample, receiver.sample, fresh.sample, freshReceiver.sample];
  sender.intent = senderHigh;
  fresh.intent = [{ to: fixture.senderHigh[0].to, resistance: Number.NaN }];
  assert.throws(
    () => network.solveSlots(new Set([slots.sender, slots.fresh])),
    (error) => {
      assert.equal(error.code, 'INVALID_ELECTRICAL_PARAMETER');
      return true;
    },
  );
  assert.deepEqual(network.stats, frozenStats);
  assert.equal(sender.sample, frozenSamples[0]);
  assert.equal(receiver.sample, frozenSamples[1]);
  assert.equal(fresh.sample, frozenSamples[2]);
  assert.equal(freshReceiver.sample, frozenSamples[3]);
});

// --- public SDK: one published round, several real instances -----------------------

const driverModel = await compileDDL(`device Driver {
  pin supply;
  pin reference;
  pin bus(low: 0.8, high: 2.0);

  process start {
    bus.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(100);
    bus.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(100);
    bus.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(100);
    bus.intent <- [resistor(to: reference, resistance: 1000)];
    await ticks(100);
  }
}`);

// `who` labels the instance in the trace. `aggressive` makes the first reaction body
// re-drive the shared bus, so every receiver's live read in that same round must still
// see the round's published sample.
const receiverModel =
  await compileDDL(`device Receiver(who: number default 1, aggressive: bool default false) {
  pin supply;
  pin reference;
  pin bus(low: 0.8, high: 2.0);

  state marks: number = 0;
  record Ev { who: number; tag: number; savedLevel: number; liveLevel: number; savedMarks: number; liveMarks: number; }
  output channel out: Ev(capacity: 512);

  pure fn busLevel() -> number {
    if bus.sample.level == Logic.high { return 2; }
    if bus.sample.level == Logic.low { return 0; }
    return 1;
  }
  pure fn busHigh() -> bool { return bus.sample.level == Logic.high; }

  derived high: bool = busHigh();

  reaction first on high as (previous, current) capture savedLevel = busLevel(), savedMarks = marks {
    out.send({who: who, tag: 1, savedLevel: savedLevel, liveLevel: busLevel(), savedMarks: savedMarks, liveMarks: marks});
    marks = marks + 1;
    if aggressive { bus.intent <- [resistor(to: reference, resistance: 1000)]; }
  }
  reaction second on high as (previous, current) capture savedLevel = busLevel(), savedMarks = marks {
    out.send({who: who, tag: 2, savedLevel: savedLevel, liveLevel: busLevel(), savedMarks: savedMarks, liveMarks: marks});
    marks = marks + 1;
  }
  process follow on high {
    out.send({who: who, tag: 3, savedLevel: 0, liveLevel: busLevel(), savedMarks: 0, liveMarks: marks});
  }
}`);

const captureFaultModel = await compileDDL(`device Gate {
  pin supply;
  pin reference;
  pin source(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  public memory marker[4];
  output channel out: number(capacity: 32);
  state bodies: number = 0;
  pure fn sourceLevel() -> bool { return source.sample.level == Logic.high; }
  pure fn guardLevel() -> number {
    assert source.sample.level == Logic.low;
    return 1;
  }
  derived sourceHigh: bool = sourceLevel();
  reaction first on sourceHigh as (previous, current) {
    store32le(marker, 0, 1);
    bodies = bodies + 1;
    out.send(1);
  }
  reaction failing on sourceHigh as (previous, current) capture guard = guardLevel() {
    out.send(2);
  }
  process start {
    source.intent <- [resistor(to: supply, resistance: 1000)];
    await ticks(10);
  }
}`);

function linkBoard(receivers, execution = 'throughput') {
  const traces = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'driver',
      model: driverModel,
      create() {
        return { sync() {}, dispose() {} };
      },
    },
    {
      id: 'receiver',
      model: receiverModel,
      create() {
        return {
          sync(batch) {
            for (const message of batch.outputs.out) traces.push(message.value);
          },
          dispose() {},
        };
      },
    },
  ]);
  const instances = [{ id: 'driver', type: 'driver' }];
  for (const receiver of receivers)
    instances.push({
      id: receiver.id,
      type: 'receiver',
      props: { who: receiver.who, aggressive: receiver.aggressive === true },
    });
  const nets = [
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
    { id: 'bus', pins: instances.map(({ id }) => ({ instance: id, pin: 'bus' })) },
  ];
  const board = sdk.createBoard(library, { instances, nets }, { execution });
  return { board, traces };
}

const tagOf = (trace) => `${trace.who}:${trace.tag}`;

test('a real sender drives two receiver instances through one shared net round', () => {
  const { board, traces } = linkBoard([
    { id: 'r1', who: 1, aggressive: true },
    { id: 'r2', who: 2 },
  ]);
  try {
    board.runUntil(1_000);
    assert.equal(board.status, 'ready');
    const forWho = (who) => traces.filter((trace) => trace.who === who);
    // Both instances run the same rounds. The first round sees the bus rise to 3.3 V;
    // the aggressive body re-drives the bus inside that round, so the following round
    // publishes the resulting divider (level 1) and finally the ordinary processes run.
    for (const who of [1, 2]) {
      assert.deepEqual(
        forWho(who).map((trace) => trace.tag),
        [1, 2, 1, 2, 3],
        `receiver ${who} reports its reactions in declaration order, then the process`,
      );
      assert.deepEqual(
        forWho(who)
          .filter((trace) => trace.tag === 1)
          .map((trace) => trace.savedLevel),
        [2, 1],
        `receiver ${who} observes the rise and then the divider level`,
      );
    }
    // Cross-instance round identity: the second receiver's live read in the round where
    // the first receiver re-drove the bus is still the round's published sample.
    const firstRoundR2 = forWho(2).filter((trace) => trace.tag === 1)[0];
    assert.equal(firstRoundR2.savedLevel, 2, 'the capture sees the published rise');
    assert.equal(
      firstRoundR2.liveLevel,
      2,
      'a body intent write does not republish the net inside its own round',
    );
    // The capture barrier spans both reactions of an instance.
    const round = forWho(1).slice(0, 2);
    assert.deepEqual(
      round.map((trace) => trace.savedMarks),
      [0, 0],
      'both captures run before any body of the round',
    );
    assert.deepEqual(
      round.map((trace) => trace.liveMarks),
      [0, 1],
      'earlier body writes are visible to later live reads only',
    );
    // The queued ordinary process runs after the whole closure.
    const follow = forWho(1).find((trace) => trace.tag === 3);
    assert.equal(follow.liveMarks, 4, 'the process runs after both rounds finished their bodies');
    assert.equal(follow.liveLevel, 1);
  } finally {
    board.dispose();
  }
});

test('an extra observer instance does not perturb the existing receivers', () => {
  const pair = linkBoard([
    { id: 'r1', who: 1, aggressive: true },
    { id: 'r2', who: 2 },
  ]);
  const trio = linkBoard([
    { id: 'r1', who: 1, aggressive: true },
    { id: 'r2', who: 2 },
    { id: 'r3', who: 3 },
  ]);
  try {
    pair.board.runUntil(1_000);
    trio.board.runUntil(1_000);
    const pairTags = pair.traces.map(tagOf);
    const trioWithoutObserver = trio.traces.filter((trace) => trace.who !== 3).map(tagOf);
    assert.deepEqual(trioWithoutObserver, pairTags);
    const observer = trio.traces.filter((trace) => trace.who === 3);
    assert.ok(observer.length > 0, 'the extra observer really ran');
    assert.deepEqual(
      observer.filter((trace) => trace.tag === 1).map((trace) => trace.savedLevel),
      trio.traces
        .filter((trace) => trace.who === 2 && trace.tag === 1)
        .map((trace) => trace.savedLevel),
      'the observer sees exactly the levels of the other receivers',
    );
  } finally {
    pair.board.dispose();
    trio.board.dispose();
  }
});

test('sliced and whole advancement publish identical rounds', () => {
  const whole = linkBoard([
    { id: 'r1', who: 1, aggressive: true },
    { id: 'r2', who: 2 },
  ]);
  const sliced = linkBoard([
    { id: 'r1', who: 1, aggressive: true },
    { id: 'r2', who: 2 },
  ]);
  try {
    whole.board.runUntil(1_000);
    for (let at = 0; at <= 1_000; at += 25) sliced.board.runUntil(at);
    assert.deepEqual(sliced.traces, whole.traces);
    assert.equal(sliced.board.time, whole.board.time);
  } finally {
    whole.board.dispose();
    sliced.board.dispose();
  }
});

test('a capture failure suppresses every reaction body in that round', () => {
  let context;
  const sent = [];
  const library = sdk.createDeviceLibrary([
    {
      id: 'gate',
      model: captureFaultModel,
      create(ctx) {
        context = ctx;
        return {
          sync(batch) {
            sent.push(...batch.outputs.out);
          },
          dispose() {},
        };
      },
    },
  ]);
  const board = sdk.createBoard(library, {
    instances: [{ id: 'gate', type: 'gate' }],
    nets: [
      { id: 'supply', voltage: 3.3, pins: [{ instance: 'gate', pin: 'supply' }] },
      { id: 'reference', voltage: 0, pins: [{ instance: 'gate', pin: 'reference' }] },
      { id: 'signal', pins: [{ instance: 'gate', pin: 'source' }] },
    ],
  });
  try {
    assert.throws(
      () => board.runUntil(10_000),
      (error) => {
        assert.match(error.message, /Assertion failed/);
        return true;
      },
    );
    assert.equal(board.status, 'faulted');
    assert.deepEqual(sent, [], 'no output was delivered');
    // The first reaction body writes this public marker, so an all-zero marker proves
    // that its body never started even though the faulted board never runs sync again.
    assert.deepEqual(Array.from(context.memory.marker), [0, 0, 0, 0]);
  } finally {
    board.dispose();
  }
});
