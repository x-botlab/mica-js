---
kind: compile
---

# builtin-shadow

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 内置类型、枚举、常量与函数名称由 :doc:`types` 和 :doc:`builtins` 给出，不能被用户声明遮蔽。

## 验收义务

前提：器件级 const 试图声明名为 Infinity 的成员。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const Infinity = 1;
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
