---
kind: compile
---

# reaction-binding-readonly

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> const、函数参数、reaction 的 previous / current 与 capture 绑定、属性、derived、记录字段与 sample / bytes 字段均不可赋值。

## 验收义务

前提：响应体给 as 的第二个绑定直接赋值。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
state count: number = 0;
reaction observe on count as (before, after) { after = 2; }
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
