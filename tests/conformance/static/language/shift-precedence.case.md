---
kind: simulation
---

# shift-precedence

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> relational = shift, { ( "<" | "<=" | ">" | ">=" ), shift } ;
>    shift = additive, { ( "<<" | ">>" | ">>>" ), additive } ;
>    additive = multiplicative, { ( "+" | "-" ), multiplicative } ;

## 验收义务

前提：同一表达式混用移位、加法与关系比较，均未加括号。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 8、4、1 与 2147483647：加法先于移位，移位先于关系比较，`>>>` 返回无符号 32 位数值。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
process start {
out.send(1 << 2 + 1);
out.send(32 >> 2 + 1);
out.send(1 << 3 < 9 ? 1 : 0);
out.send(-1 >>> 1);
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
assert.deepEqual(actual, [8, 4, 1, 2147483647]);
```
