---
kind: comparison
---

# Bouncing button deterministic retargeting and settling

## 规范来源

[Instance random stream](../../../docs/spec/execution/random.rst),
[channels](../../../docs/spec/channels.rst), and
[fixture policy](./bouncing-button/bouncing-button.ddl).

## 验收义务

Use the published four-word random state, an 8 ps bounce window and fixed 2 ps
intervals. Press at 1 ps, reverse at 4 ps, repeat the release command at 6 ps.
The reversal extends settling from 9 to 12 ps; the duplicate must not extend it.
Observe actual contact voltages, deterministic intermediate bounces and exactly
one settled notification. No JavaScript timing or random source participates.

## 对照输入

```json
{
  "fixture": "bouncing-button",
  "props": { "bounceDuration": 8, "minInterval": 2, "maxInterval": 2 },
  "randomState": [4294967295, 2147483648, 305419896, 2596069104]
}
```

## 执行步骤

```typescript
const { fixture, assemble, advance, reading, level, endpoint, net, passive } =
  await importModule('./support.mjs');
const load = await adapter.compileDDL(`device Load {
  pin contact = [resistor(to: reference, resistance: 1000)];
  pin reference;
}`);
let context;
let disposed = 0;
const settled = [];
const contact = [];
const board = await assemble(
  adapter,
  [
    {
      id: 'dut',
      model: await fixture(adapter, inputs.fixture),
      create(ctx) {
        context = ctx;
        return {
          sync(batch) {
            if (batch.outputs.settled) settled.push(batch.outputs.settled);
          },
          dispose() {
            disposed++;
          },
        };
      },
    },
    { id: 'load', model: load, create: passive },
  ],
  {
    instances: [
      { id: 'dut', type: 'dut', props: inputs.props, randomState: inputs.randomState },
      { id: 'load', type: 'load' },
      { id: 'contact', type: 'probe-contact' },
    ],
    nets: [
      net('source', [endpoint('dut', 'b')], 3.3),
      net('reference', [endpoint('load', 'reference')], 0),
      net('contact', [
        endpoint('dut', 'a'),
        endpoint('load', 'contact'),
        endpoint('contact', 'measured'),
      ]),
    ],
  },
  { contact },
);
t.after(() => board.dispose());
const command = (time, pressed) => {
  advance(board, time);
  context.inputs.pressed.send(pressed);
  advance(board, time);
};
```

## 断言

```typescript
advance(board, 0);
level(contact, false);
assert.deepEqual(settled, []);
command(1, true);
level(contact, true);
assert.ok(Math.abs(reading(contact).voltage - (3.3 * 1000) / 1001) < 1e-9);
advance(board, 3);
level(contact, true);
command(4, false);
command(6, false);
for (const [time, high] of [
  [7, false],
  [9, false],
  [11, true],
]) {
  advance(board, time);
  level(contact, high);
  assert.deepEqual(settled, []);
}
advance(board, 12);
level(contact, false);
assert.equal(reading(contact).voltage, 0);
assert.deepEqual(settled, [{ time: 12 }]);
advance(board, 20);
assert.deepEqual(settled, [{ time: 12 }]);
assert.deepEqual(
  contact.filter((message) => message.time > 0).map(({ time, value }) => [time, value.high]),
  [
    [1, true],
    [7, false],
    [11, true],
    [12, false],
  ],
);
board.dispose();
board.dispose();
assert.equal(disposed, 1);
assert.equal(board.status, 'disposed');
assert.throws(() => context.inputs.pressed.send(true), { code: 'OBJECT_DISPOSED' });
```
