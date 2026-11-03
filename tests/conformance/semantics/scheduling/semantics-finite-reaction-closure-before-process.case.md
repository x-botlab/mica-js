---
kind: simulation
---

# semantics-finite-reaction-closure-before-process

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：反应最多将x从1递增到3，普通过程也观察x。

操作：推进到0并收集两个输出FIFO。

预期：反应输出[1,2,3]，普通过程只输出[3]；不运行不终止闭包。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  output channel out: number(capacity: 32);
  output channel ordinary: number(capacity: 8);
  state x: number = 0;
  reaction advance on x as (old, current) {
    out.send(current);
    if current < 3 {
      x = current + 1;
    }
  }
  process observe on x {
    ordinary.send(x);
  }
  process start {
    x = 1;
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
assert.deepEqual(values(batches), [1, 2, 3]);
assert.deepEqual(values(batches, 'ordinary'), [3]);

board.dispose();
```
