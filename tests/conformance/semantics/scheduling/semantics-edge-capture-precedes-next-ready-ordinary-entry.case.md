---
kind: simulation
---

# semantics-edge-capture-precedes-next-ready-ordinary-entry

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：rise和fall均已暂存，rise设置data=1并产生上升沿。

操作：推进至0，随后fall清除data。

预期：输出[1]，验证此序列的边沿捕获未被后入口污染。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  input notification rise;
  input notification fall;
  output channel out: number(capacity: 8);
  state clock: bool = false;
  state data: number = 0;
  reaction latch on clock as (old, current) capture saved = data {
    if !old && current {
      out.send(saved);
    }
  }
  process rising on rise {
    data = 1;
    clock = true;
  }
  process falling on fall {
    clock = false;
    data = 0;
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
  {
    create(ctx) {
      ctx.inputs.rise.notify();
      ctx.inputs.fall.notify();
    },
  },
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
