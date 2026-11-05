---
kind: comparison
---

# UART 回环位时序与下一批输入

## 规范来源

[通道与批次](../../../docs/spec/channels.rst)、[调度](../../../docs/spec/execution/scheduling.rst)、[生命周期](../../../docs/spec/javascript/lifecycle.rst)。

## 验收义务

真实 UART 模型 TX/RX 接在同一网络，bitTime=10ps。通过配对适配器的话题发送父数组子视图，随后修改父数组。独立检查 0x55 的 LSB-first 电平，首帧在 95ps 的停止位中心收到。sync 中发送第二个字节只能进入下一推进批次；重复推进同一目标仍可处理新普通输入。销毁后旧端点失效，已交付消息保持可读。

## 对照输入

```json
{"bitTime": 10, "first": 85, "second": 163}
```

## 执行步骤

```typescript
const { fixture, assemble, endpoint, net, rails, advance } = await importModule('./support.mjs');
const { createUart } = await importModule('./uart/uart-adapter.js');
const model = await fixture(adapter, 'uart');
const readings = [];
const batches = [];
let context;
let disposed = 0;
let replied = false;
const board = await assemble(adapter, [{
  id: 'uart', model,
  create(ctx) {
    context = ctx;
    const paired = createUart(ctx);
    return {
      sync(batch) {
        batches.push(batch);
        paired.sync(batch);
        if (!replied && batch.outputs.received.length) {
          replied = true;
          ctx.topics.publish('uart/transmit', new Uint8Array([inputs.second]));
        }
      },
      dispose() { disposed++; paired.dispose(); },
    };
  },
}], {
  instances: [{ id: 'dut', type: 'uart', props: { bitTime: inputs.bitTime } },
    { id: 'tx', type: 'probe-tx' }],
  nets: [...rails(['dut']), net('loopback', [endpoint('dut', 'tx'), endpoint('dut', 'rx'),
    endpoint('tx', 'measured')])],
}, { tx: readings });
t.after(() => board.dispose());
const parent = new Uint8Array([255, inputs.first, 0]);
board.topics.publish('uart/transmit', parent.subarray(1, 2));
parent.fill(0);
for (const time of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 94]) advance(board, time);
assert.deepEqual(batches.flatMap((batch) => batch.outputs.received), []);
advance(board, 106);
const firstDelivery = batches.flatMap((batch) => batch.outputs.received);
assert.deepEqual(firstDelivery, [{ time: 95,
  value: { value: inputs.first, framingError: false, unknown: false } }]);
assert.equal(replied, true);
advance(board, 106);
assert.deepEqual(batches.flatMap((batch) => batch.outputs.received), firstDelivery);
advance(board, 202);
```

## 断言

```typescript
assert.deepEqual(readings.filter(({ time }) => time > 0 && time <= 90)
  .map(({ time, value }) => [time, value.high]), [
  [10, true], [20, false], [30, true], [40, false], [50, true],
  [60, false], [70, true], [80, false], [90, true],
]);
assert.deepEqual(batches.flatMap((batch) => batch.outputs.received), [
  { time: 95, value: { value: inputs.first, framingError: false, unknown: false } },
  { time: 201, value: { value: inputs.second, framingError: false, unknown: false } },
]);
assert.deepEqual(batches.flatMap((batch) => batch.outputs.txDropped), []);
board.dispose();
board.dispose();
assert.equal(disposed, 1);
assert.equal(board.status, 'disposed');
assert.throws(() => context.inputs.transmit.send(new Uint8Array([1])),
  (error) => error.code === 'OBJECT_DISPOSED');
assert.equal(firstDelivery[0].value.value, inputs.first);
```
