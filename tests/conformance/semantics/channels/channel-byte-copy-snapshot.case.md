---
format: mica-case/v1
id: atomic-channel-byte-copy-snapshot
kind: simulation
---

# 发送的存储复制不随存储更新

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 后续存储写入不改变已复制的字节值。

## 验收义务

前提：单字节存储先写入 1，用 `copyBytes` 复制该字节并通过输出通道发送，随后把同一字节改写为 9。

操作：通过真实 adapter 编译模型并推进到 0，收集交付的字节消息。

预期：唯一交付消息的内容仍为 [1]，后续存储写入不改变已复制的快照。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe { memory data[1]; output channel out: bytes(maxLength: 1, capacity: 1); process start { store8(data, 0, 1); out.send(copyBytes(data, 0, 1)); store8(data, 0, 9); } }
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
  [[1]],
);
```
