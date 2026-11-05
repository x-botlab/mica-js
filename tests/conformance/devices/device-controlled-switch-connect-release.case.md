---
kind: comparison
---

# Controlled switch connects and releases a loaded contact

## 规范来源

[Electrical intents and thresholds](../../../docs/spec/electrical.rst),
[lifecycle](../../../docs/spec/javascript/lifecycle.rst), and
[fixture policy](./controlled-switch/controlled-switch.ddl).

## 验收义务

A 3.3 V source feeds contact a; contact b has a 1 kohm pull-down. The control
has the fixture's weak pull-down. At integer ps boundaries, drive high, release,
and drive low. Closure must produce the 1 ohm/1 kohm divider voltage; release
must remove the contact branch and return b to zero. Disposal is idempotent.

## 对照输入

```json
{ "fixture": "controlled-switch", "props": { "onResistance": 1 } }
```

## 执行步骤

```typescript
const { fixture, assemble, advance, reading, level, endpoint, net, passive } =
  await importModule('./support.mjs');
const { pinDriver } = await importModule('./smoke-support.mjs');
const driver = await pinDriver(adapter, ['control']);
const load = await adapter.compileDDL(`device Load {
  pin contact = [resistor(to: reference, resistance: 1000)];
  pin reference;
}`);
const output = [];
let disposed = 0;
const board = await assemble(
  adapter,
  [
    {
      id: 'dut',
      model: await fixture(adapter, inputs.fixture),
      create: () => ({
        sync() {},
        dispose() {
          disposed++;
        },
      }),
    },
    driver.entry,
    { id: 'load', model: load, create: passive },
  ],
  {
    instances: [
      { id: 'dut', type: 'dut', props: inputs.props },
      { id: 'driver', type: 'driver' },
      { id: 'load', type: 'load' },
      { id: 'output', type: 'probe-output' },
    ],
    nets: [
      net('supply', [endpoint('driver', 'supply'), endpoint('dut', 'a')], 3.3),
      net(
        'reference',
        [
          endpoint('driver', 'reference'),
          endpoint('dut', 'reference'),
          endpoint('load', 'reference'),
        ],
        0,
      ),
      net('control', [endpoint('driver', 'control'), endpoint('dut', 'control')]),
      net('output', [
        endpoint('dut', 'b'),
        endpoint('load', 'contact'),
        endpoint('output', 'measured'),
      ]),
    ],
  },
  { output },
);
t.after(() => board.dispose());
```

## 断言

```typescript
advance(board, 0);
level(output, false);
assert.equal(reading(output).voltage, 0);
for (const [time, value, mask, high] of [
  [1, 1, 1, true],
  [2, 0, 0, false],
  [3, 1, 1, true],
  [4, 0, 1, false],
]) {
  advance(board, time);
  driver.send(value, mask);
  advance(board, time);
  level(output, high);
  assert.ok(Math.abs(reading(output).voltage - (high ? (3.3 * 1000) / 1001 : 0)) < 1e-9);
  assert.equal(output.at(-1).time, time);
}
board.dispose();
board.dispose();
assert.equal(board.status, 'disposed');
assert.equal(disposed, 1);
assert.throws(() => driver.send(1), { code: 'OBJECT_DISPOSED' });
```
