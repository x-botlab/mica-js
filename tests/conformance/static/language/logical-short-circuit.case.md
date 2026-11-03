---
kind: simulation
---

# logical-short-circuit

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> * - ``&&``
>      - bool、bool；左为 false 时不求右侧。
>      - bool。
>    * - ``||``
>      - bool、bool；左为 true 时不求右侧。
>      - bool。

## 验收义务

前提：逻辑与左侧为 false，逻辑或左侧为 true，右侧函数均会增加 state。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 0。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);
state calls: number = 0;
fn change() -> bool {
calls = calls + 1;
return true;
}
process start {
const first = false && change();
const second = true || change();
out.send(calls);
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
