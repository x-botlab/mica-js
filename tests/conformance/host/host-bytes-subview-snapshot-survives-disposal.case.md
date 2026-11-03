---
kind: simulation
---

# host-bytes-subview-snapshot-survives-disposal

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

## 验收义务

前提：发送父数组中仅含 1、2 的 Uint8Array 子视图，发送后修改父数组。

操作：推进获取输出快照，修改 slice 副本，再推进并销毁板。

预期：快照只含 1、2，不暴露 buffer，长度和越界索引符合断言；修改副本、推进和销毁均不改变已交付内容。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  input channel incoming: bytes(maxLength: 4, capacity: 2);
  output channel out: bytes(maxLength: 4, capacity: 2);
  process start {
    let bytesValue = await incoming.receive();
    out.send(bytesValue);
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('./fixture.mjs');

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
let snapshot;
t.after(board.dispose.bind(board));

const parent = new Uint8Array([90, 1, 2, 91]);
context.inputs.incoming.send(parent.subarray(1, 3));
parent.fill(8);
board.runUntil(0);
snapshot = values(batches)[0];
assert.ok(snapshot);
assert.deepEqual([...snapshot], [1, 2]);
assert.equal(snapshot.length, 2);
assert.equal(snapshot.byteLength, 2);
assert.equal(snapshot[2], undefined);
assert.equal('buffer' in snapshot, false);
const own = snapshot.slice();
assert.ok(own instanceof Uint8Array);
own[0] = 99;
assert.deepEqual([...snapshot], [1, 2]);
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual([...snapshot], [1, 2]);

board.dispose();

assert.deepEqual([...snapshot], [1, 2]);
assert.deepEqual([...snapshot.slice(-1)], [2]);
```
