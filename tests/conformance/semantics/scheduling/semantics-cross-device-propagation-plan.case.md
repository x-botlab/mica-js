---
kind: simulation
---

# Cross-device propagation preserves ordered capture rounds and branch subscriptions

## 规范来源

[Scheduling](../../../../docs/spec/execution/scheduling.rst) and
[electrical publication](../../../../docs/spec/electrical.rst).

## 验收义务

One sender drives three receivers through shared electrical nets. Each receiver has
multiple captures and ordered reaction bodies; their relay writes jointly change a
second shared net only in the following publication round. All receivers must see
the same old relay sample during the first round and the new sample in the next.
Derived observations switch branches when both branches have equal values, then
ignore changes to the inactive branch and react to the newly active branch.

Run fresh boards with whole and sliced advancement, both with and without an extra
sample observer. Check every message, timestamp, declaration order, capture value,
ordinary state read and relay round against an independent trace. The extra observer
has its own counter/output effects but must not perturb the existing reactions.
Initial baseline establishment must not run capture bodies or relay reactions.
An additional 66 distinct derived observations verify ordered activations across
31/32 and 63/64 boundaries without inspecting runtime slots. Simultaneous changes
to the selector and both data pins must produce no duplicate activation and must
still update dependencies when the selected value stays equal.

## 模型

```ddl
device Propagation(identity: number default 0) {
  pin supply;
  pin reference;
  pin left(low: 0.8, high: 2.0);
  pin right(low: 0.8, high: 2.0);
  pin select(low: 0.8, high: 2.0);
  pin relay(low: 0.8, high: 2.0) = [resistor(to: reference, resistance: 1000)];
  record Trace {
    kind: number;
    before: number;
    after: number;
    saved: number;
    live: number;
    peer: number;
  }
  output channel out: Trace(capacity: 128);
  output channel audit: number(capacity: 32);
  record SlotTrace { slot: number; before: number; after: number; captured: number; live: number; }
  output channel slots: SlotTrace(capacity: 512);
  state stamp: number = 0;
  state audits: number = 0;
  pure fn leftBit() -> number {
    if left.sample.level == Logic.high { return 1; }
    return 0;
  }
  pure fn relayBit() -> number {
    if relay.sample.level == Logic.high { return 1; }
    return 0;
  }
  pure fn selected() -> number {
    if select.sample.level == Logic.high {
      if right.sample.level == Logic.high { return 1; }
      return 0;
    }
    return leftBit();
  }
  derived chosen: number = selected();
  derived relayed: number = relayBit();
  reaction direct on left.sample.level as (previous, current) capture saved = stamp, peer = relayBit() {
    if identity > 0 && previous != Logic.unknown {
      stamp = stamp + 1;
      out.send({kind: 1, before: 1 - leftBit(), after: leftBit(), saved: saved, live: stamp, peer: peer});
    }
  }
  reaction first on chosen as (previous, current) capture saved = stamp, peer = relayBit() {
    if identity > 0 {
      stamp = stamp + 10;
      if current == 1 { relay.intent <- [resistor(to: supply, resistance: 1000)]; }
      else { relay.intent <- [resistor(to: reference, resistance: 1000)]; }
      out.send({kind: 2, before: previous, after: current, saved: saved, live: stamp, peer: peer});
    }
  }
  reaction second on chosen as (previous, current) capture saved = stamp, peer = relayBit() {
    if identity > 0 {
      assert peer == relayBit();
      out.send({kind: 3, before: previous, after: current, saved: saved, live: stamp, peer: relayBit()});
    }
  }
  reaction downstream on relayed as (previous, current) capture saved = stamp, peer = relayBit() {
    if identity > 0 {
      out.send({kind: 4, before: previous, after: current, saved: saved, live: stamp, peer: peer});
    }
  }
  // SLOT_OBSERVERS
  // EXTRA_OBSERVER
  process start {
    if identity == 0 {
      left.intent <- [resistor(to: reference, resistance: 1000)];
      right.intent <- [resistor(to: reference, resistance: 1000)];
      select.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      select.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      select.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      select.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      select.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: reference, resistance: 1000)];
      right.intent <- [resistor(to: supply, resistance: 1000)];
      select.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      left.intent <- [resistor(to: supply, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: reference, resistance: 1000)];
      await ticks(1);
      right.intent <- [resistor(to: supply, resistance: 1000)];
      select.intent <- [resistor(to: reference, resistance: 1000)];
    }
  }
}
```

## 装配

