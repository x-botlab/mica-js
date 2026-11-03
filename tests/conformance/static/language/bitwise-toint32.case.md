---
kind: simulation
---

# bitwise-toint32

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 位运算采用 JavaScript ToInt32 / ToUint32：有限小数向零截断，再按 32 位回绕；NaN 和无穷大转为零。移位量转换后取低 5 位。``>>>`` 返回无符号 32 位数值，其他位运算返回有符号 32 位数值，静态类型均为 number。此转换不适用于地址、时长或存储写值的合法性检查。

## 验收义务

前提：对超 32 位值、负数、小数、NaN、Infinity 与超范围移位量执行位运算。

操作：建立真实板，运行到时间 0，收集 `out` 通道的公开输出。

预期：运行到时间 0 后，`out` 通道依次收到 5、4294967295、2、3、0 与 0：按 32 位回绕、无符号结果、低 5 位移位量、向零截断与非有限值转零。

## 模型

```ddl
device Atomic {
output channel out: number(capacity: 8);
process start {
out.send(4294967301 | 0);
out.send(-1 >>> 0);
out.send(1 << 33);
out.send(3.9 | 0);
out.send(NaN | 0);
out.send(Infinity | 0);
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
assert.deepEqual(actual, [5, 4294967295, 2, 3, 0, 0]);
```
