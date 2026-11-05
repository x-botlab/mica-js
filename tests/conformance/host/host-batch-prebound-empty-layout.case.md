---
kind: simulation
---

# host-batch-prebound-empty-layout

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

## 验收义务

前提：两个实例声明交错排列的输出通道和通知；输入含字节快照及未读消息。

操作：同一时间反复推进，覆盖空、非空、空批次、sync 暂存输入和仅通知批次。

预期：每次均交付新批次，输出键保持通道先于通知的原顺序；空输出可复用且不可变，非空消息和字节快照独立，通知在交付后复位，未读输入清理而 sync 暂存输入保留。

## 模型

<!-- prettier-ignore -->
```ddl
device BatchLayout {
  input channel incoming: bytes(maxLength: 4, capacity: 4);
  input notification wake;
  input notification ping;
  output notification zNotice;
  output channel zOut: bytes(maxLength: 4, capacity: 4);
  output notification aNotice;
  output channel aOut: bytes(maxLength: 4, capacity: 4);
  process emit on wake {
    let payload = await incoming.receive();
    zOut.send(payload);
    aOut.send(payload);
    zNotice.notify();
  }
  process notifyOnly on ping {
    aNotice.notify();
  }
}
```

## 装配

```json
{
  "instances": [
    { "id": "a", "type": "probe" },
    { "id": "b", "type": "probe" }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const contexts = [];
const batches = [[], []];
const deliveries = [];
const library = adapter.createDeviceLibrary([
  {
    id: 'probe',
    model: await adapter.compileDDL(modelSource),
    create(ctx) {
      const index = contexts.length;
      contexts.push(ctx);
      return {
        sync(batch) {
          batches[index].push(batch);
          deliveries.push(index);
          if (index === 0 && batches[index].length === 3) {
            ctx.inputs.incoming.send(new Uint8Array([3, 4]));
            ctx.inputs.wake.notify();
          }
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, description);
t.after(board.dispose.bind(board));

board.runUntil(0);
const parent = new Uint8Array([90, 1, 2, 91]);
contexts[0].inputs.incoming.send(parent.subarray(1, 3));
contexts[0].inputs.incoming.send(new Uint8Array([99]));
contexts[0].inputs.wake.notify();
parent.fill(8);
board.runUntil(0);
board.runUntil(0);
board.runUntil(0);
board.runUntil(0);
contexts[1].inputs.ping.notify();
board.runUntil(0);
board.runUntil(0);
```

## 断言

```typescript
assert.equal(board.time, 0);
assert.deepEqual(deliveries, Array.from({ length: 7 }, () => [0, 1]).flat());
for (const history of batches) {
  assert.equal(history.length, 7);
  assert.equal(new Set(history).size, 7);
  for (const batch of history) {
    assert.equal(batch.from, 0);
    assert.equal(batch.to, 0);
    assert(Object.isFrozen(batch));
    assert(Object.isFrozen(batch.outputs));
    assert.equal(Object.getPrototypeOf(batch.outputs), null);
    assert.deepEqual(Object.keys(batch.outputs), ['zOut', 'aOut', 'zNotice', 'aNotice']);
    for (const name of ['zOut', 'aOut']) {
      assert(Object.isFrozen(batch.outputs[name]));
      for (const message of batch.outputs[name]) {
        assert(Object.isFrozen(message));
        assert.equal(message.time, 0);
      }
    }
    for (const name of ['zNotice', 'aNotice']) {
      if (batch.outputs[name] !== null) assert(Object.isFrozen(batch.outputs[name]));
    }
  }
}
const [empty, first, emptyAgain, second, emptyAfterSecond] = batches[0];
for (const batch of [empty, emptyAgain, emptyAfterSecond, batches[0][5], batches[0][6]]) {
  assert.deepEqual(batch.outputs.zOut, []);
  assert.deepEqual(batch.outputs.aOut, []);
  assert.equal(batch.outputs.zNotice, null);
  assert.equal(batch.outputs.aNotice, null);
}
assert.notStrictEqual(first.outputs, empty.outputs);
assert.notStrictEqual(second.outputs, first.outputs);
assert.deepEqual([...first.outputs.zOut[0].value], [1, 2]);
assert.deepEqual([...first.outputs.aOut[0].value], [1, 2]);
assert.deepEqual([...second.outputs.zOut[0].value], [3, 4]);
assert.deepEqual([...second.outputs.aOut[0].value], [3, 4]);
assert.deepEqual(first.outputs.zNotice, { time: 0 });
assert.deepEqual(second.outputs.zNotice, { time: 0 });
assert.notStrictEqual(first.outputs.zNotice, second.outputs.zNotice);
assert.notStrictEqual(first.outputs.zOut, second.outputs.zOut);
assert.notStrictEqual(first.outputs.zOut[0], second.outputs.zOut[0]);
assert.notStrictEqual(first.outputs.zOut[0].value, second.outputs.zOut[0].value);
assert.notStrictEqual(first.outputs.zOut[0].value, first.outputs.aOut[0].value);
assert.throws(() => { empty.outputs.zOut = [1]; }, TypeError);
assert.throws(() => { first.outputs.zOut.push({}); }, TypeError);
assert.throws(() => { first.outputs.zOut[0].time = 99; }, TypeError);
assert.throws(() => { first.outputs.zOut[0].value[0] = 99; }, TypeError);
const ownBytes = first.outputs.zOut[0].value.slice();
ownBytes.fill(99);
for (let i = 0; i < batches[1].length; i++) {
  const outputs = batches[1][i].outputs;
  assert.deepEqual(outputs.zOut, []);
  assert.deepEqual(outputs.aOut, []);
  assert.equal(outputs.zNotice, null);
  assert.deepEqual(outputs.aNotice, i === 5 ? { time: 0 } : null);
}
board.dispose();
assert.deepEqual([...first.outputs.zOut[0].value], [1, 2]);
assert.deepEqual([...second.outputs.zOut[0].value], [3, 4]);
assert.deepEqual(empty.outputs.zOut, []);
assert.equal(batches[1][6].outputs.aNotice, null);
```
