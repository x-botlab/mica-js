---
format: mica-case/v1
id: language-atomic-numeric-identifier-adjacency
kind: compile
---

# numeric-identifier-adjacency

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> 词法单元采用最长匹配，多字符运算符优先于其前缀。标识符与数字连续拼接不能把非法字面量补成合法表达式；字符串内的注释记号是普通内容。

## 验收义务

前提：器件级 const 将 12abc 用作初始化表达式。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const value = 12abc;
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
