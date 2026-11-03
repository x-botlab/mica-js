---
format: mica-case/v1
id: atomic-channel-validation-before-drop
kind: simulation
---

# 满队列仍先校验字节长度

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 发送 MUST 先校验类型、字段、字节范围及实际长度，再应用溢出策略。即使队列已满，非法消息仍先报告校验错误。

## 验收义务

前提：输出字节通道的 `maxLength` 为 1、`capacity` 为 1 且使用默认 `drop_new`；启动过程先发送合法的 `bytes[1]`，再发送超长的 `bytes[1, 2]`。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：第二条消息先报告校验错误，不会因队列已满而被静默丢弃；本次推进失败且没有 sync 批次。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe { output channel out: bytes(maxLength: 1, capacity: 1); process start { out.send(bytes[1]); out.send(bytes[1, 2]); } }
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
const { device, fault } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
fault(board, () => board.runUntil(0));
```

## 断言

```typescript
assert.equal(batches.length, 0);
```
