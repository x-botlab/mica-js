---
format: mica-case/v1
id: semantics-target-includes-timer-and-reaction-closure
kind: simulation
---

# semantics-target-includes-timer-and-reaction-closure

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：start等待5ps后更新x，反应输出x和now。

操作：先推进至4再推进至5。

预期：终点输出[1,5]，时间戳均为5且板时间为5。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
        output channel out: number(capacity: 8);
        state x: number = 0;
        reaction observe on x as (old, current) { out.send(current); out.send(now()); }
        process start { await ticks(5); x = 1; }
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
const { device, messages, values } = await importModule('../fixture.mjs');

const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(4);
assert.deepEqual(values(batches), []);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 5]);
assert.equal(board.time, 5);
assert.deepEqual(
  messages(batches).map((message) => message.time),
  [5, 5],
);

board.dispose();
```
