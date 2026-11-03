---
kind: compile
---

# static-ddl-unparenthesized-power

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 幂与一元采用 JavaScript 的括号要求：``-2 ** 2`` 拒绝，必须写 ``-(2 ** 2)`` 或 ``(-2) ** 2``。``2 ** -2`` 合法。

## 验收义务

前提：幂左操作数为未括号的一元负数。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
const value = -2 ** 2;
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝幂左侧未括号的一元表达式。');
```
