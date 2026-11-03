---
kind: compile
---

# shared-device-namespace

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> device 的属性、器件级 ``const``、资源、derived、函数、过程和自定义类型共享一个名称空间，名称必须唯一。枚举成员和记录字段各自拥有内部名称空间，其内部名称必须唯一。

## 验收义务

前提：器件级 const 与 fn 使用相同名称。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

<!-- prettier-ignore -->
```ddl
device Atomic {
const value = 1; fn value() {}
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
