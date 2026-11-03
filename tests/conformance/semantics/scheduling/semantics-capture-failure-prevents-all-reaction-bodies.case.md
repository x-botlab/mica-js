---
kind: simulation
---

# semantics-capture-failure-prevents-all-reaction-bodies

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

[docs/spec/errors.rst](../../../../docs/spec/errors.rst)

## 验收义务

前提：第二个捕获中的断言必定失败，启动已写入公开字节1。

操作：推进至0并观察执行故障、公开memory和sync次数。

预期：板故障、字节仍为1且没有sync；不声明失败轮采样的完整覆盖。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  state trigger: number = 0;
  state allowed: bool = false;
  public memory evidence[1];
  pure fn checked() -> number {
    assert allowed;
    return 1;
  }
  reaction first on trigger as (old, current) {
    store8(evidence, 0, 2);
  }
  reaction second on trigger as (old, current) capture saved = checked() {
    store8(evidence, 0, saved);
  }
  process start {
    store8(evidence, 0, 1);
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
assert.deepEqual([...context.memory.evidence], [1]);
assert.equal(batches.length, 0);

board.dispose();
```
