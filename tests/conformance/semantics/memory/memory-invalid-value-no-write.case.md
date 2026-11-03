---
kind: simulation
---

# 非法写入值保持原字节

## 规范来源

[docs/spec/memory.rst](../../../../docs/spec/memory.rst)

<!-- prettier-ignore -->
> 每次读取或写入同步完成，自身不推进仿真时间。运行时 MUST 在写入前校验全部参数及完整范围；失败时，该次操作不修改任何目标字节。

## 验收义务

前提：单字节公开 `memory` 先成功写入 17，再尝试写入小数 1.5。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：第二次写入报告执行故障，公开字节仍为 [17]。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory data[1];
  process start {
    store8(data, 0, 17);
    store8(data, 0, 1.5);
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
