---
kind: compile
---

# split-multichar-operator

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> ``//`` 注释持续到行尾；``/* ... */`` 是不可嵌套的块注释。空白与注释分隔词法单元，不能插入一个标识符、数字或多字符运算符的内部。注释与字符串可以包含中文。

## 验收义务

前提：相等运算符的两个等号被块注释分隔。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read() -> bool { return 1 = /* split */ = 1; }
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
