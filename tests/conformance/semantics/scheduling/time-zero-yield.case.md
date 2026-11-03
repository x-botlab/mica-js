---
format: mica-case/v1
id: atomic-time-zero-yield
kind: simulation
---

# 零等待发布后恢复但不推进时间

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> ``await ticks(0)`` 必须结束当前片段，仿真时间保持不变。

## 验收义务

前提：启动过程把 `x` 从 0 改为 1 后等待 0 ps；同步边界反应订阅 `x` 的变化并输出 1，启动过程在恢复后输出 2。

操作：通过真实 adapter 编译模型并推进到 0，收集输出。

预期：交付顺序为 [1, 2]，即反应闭包先于恢复执行；板时间仍为 0。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  state x: number = 0; reaction changed on x as (old, current) { out.send(1); }
  process start { x = 1; await ticks(0); out.send(2); }
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
assert.deepEqual(values(batches), [1, 2]);
assert.equal(board.time, 0);
```
