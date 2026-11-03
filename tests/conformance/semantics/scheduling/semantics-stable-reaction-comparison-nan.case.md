---
kind: simulation
---

# semantics-stable-reaction-comparison-nan

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> number 的 NaN 与 NaN 视为相同，正负零视为相同，其余按数值比较。

## 验收义务

前提：`state x` 的初值为 NaN；启动过程先把 `x` 再赋为 NaN，经过零时边界后再赋为 2。

操作：通过真实 adapter 编译模型并推进到 0，收集反应体输出。

预期：只交付一条输出；NaN 与 NaN 比较相同而不产生额外触发，随后改为 2 时触发一次。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  output channel out: number(capacity: 32);
  record Pair {
    n: number;
    flag: bool;
  }
  state x: number = NaN;
  reaction observe on x as (old, current) {
    out.send(1);
  }
  process start {
    x = NaN;
    await ticks(0);
    x = 2;
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
assert.deepEqual(values(batches), [1]);

board.dispose();
```
