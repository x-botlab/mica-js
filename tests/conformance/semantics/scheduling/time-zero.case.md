---
kind: simulation
---

# 首次推进时间为零

## 规范来源

[docs/spec/execution/index.rst](../../../../docs/spec/execution/index.rst)

<!-- prettier-ignore -->
> 仿真时间使用 ``number`` 表示整数皮秒，分辨率为 1 ps，起点为 0。

## 验收义务

前提：启动过程立即发送 `now()`。

操作：通过真实 adapter 编译模型并首次推进到 0，读取板时间、输出值与消息时间。

预期：板时间为 0，唯一输出值为 0，发送时间也为 0。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);

  process start {
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
board.runUntil(0);
```

## 断言

```typescript
assert.equal(board.time, 0);
assert.deepEqual(values(batches), [0]);
assert.deepEqual(
  messages(batches).map((m) => m.time),
  [0],
);
```
