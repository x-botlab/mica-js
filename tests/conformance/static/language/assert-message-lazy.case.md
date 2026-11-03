---
format: mica-case/v1
id: language-atomic-assert-message-lazy
kind: simulation
---

# assert-message-lazy

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 条件为真时继续，消息不求值；条件为假时才计算消息并报告失败。消息表达式接受所在上下文的类型与效果检查。

## 验收义务

前提：断言条件为 true，消息函数调用会递增 state。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 0，消息中的副作用没有发生。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);
state calls: number = 0;
fn message() -> string { calls = calls + 1; return "unexpected"; }
process start {
assert true, message(); out.send(calls);
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
assert.deepEqual(actual, [0]);
```
