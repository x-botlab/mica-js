---
format: mica-case/v1
id: semantics-reaction-distinct-publication-edge-pairs
kind: simulation
---

# semantics-reaction-distinct-publication-edge-pairs

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：x初值0，两个片段分别改为1和2。

操作：ticks(0)分隔发布轮，推进至0。

预期：输出previous/current序列[0,1,1,2]，板时间仍0。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe { output channel out: number(capacity: 32);
        state x: number = 0;
        reaction observe on x as (old, current) { out.send(old); out.send(current); }
        process start { x = 1; await ticks(0); x = 2; }
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
assert.deepEqual(values(batches), [0, 1, 1, 2]);
assert.equal(board.time, 0);

board.dispose();
```
