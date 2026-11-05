---
kind: comparison
---

# Counter PWM buffers duty and handles zero and full scale

## 规范来源

[Memory](../../../docs/spec/memory.rst),
[channels](../../../docs/spec/channels.rst), and
[fixture policy](./counter-pwm/counter-pwm.ddl).

## 验收义务

With a 2 ps tick, initial duty 2 produces a falling edge at 4 ps. Host duty
updates remain buffered until the 256-count wrap. Check the public register
bytes and pin together: duty 256 stays high for a complete cycle; duty 0 stays
low, and duty 1 falls one tick after wrap. Check exact compare/wrap timestamps,
no output before first advancement, and input invalidation after disposal.

## 对照输入

```json
{ "fixture": "counter-pwm", "props": { "tickPeriod": 2, "initialDuty": 2 } }
```

## 执行步骤

```typescript
const { fixture, assemble, advance, level, endpoint, net, rails } =
  await importModule('./support.mjs');
let context;
let disposed = 0;
const compared = [];
const wrapped = [];
const pwm = [];
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
            if (batch.outputs.compared) compared.push(batch.outputs.compared.time);
            if (batch.outputs.wrapped) wrapped.push(batch.outputs.wrapped.time);
          },
          dispose() {
            disposed++;
          },
        };
      },
    },
  ],
  {
    instances: [
      { id: 'dut', type: 'dut', props: inputs.props },
      { id: 'pwm', type: 'probe-pwm' },
    ],
    nets: [...rails(['dut']), net('pwm', [endpoint('dut', 'pwm'), endpoint('pwm', 'measured')])],
  },
  { pwm },
);
t.after(() => board.dispose());
const registers = () => [...context.memory.registers];
const duty = (time, value) => {
  advance(board, time);
  context.inputs.duty.send(value);
  advance(board, time);
};
```

## 断言

```typescript
assert.deepEqual(compared, []);
assert.deepEqual(wrapped, []);
advance(board, 0);
assert.deepEqual(registers(), [0, 0, 2, 0]);
level(pwm, true);
advance(board, 3);
assert.deepEqual(registers(), [1, 0, 2, 0]);
level(pwm, true);
advance(board, 4);
level(pwm, false);
assert.deepEqual(compared, [4]);
duty(6, 256);
assert.deepEqual(registers(), [3, 0, 2, 0]);
advance(board, 511);
assert.deepEqual(registers(), [255, 0, 2, 0]);
level(pwm, false);
advance(board, 512);
assert.deepEqual(registers(), [0, 0, 0, 1]);
level(pwm, true);
duty(514, 0);
assert.deepEqual(registers(), [1, 0, 0, 1]);
advance(board, 1023);
assert.deepEqual(registers(), [255, 0, 0, 1]);
level(pwm, true);
advance(board, 1024);
assert.deepEqual(registers(), [0, 0, 0, 0]);
level(pwm, false);
duty(1026, 1);
assert.deepEqual(registers(), [1, 0, 0, 0]);
advance(board, 1535);
level(pwm, false);
advance(board, 1536);
assert.deepEqual(registers(), [0, 0, 1, 0]);
level(pwm, true);
advance(board, 1537);
level(pwm, true);
advance(board, 1538);
assert.deepEqual(registers(), [1, 0, 1, 0]);
level(pwm, false);
assert.deepEqual(wrapped, [512, 1024, 1536]);
assert.deepEqual(compared, [4, 1024, 1538]);
assert.deepEqual(
  pwm.filter((message) => message.time > 0).map(({ time, value }) => [time, value.high]),
  [
    [4, false],
    [512, true],
    [1024, false],
    [1536, true],
    [1538, false],
  ],
);
const snapshot = registers();
board.dispose();
board.dispose();
assert.equal(board.status, 'disposed');
assert.equal(disposed, 1);
assert.deepEqual(snapshot, [1, 0, 1, 0]);
assert.throws(() => context.inputs.duty.send(1), { code: 'OBJECT_DISPOSED' });
```
