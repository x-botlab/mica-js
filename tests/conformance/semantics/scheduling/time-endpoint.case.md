---
kind: simulation
---

# 普通定时过程在终点执行

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> ``runUntil(T)`` 将耗时推进到 ``T``，并处理 ``T`` 到期的普通模型事件、输入事件及全部同步边界反应闭包，完成后才允许本批 sync。sync 不重新进入模型执行。

## 验收义务

前提：启动过程等待 3 ps 后发送 `now()`。

操作：先推进到 2 ps 并观察输出，再推进到 3 ps 并观察输出。

预期：2 ps 时没有输出；3 ps 时交付唯一值 3，消息时间为 3。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  process start {
    await ticks(3);
    out.send(now());
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
const { device, values, messages } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(2);
assert.deepEqual(values(batches), []);
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(values(batches), [3]);
assert.equal(messages(batches)[0].time, 3);
```
