---
kind: compile
---

# static-ddl-intent-optional-none-check

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``intent`` 是支路组合值，``sample`` 是已发布的只读采样快照。两者可以保存到局部、传参、返回或形成可空值；intent 构造与 sample 字段由 :doc:`builtins`、:doc:`/electrical` 定义。sample 按字段相等，intent 不提供相等比较；intent? 仍可与 none 比较。

## 验收义务

前提：值形参声明为 `intent?`，响应体只将其与 none 比较。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；intent? 属于值形参与可空形式，且允许可空性检查。

## 输入

```ddl
device StaticFixture {
fn missing(value: intent?) -> bool { return value == none; }
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
assert.equal(model.name, 'StaticFixture');
assert.ok(Array.isArray(model.declarations));
```
