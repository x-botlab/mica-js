---
kind: simulation
---

# semantics-fragment-final-value-coalesces-process-trigger

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：x初始为0，首片段写1再写0，次片段写1再写2。

操作：经过ticks(0)边界并收集立即读取与观察过程输出。

预期：立即读取[1,0,1,2]，观察过程只输出[2]。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  output channel out: number(capacity: 32);
  output channel reads: number(capacity: 8);
  state x: number = 0;
  process observe on x {
    out.send(x);
  }
  process start {
    x = 1;
    reads.send(x);
    x = 0;
    reads.send(x);
    await ticks(0);
    x = 1;
    reads.send(x);
    x = 2;
    reads.send(x);
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
assert.deepEqual(values(batches), [2]);
assert.deepEqual(values(batches, 'reads'), [1, 0, 1, 2]);

board.dispose();
```
