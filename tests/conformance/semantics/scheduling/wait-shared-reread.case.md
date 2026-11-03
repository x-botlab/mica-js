---
kind: simulation
---

# 等待后重新读取共享状态

## 规范来源

[docs/spec/execution/index.rst](../../../../docs/spec/execution/index.rst)

<!-- prettier-ignore -->
> 入口实际挂起时保存恢复位置和局部值，满足恢复条件后从该位置继续。恢复 MUST NOT 重复已经执行的前缀操作。

## 验收义务

前提：`state x` 的初值为 1；启动过程等待 3 ps 后读取并发送 `x`；等待期间通知过程把 `x` 改为 9。

操作：先推进到 1，注入通知；再推进到 3，收集输出。

预期：恢复后重新读取共享状态，唯一输出为等待期间生效的值 9。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  state x: number = 1;
  input notification update;
  process change on update {
    x = 9;
  }
  process start {
    await ticks(3);
    out.send(x);
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
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(1);
context.inputs.update.notify();
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(values(batches), [9]);
```
