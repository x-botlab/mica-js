---
format: mica-case/v1
id: language-atomic-binary-left-association
kind: simulation
---

# binary-left-association

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 下表从高到低排列。除幂与条件选择右结合外，其余二元运算左结合；一元运算向右结合。

## 验收义务

前提：同一表达式连续包含两个除法。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 2。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send(20 / 5 / 2);
}
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "atomic",
      "type": "language/atomic"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const batches = [];
const model = await adapter.compileDDL(modelSource);
const library = adapter.createDeviceLibrary([
  {
    id: 'language/atomic',
    model,
    create() {
      return {
        sync(batch) {
          batches.push(batch);
        },
        dispose() {},
      };
    },
  },
]);
const board = adapter.createBoard(library, description);
t.after(() => board.dispose());
board.runUntil(0);
const actual = batches.flatMap((batch) => batch.outputs.out.map((message) => message.value));
```

## 断言

```typescript
assert.deepEqual(actual, [2]);
```
