---
kind: compile
---

# if-condition-number

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``bool`` 仅为 ``true`` 或 ``false``。条件必须为 bool，不使用数值、字符串或资源的真假转换。

## 验收义务

前提：启动过程的 if 直接使用数值字面量作为条件。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
process start { if 1 { } }
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
