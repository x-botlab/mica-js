---
kind: compile
---

# bare-none

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 裸 ``none`` 缺少目标 T；``const x = none;`` 需要补注解，例如 ``const x: number? = none;``。

## 验收义务

前提：局部 const 没有注解且初始化为 none。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
fn read() { const value = none; }
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
