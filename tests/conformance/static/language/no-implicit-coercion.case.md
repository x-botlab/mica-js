---
format: mica-case/v1
id: language-atomic-no-implicit-coercion
kind: compile
---

# no-implicit-coercion

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 上述运算的类型检查不进行隐式字符串、数值或布尔转换。

## 验收义务

前提：同步函数将字符串与数字相加。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read() -> string { return "1" + 1; }
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
