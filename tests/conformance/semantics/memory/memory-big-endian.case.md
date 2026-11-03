---
kind: simulation
---

# 非对齐32位大端存储

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> ``le`` 表示小端，低偏移保存低位字节；``be`` 表示大端，低偏移保存高位字节。端序由操作名称显式指定，``memory`` 本身没有端序属性。

## 验收义务

前提：5 字节公开 `memory`，从偏移 1 写入 0x12345678 的十进制值 305419896。

操作：通过真实 adapter 编译模型并推进到 0，读取公开 `memory` 的全部字节。

预期：公开字节为 [0, 18, 52, 86, 120]，即高位字节保存在低偏移。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[5];
  process start {
    store32be(data, 1, 305419896);
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
const { device } = await importModule('../fixture.mjs');
const { board, context } = await device(
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
assert.deepEqual([...context.memory.data], [0, 18, 52, 86, 120]);
```
