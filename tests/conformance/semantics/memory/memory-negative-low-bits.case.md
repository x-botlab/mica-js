---
kind: simulation
---

# 负安全整数按低位存储

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 写入值 MUST 是安全整数。操作取相应宽度的低位作为写入内容，负值采用相同转换。

## 验收义务

前提：2 字节公开 `memory`，以 `store16le` 在偏移 0 写入 -1。

操作：通过真实 adapter 编译模型并推进到 0，读取公开 `memory` 的全部字节。

预期：公开字节为 [255, 255]，负值按 16 位补码的低位保存。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[2];
  process start {
    store16le(data, 0, -1);
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
assert.deepEqual([...context.memory.data], [255, 255]);
```
