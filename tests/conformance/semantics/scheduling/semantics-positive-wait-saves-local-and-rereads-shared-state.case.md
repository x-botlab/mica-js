---
format: mica-case/v1
id: semantics-positive-wait-saves-local-and-rereads-shared-state
kind: simulation
---

# semantics-positive-wait-saves-local-and-rereads-shared-state

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：x初值1，start保存局部值后等待5ps。

操作：推进至2，注入修改通知，再推进至5。

预期：输出[1,9]且两条消息时间均为5；局部旧值与共享新值分别可见。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
        input notification update;
        output channel out: number(capacity: 8);
        state x: number = 1;
        process mutate on update { x = 9; }
        process start { let saved = x; await ticks(5); out.send(saved); out.send(x); }
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

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(2);
assert.deepEqual(values(batches), []);
context.inputs.update.notify();
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 9]);
assert.deepEqual(
  messages(batches).map((message) => message.time),
  [5, 5],
);

board.dispose();
```
