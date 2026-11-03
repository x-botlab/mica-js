---
format: mica-case/v1
id: language-atomic-nested-function
kind: compile
---

# nested-function

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 函数、过程与 reaction 仅在 device 体内声明。块内使用局部声明、语句和控制结构；不嵌套定义 device、函数、过程或 reaction。

## 验收义务

前提：普通 fn 的函数体内包含另一 fn 声明。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn outer() { fn inner() {} }
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
