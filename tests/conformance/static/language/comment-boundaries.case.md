---
format: mica-case/v1
id: language-atomic-comment-boundaries
kind: simulation
---

# comment-boundaries

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> ``//`` 注释持续到行尾；``/* ... */`` 是不可嵌套的块注释。空白与注释分隔词法单元，不能插入一个标识符、数字或多字符运算符的内部。注释与字符串可以包含中文。

## 验收义务

前提：表达式间有中文块注释，行尾有中文行注释，下一行有独立发送。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 3 与 4。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send(1 /* 中文块注释 */ + 2); // 中文行注释
out.send(4);
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
assert.deepEqual(actual, [3, 4]);
```
