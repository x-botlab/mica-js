---
kind: compile
---

# static-ddl-default-not-last

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 模式为数值字面量（可带一元正负号）、字符串字面量、true、false、枚举成员、none 或兜底 ``_``。模式不执行函数，不提供解构或守卫。重复模式拒绝；正负零视为重复数值模式。兜底必须是最后一支。

## 验收义务

前提：string match 在兜底分支后仍有分支。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn choose(value: string) { match value { _ => {} "later" => {} } }
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
await assert.rejects(compile, '拒绝兜底分支后的 match 分支。');
```
