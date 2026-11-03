---
kind: simulation
---

# 默认溢出策略保留已有消息

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> ``overflow`` 省略时采用 ``Overflow.drop_new``。策略只适用于通过负载校验的消息。

## 验收义务

前提：输出 `number` 通道的 `capacity` 为 2 且省略 `overflow`，启动过程依次发送 1、2、3。

操作：通过真实 adapter 编译模型并推进到 0，收集输出通道交付的消息。

预期：交付 [1, 2]；新消息 3 被丢弃，已有队列保持不变。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 2);
  process start {
    out.send(1);
    out.send(2);
    out.send(3);
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
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2]);
```
