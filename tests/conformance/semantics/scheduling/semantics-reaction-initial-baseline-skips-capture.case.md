---
kind: simulation
---

# semantics-reaction-initial-baseline-skips-capture

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 建立基线不执行捕获或反应体，也不触发普通过程；求解或源求值失败可在任何启动过程执行前使推进失败。

## 验收义务

前提：`state x` 的初值为 1 且没有变化；捕获函数 `captureValue` 若被执行会因断言失败；启动过程输出 42。

操作：通过真实 adapter 编译模型并首次推进到 0，读取板状态和输出。

预期：板状态为 `ready`，唯一输出为 42；建立观察基线不执行捕获或反应体。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  output channel out: number(capacity: 32);
  state x: number = 1;
  state allowed: bool = false;
  pure fn captureValue() -> number {
    assert allowed;
    return x;
  }
  reaction observe on x as (old, current) capture saved = captureValue() {
    out.send(saved);
  }
  process start {
    out.send(42);
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

const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(0);
```

## 断言

```typescript
assert.equal(board.status, 'ready');
assert.deepEqual(values(batches), [42]);

board.dispose();
```
