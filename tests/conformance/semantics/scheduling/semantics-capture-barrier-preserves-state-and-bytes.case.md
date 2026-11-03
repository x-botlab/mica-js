---
kind: simulation
---

# semantics-capture-barrier-preserves-state-and-bytes

## 规范来源

[docs/spec/execution/scheduling.rst](../../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：触发前 count=0、首字节为1，先声明的反应将其改为7和9。

操作：启动触发一次反应轮并收集数值输出。

预期：输出为[0,7,1,9]，只检验本轮捕获快照和后体普通读取。

## 模型

<!-- prettier-ignore -->
```ddl
device SemanticProbe {
  output channel out: number(capacity: 32);
  state trigger: number = 0;
  state count: number = 0;
  memory data[1];
  reaction first on trigger as (old, current) {
    count = 7;
    store8(data, 0, 9);
  }
  reaction second on trigger as (old, current) capture saved = count, bytesBefore = copyBytes(data, 0, 1) {
    out.send(saved);
    out.send(count);
    out.send(bytesBefore[0]);
    out.send(load8(data, 0));
  }
  process start {
    store8(data, 0, 1);
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
assert.deepEqual(values(batches), [0, 7, 1, 9]);

board.dispose();
```
