---
format: mica-case/v1
id: atomic-channel-drop-oldest
kind: simulation
---

# 满队列丢弃最早消息

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 移除最早的一条消息，再接纳本次新消息。

## 验收义务

前提：输出 `number` 通道的 `capacity` 为 2、`overflow` 为 `Overflow.drop_oldest`，启动过程依次发送 1、2、3。

操作：通过真实 adapter 编译模型并推进到 0，收集输出通道交付的消息。

预期：交付 [2, 3]；队首的 1 被移除，新消息 3 被接纳。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe { output channel out: number(capacity: 2, overflow: Overflow.drop_oldest); process start { out.send(1); out.send(2); out.send(3); } }
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
assert.deepEqual(values(batches), [2, 3]);
```
