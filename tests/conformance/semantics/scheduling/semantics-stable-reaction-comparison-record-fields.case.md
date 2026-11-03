---
format: mica-case/v1
id: semantics-stable-reaction-comparison-record-fields
kind: simulation
---

# semantics-stable-reaction-comparison-record-fields

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 同一具名记录与 sample 按各字段递归使用此规则比较；bytes 按长度和字节内容比较。

## 验收义务

前提：`state x` 的初值为记录 `{ n: 1, flag: true }`；启动过程先赋相同字段，经过零时边界后再把 `n` 改为 2。

操作：通过真实 adapter 编译模型并推进到 0，收集反应体输出。

预期：只交付一条输出；相同记录按字段递归比较为相同而不触发，字段变化时触发一次。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe { output channel out: number(capacity: 32);
        record Pair { n: number; flag: bool; }
        state x: Pair = { n: 1, flag: true };
        reaction observe on x as (old, current) { out.send(1); }
        process start { x = { n: 1, flag: true }; await ticks(0); x = { n: 2, flag: true }; }
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
