---
format: mica-case/v1
id: atomic-memory-zero-length
kind: simulation
---

# 零长度存储拒绝读取

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 长度为 16 的存储允许 ``load8(storage, 15)``，但偏移 16 不足以完成任何整数读写。零长度存储可以声明，对其执行宽度为 1、2 或 4 的读写均因范围不足失败。

## 验收义务

前提：公开 `memory` 的长度为 0，启动过程尝试读取偏移 0 的一个字节。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：读取因范围不足报告执行故障；公开 `memory` 仍为空，且没有 sync 批次。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[0];
  process start { out.send(load8(data, 0)); }
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
const { device, fault } = await importModule('../fixture.mjs');
const { board, context, batches } = await device(
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
assert.deepEqual([...context.memory.data], []);
assert.equal(batches.length, 0);
```
