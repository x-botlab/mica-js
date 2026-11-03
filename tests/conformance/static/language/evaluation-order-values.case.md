---
kind: simulation
---

# evaluation-order-values

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 表达式在当前语义位置取得值。除短路和条件选择外，子表达式从左到右求值；成员和索引先计算接收值，再计算索引，记录字段和字节、意图列表按源码顺序计算。赋值不是表达式。

## 验收义务

前提：记录字面量字段与 bytes 构造元素分别调用会递增 state 的函数。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 1、1、3 与 4：记录字段和 bytes 元素均按源码从左到右求值，调用计数不因书写形式重排。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
state calls: number = 0;
record Pair { left: number; right: bool; }
fn next() -> number {
calls = calls + 1;
return calls;
}
process start {
const pair: Pair = { left: next(), right: next() > 1 };
const data = bytes[next(), next()];
out.send(pair.left);
out.send(pair.right ? 1 : 0);
out.send(data[0]);
out.send(data[1]);
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
const { runDDLOutput } = await importModule('../assertions.mjs');
assert.deepEqual(description, {
  instances: [{ id: 'atomic', type: 'language/atomic' }],
  nets: [],
});
const actual = await runDDLOutput(adapter, t, modelSource);
```

## 断言

```typescript
assert.deepEqual(actual, [1, 1, 3, 4]);
```
