---
format: mica-case/v1
id: language-atomic-bitwise-priority
kind: simulation
---

# bitwise-priority

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> bit-or = bit-xor, { "|", bit-xor } ;
>    bit-xor = bit-and, { "^", bit-and } ;
>    bit-and = equality, { "&", equality } ;

## 验收义务

前提：同一表达式按源码顺序使用 &、^、| 且未加括号。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 11。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send(6 & 3 ^ 1 | 8);
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
assert.deepEqual(actual, [11]);
```
