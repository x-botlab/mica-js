---
kind: simulation
---

# nan-zero-equality

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 数值相等使用严格数值相等，不做类型转换：NaN 不等于任何值，包括自身；正负零相等；含 NaN 的四种大小比较均为 false。bool 与 number 间比较静态拒绝，不另提供 ``===`` 或 ``!==``。

## 验收义务

前提：分别比较 NaN 与自身、正零与负零、NaN 的 `<` 比较以及 NaN 与自身的不等比较。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 0、1、0 与 1：NaN 不等于自身，正负零相等，含 NaN 的大小比较为 false。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
process start {
out.send(NaN == NaN ? 1 : 0);
out.send(0 == -0 ? 1 : 0);
out.send(NaN < 0 ? 1 : 0);
out.send(NaN != NaN ? 1 : 0);
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
assert.deepEqual(actual, [0, 1, 0, 1]);
```
