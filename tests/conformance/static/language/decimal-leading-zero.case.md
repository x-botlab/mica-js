---
format: mica-case/v1
id: language-atomic-decimal-leading-zero
kind: simulation
---

# decimal-leading-zero

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 数字之间允许单个下划线，例如 ``1_000``、``0xff_ff``、``1.25e+3``。下划线不能位于前缀后、结尾、小数点或指数标记旁，也不能连续出现。前导零不产生旧式八进制解释。负号是独立的一元运算。

## 验收义务

前提：启动过程发送带前导零的 010。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道收到 10。

## 模型

<!-- prettier-ignore -->
```ddl
device Atomic {
output channel out: number(capacity: 32);

process start {
out.send(010);
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
assert.deepEqual(actual, [10]);
```
