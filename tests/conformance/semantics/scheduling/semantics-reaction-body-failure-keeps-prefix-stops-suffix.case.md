---
kind: simulation
---

# semantics-reaction-body-failure-keeps-prefix-stops-suffix

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

[docs/spec/errors.rst](../../../../docs/spec/errors.rst)

## 验收义务

前提：三个反应依次写公开字节，第二体写入后断言失败。

操作：推进至0并读取公开memory。

预期：字节为[1,2,0]且无sync，第三体未执行。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  state trigger: number = 0;
  state allowed: bool = false;
  public memory evidence[3];
  reaction first on trigger as (old, current) {
    store8(evidence, 0, 1);
  }
  reaction second on trigger as (old, current) {
    store8(evidence, 1, 2);
    assert allowed;
  }
  reaction third on trigger as (old, current) {
    store8(evidence, 2, 3);
  }
  process start {
    trigger = 1;
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

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

fault(board, () => board.runUntil(0));
```

## 断言

```typescript
assert.deepEqual([...context.memory.evidence], [1, 2, 0]);
assert.equal(batches.length, 0);

board.dispose();
```
