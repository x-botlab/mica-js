---
kind: compile
---

# static-ddl-mixed-call-arguments

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

## 验收义务

前提：函数调用同时使用位置实参和命名实参。

操作：编译该定义。

预期：拒绝该调用；本例不独立隔离混合实参规则。

## 输入

```ddl
device StaticFixture {
fn sum(left: number, right: number) -> number {
return left + right;
}
const value = sum(1, right: 2);
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
await assert.rejects(compile, '拒绝普通函数调用混用位置和命名实参。');
```
