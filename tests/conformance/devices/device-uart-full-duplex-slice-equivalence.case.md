---
kind: comparison
---

# 双 UART 全双工连线与推进切片

## 规范来源

[电气](../../../docs/spec/electrical.rst)、[通道](../../../docs/spec/channels.rst)、[调度](../../../docs/spec/execution/scheduling.rst)。

## 验收义务

两个真实 UART 实例交叉连接 TX/RX，使用不同数据同时发送两帧。逐实例断言收到对方字节、95ps/195ps 的帧时刻以及零丢弃。一次推进与多次切片都与独立预期比较；输入均在首次推进前入队，UART 的持久 FIFO 必须保存切片间的剩余字节。两板销毁互不影响。

## 对照输入

```json
{"left": [0, 85], "right": [255, 166], "slices": [1, 5, 10, 50, 95, 100, 195, 201]}
```

## 执行步骤

```typescript
const { fixture, endpoint, net, rails } = await importModule('./support.mjs');
const { createUart } = await importModule('./uart/uart-adapter.js');
const model = await fixture(adapter, 'uart');
const runs = [];
for (const targets of [[201], inputs.slices]) {
  const contexts = [];
  const received = [[], []];
  const dropped = [[], []];
  const disposed = [];
  const library = adapter.createDeviceLibrary([{
    id: 'uart', model,
    create(ctx) {
      const index = contexts.length;
      contexts.push(ctx);
      const paired = createUart(ctx);
      return {
        sync(batch) {
          received[index].push(...batch.outputs.received);
          dropped[index].push(...batch.outputs.txDropped);
          paired.sync(batch);
        },
        dispose() { disposed.push(index); paired.dispose(); },
      };
    },
  }]);
  const board = adapter.createBoard(library, {
    instances: ['left', 'right'].map((id) => ({ id, type: 'uart', props: { bitTime: 10 } })),
    nets: [...rails(['left', 'right']),
      net('left-to-right', [endpoint('left', 'tx'), endpoint('right', 'rx')]),
      net('right-to-left', [endpoint('right', 'tx'), endpoint('left', 'rx')])],
  });
  t.after(() => board.dispose());
  contexts[0].inputs.transmit.send(new Uint8Array(inputs.left));
  contexts[1].inputs.transmit.send(new Uint8Array(inputs.right));
  for (const target of targets) {
    board.runUntil(target);
    assert.equal(board.time, target);
    assert.equal(board.status, 'ready');
  }
  runs.push({ board, contexts, received, dropped, disposed });
}
```

## 断言

```typescript
const expected = (bytes) => bytes.map((value, index) => ({ time: 95 + index * 100,
  value: { value, framingError: false, unknown: false } }));
for (const run of runs) {
  assert.deepEqual(run.received, [expected(inputs.right), expected(inputs.left)]);
  assert.deepEqual(run.dropped, [[], []]);
}
assert.deepEqual(runs[0].received, runs[1].received);
runs[0].board.dispose();
assert.deepEqual(runs[0].disposed, [1, 0]);
assert.equal(runs[1].board.status, 'ready');
runs[1].board.runUntil(210);
assert.deepEqual(runs[1].received, [expected(inputs.right), expected(inputs.left)]);
runs[1].board.dispose();
assert.deepEqual(runs[1].disposed, [1, 0]);
```
