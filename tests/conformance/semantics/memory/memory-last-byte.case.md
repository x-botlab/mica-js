---
format: mica-case/v1
id: atomic-memory-last-byte
kind: simulation
---

# 最后一个字节可读写

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 长度为 16 的存储允许 ``load8(storage, 15)``，但偏移 16 不足以完成任何整数读写。零长度存储可以声明，对其执行宽度为 1、2 或 4 的读写均因范围不足失败。

## 验收义务

前提：存在一个恰好 16 字节的 `memory`。

操作：通过真实 adapter 编译模型并推进到 0；模型向偏移 15 写入 255，再从偏移 15 读取一个字节并输出。

预期：末字节可写可读，唯一输出为 255。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  memory data[16];
  process start { store8(data, 15, 255); out.send(load8(data, 15)); }
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
assert.deepEqual(values(batches), [255]);
```
