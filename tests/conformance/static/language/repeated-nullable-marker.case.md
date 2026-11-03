---
format: mica-case/v1
id: language-atomic-repeated-nullable-marker
kind: compile
---

# repeated-nullable-marker

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``T?`` 表示一个 T 或 ``none``，后者与零、false 和空字符串区分。T 可以自动进入 T?；需要 T 的操作先排除 none。可空标记只出现一次，资源引用和无返回类型不能可空。

## 验收义务

前提：state 的类型在 number 后连续标记两个问号。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state value: number?? = none;
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const compile = () => validateDDL(adapter, input);
```

## 断言

```typescript
await assert.rejects(compile);
```
