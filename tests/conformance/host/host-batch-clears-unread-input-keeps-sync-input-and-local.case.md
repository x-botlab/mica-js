---
kind: simulation
---

# host-batch-clears-unread-input-keeps-sync-input-and-local

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

## 验收义务

前提：暂存输入 1、2，模型接收首条后等待 5 ticks；首轮 sync 暂存 3、4。

操作：依次推进至 0 和 5，记录两个批次的输出与边界。

预期：旧未读输入 2 被清理，sync 新输入保留；局部首值跨等待保留，累计输出为 1、1、3、4。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  input channel incoming: number(capacity: 8);
  output channel out: number(capacity: 8);
  process start {
    let first = await incoming.receive();
    out.send(first);
    await ticks(5);
    out.send(first);
    let second = await incoming.receive();
    out.send(second);
    let third = await incoming.receive();
    out.send(third);
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

let deliveries = 0;
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    sync(batch, ctx) {
      if (deliveries++ === 0) {
        ctx.inputs.incoming.send(3);
        ctx.inputs.incoming.send(4);
      }
    },
  },
  description,
);
t.after(board.dispose.bind(board));

context.inputs.incoming.send(1);
context.inputs.incoming.send(2);
board.runUntil(0);
assert.deepEqual(values(batches), [1]);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 1, 3, 4]);
assert.deepEqual(
  batches.map((batch) => [batch.from, batch.to]),
  [
    [0, 0],
    [0, 5],
  ],
);

board.dispose();
```
