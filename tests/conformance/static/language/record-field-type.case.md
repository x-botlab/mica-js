---
format: mica-case/v1
id: language-atomic-record-field-type
kind: compile
---

# record-field-type

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 记录是 device 内的具名不可变值，允许零个字段，字段名唯一、全部必填，字段类型仅为 number 或 bool。记录保持扁平。字面量从注解、实参形参、返回类型或发送目标获得期望类型；缺少该上下文时要求显式注解。

## 验收义务

前提：record 的字段声明为 string 类型。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
record Bad { text: string; }
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
