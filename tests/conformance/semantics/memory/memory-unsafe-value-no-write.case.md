---
format: mica-case/v1
id: atomic-memory-unsafe-value-no-write
kind: simulation
---

# 非安全整数写入不修改字节

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 写入值 MUST 是安全整数。操作取相应宽度的低位作为写入内容，负值采用相同转换。

## 验收义务

前提：单字节公开 `memory` 先成功写入 17，再尝试写入 9_007_199_254_740_992，该值超出安全整数范围。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：第二次写入报告执行故障，公开字节仍为 [17]，不先截取低位写入。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[1];
  process start { store8(data, 0, 17); store8(data, 0, 9_007_199_254_740_992); }
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
const { board, context } = await device(
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
assert.deepEqual([...context.memory.data], [17]);
```
