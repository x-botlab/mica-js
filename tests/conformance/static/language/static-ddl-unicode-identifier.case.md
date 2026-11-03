---
kind: compile
---

# static-ddl-unicode-identifier

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 标识符大小写敏感，匹配 ``[A-Za-z_][A-Za-z0-9_]*``。

## 验收义务

前提：state 声明以中文作为名称。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state 数值: number = 0;
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
await assert.rejects(compile, '拒绝不匹配 ASCII 标识符规则的中文声明名。');
```
