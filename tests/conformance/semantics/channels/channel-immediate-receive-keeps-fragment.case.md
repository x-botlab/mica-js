---
kind: simulation
---

# 非空队列的接收不结束同步片段

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 从非空 FIFO 接收消息立即返回，仍在当前片段；从空 FIFO 接收消息实际挂起，结束该片段。

## 验收义务

前提：首批暂存两条输入 1、2 与一次 `wake` 通知；启动过程连续接收两次并各发送一次，通知过程发送 99。

操作：通过真实 adapter 编译模型并推进到 0，收集输出通道的全部消息。

预期：输出为 [1, 2, 99]；两次立即接收都留在启动过程片段内，通知过程按入队顺序在启动过程结束之后运行。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  input channel incoming: number(capacity: 4);
  input notification wake;
  output channel out: number(capacity: 8);
  process start {
    let first = await incoming.receive();
    out.send(first);
    let second = await incoming.receive();
    out.send(second);
  }
  process notified on wake {
    out.send(99);
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
const { device, messages } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    create(ctx) {
      ctx.inputs.incoming.send(1);
      ctx.inputs.incoming.send(2);
      ctx.inputs.wake.notify();
    },
  },
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
const delivered = messages(batches);
assert.deepEqual(
  delivered.map((message) => message.value),
  [1, 2, 99],
);
assert.deepEqual(
  delivered.map((message) => message.time),
  [0, 0, 0],
);
assert.equal(board.time, 0);
assert.equal(board.status, 'ready');
```
