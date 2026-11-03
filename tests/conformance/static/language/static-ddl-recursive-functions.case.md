---
kind: compile
---

# static-ddl-recursive-functions

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 首版不提供泛型、同名重载或默认函数参数。同步函数调用图必须静态无环，直接和间接递归均拒绝。重复执行通过循环表达。

## 验收义务

前提：两个同步函数互相调用。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn first() {
second();
}
fn second() {
first();
}
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
await assert.rejects(compile, '拒绝同步函数的间接递归调用图。');
```
