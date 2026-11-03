---
kind: simulation
---

# 忙碌等待中的过程合并多次通知

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 已开始运行或正在等待 | 设置待再运行标志，不打断当前运行，也不提前恢复等待。

<!-- prettier-ignore -->
> 本次运行结束 | 有标志则清除标志并从头排队一次；否则回到空闲。

[docs/spec/conformance.rst](../../../../docs/spec/conformance.rst)

<!-- prettier-ignore -->
> 反应过程开始后挂起，等待期间多次变化或通知；等待本身随后满足。 | 不重入、不因触发提前恢复；原运行完成后至多补跑一次，按所属阶段队尾排队。

## 验收义务

前提：通知过程首次运行后发送 1 并等待 2 ps；在等待期间的两个批次里各注入一次同一通知。通知共三次。

操作：先推进到 1，两次以同一目标 1 注入通知并推进，再推进到 4，最后推进到 10。

预期：输出恰为四条：等待不被打断且不提前恢复；前两次等待期通知合并成一个待再运行标志，因此只有一次补跑；补跑从头运行并同样等待 2 ps，时间戳为 0、2、2、4。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  input notification wake;
  output channel out: number(capacity: 8);
  process pulse on wake {
    out.send(1);
    await ticks(2);
    out.send(2);
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
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    create(ctx) {
      ctx.inputs.wake.notify();
    },
  },
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(1);
context.inputs.wake.notify();
board.runUntil(1);
context.inputs.wake.notify();
board.runUntil(1);
board.runUntil(4);
board.runUntil(10);
```

## 断言

```typescript
const delivered = messages(batches);
assert.deepEqual(
  delivered.map((message) => [message.time, message.value]),
  [
    [0, 1],
    [2, 2],
    [2, 1],
    [4, 2],
  ],
);
assert.equal(board.time, 10);
assert.equal(board.status, 'ready');
```
