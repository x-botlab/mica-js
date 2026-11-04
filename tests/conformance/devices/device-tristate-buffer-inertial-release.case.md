---
kind: comparison
---

# Tristate buffer inertial cancellation and electrical release

## 规范来源

[Electrical release](../../../docs/spec/electrical.rst),
[scheduling](../../../docs/spec/execution/scheduling.rst), and
[fixture policy](./tristate-buffer/tristate-buffer.ddl).

## 验收义务

The output has equal 10 kohm pull-up/down branches: release gives 1.65 V,
not a driven low. With a 4 ps inertial delay, cancel a short enable pulse,
commit a sustained high, cancel a short low pulse, release, then drive low.
Check both sides of deadlines and retain a delivered snapshot after disposal.

## 对照输入

```json
{ "fixture": "tristate-buffer", "props": { "propagationDelay": 4 } }
```

## 执行步骤

```typescript
const { fixture, assemble, advance, reading, level, endpoint, net, rails, passive } =
  await importModule('./support.mjs');
const { pinDriver } = await importModule('./smoke-support.mjs');
const driver = await pinDriver(adapter, ['data', 'enable']);
const load = await adapter.compileDDL(`device Load {
  pin y = [resistor(to: supply, resistance: 10000), resistor(to: reference, resistance: 10000)];
  pin supply;
  pin reference;
}`);
const y = [];
const board = await assemble(
  adapter,
  [
    { id: 'dut', model: await fixture(adapter, inputs.fixture), create: passive },
    driver.entry,
    { id: 'load', model: load, create: passive },
  ],
  {
    instances: [
      { id: 'dut', type: 'dut', props: inputs.props },
      { id: 'driver', type: 'driver' },
      { id: 'load', type: 'load' },
      { id: 'y', type: 'probe-y' },
    ],
    nets: [
      ...rails(['dut', 'driver', 'load']),
      ...['data', 'enable'].map((pin) => net(pin, [endpoint('dut', pin), endpoint('driver', pin)])),
      net('y', [endpoint('dut', 'y'), endpoint('load', 'y'), endpoint('y', 'measured')]),
    ],
  },
  { y },
);
t.after(() => board.dispose());
const command = (time, value) => {
  advance(board, time);
  driver.send(value);
  advance(board, time);
};
const released = () => {
  const value = reading(y);
  assert.ok(Math.abs(value.voltage - 1.65) < 1e-9);
  assert.equal(value.high, false);
  assert.equal(value.low, false);
};
```

## 断言

```typescript
advance(board, 0);
released();
command(1, 3);
command(3, 1);
advance(board, 5);
released();
assert.equal(y.filter((message) => message.time > 0).length, 0);
command(6, 3);
advance(board, 9);
released();
advance(board, 10);
level(y, true);
assert.ok(Math.abs(reading(y).voltage - (3.3 * 401) / 402) < 1e-9);
command(11, 2);
command(13, 3);
advance(board, 15);
level(y, true);
command(16, 1);
advance(board, 19);
level(y, true);
advance(board, 20);
released();
command(21, 2);
advance(board, 24);
released();
advance(board, 25);
level(y, false);
assert.ok(Math.abs(reading(y).voltage - 3.3 / 402) < 1e-9);
assert.deepEqual(
  y.filter((message) => message.time > 0).map(({ time }) => time),
  [10, 20, 25],
);
const snapshot = y.at(-1);
board.dispose();
assert.equal(board.status, 'disposed');
assert.equal(snapshot.time, 25);
assert.equal(snapshot.value.low, true);
assert.throws(() => board.runUntil(26), { code: 'OBJECT_DISPOSED' });
```
