---
kind: simulation
---

# remainder-sign

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 普通数值运算采用对应 JavaScript binary64 运算；``%`` 是余数而非总为非负的模。例如 ``-5 % 3`` 为 -2。``**`` 与 pow 一致。除零、负数开平方等可产生 Infinity 或 NaN，不因普通算术本身报告模型故障。操作入口的值检查仍可拒绝这些结果。

## 验收义务

前提：余数运算分别使用负被除数、负除数与小数操作数。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 -2、2 与 -1.5：结果符号随被除数，不取非负模。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
process start {
out.send(-5 % 3);
out.send(5 % -3);
out.send(-5.5 % 2);
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
assert.deepEqual(actual, [-2, 2, -1.5]);
```