```json
{
  "instances": [
    { "id": "sender", "type": "probe", "props": { "identity": 0 } },
    { "id": "receiver1", "type": "probe", "props": { "identity": 1 } },
    { "id": "receiver2", "type": "probe", "props": { "identity": 2 } },
    { "id": "receiver3", "type": "probe", "props": { "identity": 3 } }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device } = await importModule('../fixture.mjs');
const assembled = {
  instances: description.instances,
  nets: ['supply', 'reference', 'left', 'right', 'select', 'relay'].map((pin) => ({
    id: pin,
    pins: description.instances.map(({ id }) => ({ instance: id, pin })),
    ...(pin === 'supply' ? { voltage: 3.3 } : pin === 'reference' ? { voltage: 0 } : {}),
  })),
};
const extra = `reaction extra on left.sample as (previous, current) {
  if identity > 0 { audits = audits + 1; audit.send(audits); }
}`;
const slotObservers = Array.from(
  { length: 66 },
  (_, slot) => `
  derived slot${slot}: number = chosen + ${slot};
  reaction slotObserver${slot} on slot${slot} as (previous, current) capture saved = stamp {
    if identity > 0 {
      slots.send({slot: ${slot}, before: previous - ${slot}, after: current - ${slot}, captured: saved, live: stamp});
    }
  }
`,
).join('\n');
const results = [];
for (const observed of [false, true]) {
  const model = await adapter.compileDDL(
    modelSource
      .replace('// SLOT_OBSERVERS', slotObservers)
      .replace('// EXTRA_OBSERVER', observed ? extra : ''),
  );
  for (const sliced of [false, true]) {
    const delivered = Array.from({ length: 4 }, () => ({ out: [], audit: [], slots: [] }));
    const { board } = await device(
      adapter,
      model,
      {
        sync(batch, context) {
          for (const name of ['out', 'audit', 'slots']) {
            delivered[context.props.identity][name].push(...batch.outputs[name]);
          }
        },
      },
      assembled,
    );
    t.after(() => board.dispose());
    board.runUntil(0);
    assert.ok(delivered.every(({ out, slots }) => out.length === 0 && slots.length === 0));
    assert.deepEqual(
      delivered.map(({ audit }) => audit.length),
      observed ? [0, 1, 1, 1] : [0, 0, 0, 0],
    );
    const prefixes = [];
    if (sliced) {
      for (let time = 1; time <= 17; time++) {
        board.runUntil(time);
        assert.equal(board.time, time);
        assert.equal(board.status, 'ready');
        prefixes.push(
          delivered.map(({ out, slots }) => ({ out: out.slice(), slots: slots.slice() })),
        );
      }
    } else {
      board.runUntil(17);
    }
    results.push({ observed, sliced, delivered, prefixes });
    assert.equal(board.time, 17);
    assert.equal(board.status, 'ready');
    board.dispose();
  }
}
```

## 断言

```typescript
const expected = [];
const expectedSlots = [];
const emit = (time, kind, before, after, saved, live, peer) => {
  expected.push({ time, value: { kind, before, after, saved, live, peer } });
};
let stamp = 0;
let relay = 0;
let left = 0;
for (let time = 1; time <= 17; time++) {
  const captured = stamp;
  if ([1, 4, 8, 11, 13, 14, 15].includes(time)) {
    const next = 1 - left;
    emit(time, 1, left, next, captured, ++stamp, relay);
    left = next;
  }
  if ([1, 5, 8, 10, 13, 16, 17].includes(time)) {
    const next = 1 - relay;
    stamp += 10;
    emit(time, 2, relay, next, captured, stamp, relay);
    emit(time, 3, relay, next, captured, stamp, relay);
    emit(time, 4, relay, next, stamp, stamp, next);
    for (let slot = 0; slot < 66; slot++) {
      expectedSlots.push({
        time,
        value: { slot, before: relay, after: next, captured, live: stamp },
      });
    }
    relay = next;
  }
}
for (const result of results) {
  assert.deepEqual(result.delivered[0], { out: [], audit: [], slots: [] });
  for (let receiver = 1; receiver <= 3; receiver++) {
    assert.deepEqual(result.delivered[receiver].out, expected);
    assert.deepEqual(result.delivered[receiver].slots, expectedSlots);
    assert.deepEqual(
      result.delivered[receiver].audit,
      result.observed
        ? [0, 1, 4, 8, 11, 13, 14, 15].map((time, index) => ({ time, value: index + 1 }))
        : [],
    );
  }
  result.prefixes.forEach((prefix, index) => {
    assert.deepEqual(prefix[0], { out: [], slots: [] });
    for (let receiver = 1; receiver <= 3; receiver++) {
      assert.deepEqual(
        prefix[receiver].out,
        expected.filter(({ time }) => time <= index + 1),
      );
      assert.deepEqual(
        prefix[receiver].slots,
        expectedSlots.filter(({ time }) => time <= index + 1),
      );
    }
  });
}
assert.equal(stamp, 77);
```
