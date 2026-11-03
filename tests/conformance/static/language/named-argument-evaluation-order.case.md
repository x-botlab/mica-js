---
kind: simulation
---

# named-argument-evaluation-order

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 调用使用全部位置实参或全部命名实参，两种形式 MUST NOT 混用。全部形参必须匹配且恰好提供一次；实参按源码顺序计算，不因形参声明顺序重排：

## 验收义务

前提：形参顺序为 left、right，调用顺序为 right、left，next 每次递增共享 state。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 21。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);
state calls: number = 0;
fn next() -> number {
calls = calls + 1;
return calls;
}
fn pack(left: number, right: number) -> number {
return left * 10 + right;
}
process start {
out.send(pack(right: next(), left: next()));
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
assert.deepEqual(actual, [21]);
```
