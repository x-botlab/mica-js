---
format: mica-case/v1
id: language-atomic-match-no-fallthrough
kind: simulation
---

# match-no-fallthrough

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 只作为语句，被匹配值求值一次，按源码顺序选择匹配分支，完成后 MUST NOT 贯穿：

## 验收义务

前提：数值 1 匹配首支，两个分支对同一 state 分别增加 1 和 10。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 1。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);
state count: number = 0;
process start {
match 1 { 1 => { count = count + 1; } _ => { count = count + 10; } } out.send(count);
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
assert.deepEqual(actual, [1]);
```
