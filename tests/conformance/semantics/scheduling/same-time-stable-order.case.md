---
kind: simulation
---

# 同刻入口按稳定声明顺序执行

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 阶段内已经就绪的入口保持稳定入队顺序。同时产生的一组入口按稳定实例顺序和入口顺序入队；这些顺序来自装配和声明或注册顺序。

## 验收义务

前提：同一实例声明两个通知过程，过程 `a` 订阅 `first`、过程 `b` 订阅 `second`；两个通知都在首批就绪，各过程等待 2 ps 后输出自己的编号 1 或 2。

操作：注入两个通知并把仿真推进到 2 ps，收集输出消息及其发送时间。

预期：2 ps 时交付两个输出，顺序为 [1, 2]，两条消息的发送时间均为 2。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  input notification first;
  input notification second;
  process a on first {
    await ticks(2);
    out.send(1);
  }
  process b on second {
    await ticks(2);
    out.send(2);
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
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
context.inputs.first.notify();
context.inputs.second.notify();
board.runUntil(2);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2]);
assert.deepEqual(
  messages(batches).map((m) => m.time),
  [2, 2],
);
```
