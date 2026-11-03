---
kind: compile
---

# else-if-chain

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 简单语句以分号结束，不执行自动分号插入。语句块使用花括号；``else if`` 可以直接连写。参数、实参、枚举成员和记录字段列表允许末尾分隔符。

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> if-statement = "if", expression, block,
>                   [ "else", ( block | if-statement ) ] ;

## 验收义务

前提：过程内使用 `} else if ... {` 直接连写的三段条件链，末段为 `else` 块。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；连写的 `else if` 属于同一条 if 语句，末尾 `else` 块合法。

## 输入

```ddl
device Atomic {
state grade: number = 0;
process start {
if grade > 1 {
grade = 1;
} else if grade < 0 {
grade = 2;
} else {
grade = 3;
}
}
}
```

## 执行步骤

```typescript
const { validateDDL } = await importModule('../assertions.mjs');
const model = await validateDDL(adapter, input);
```

## 断言

```typescript
assert.equal(model.kind, 'device');
assert.equal(model.name, 'Atomic');
assert.ok(Array.isArray(model.declarations));
```
