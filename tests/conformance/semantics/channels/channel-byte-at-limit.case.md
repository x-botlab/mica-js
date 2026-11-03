---
kind: simulation
---

# 字节负载允许恰好上限

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 普通字节值的类型为 ``bytes``。字节通道通过 ``maxLength`` 声明每条消息的最大字节数，实际长度允许为 0 至该上限；其他负载类型的通道不能声明 ``maxLength``。

## 验收义务

前提：输出字节通道的 `maxLength` 为 2、`capacity` 为 1，启动过程发送唯一一条两字节消息。

操作：通过真实 adapter 编译模型并首次推进到 0，收集输出通道交付的字节消息。

预期：交付一条内容为 [1, 2] 的字节消息，实际长度恰好等于上限。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: bytes(maxLength: 2, capacity: 1);
  process start {
    out.send(bytes[1, 2]);
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
assert.deepEqual(
  values(batches).map((v) => [...v]),
  [[1, 2]],
);
```
