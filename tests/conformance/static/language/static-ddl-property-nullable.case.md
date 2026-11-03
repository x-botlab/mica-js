---
kind: compile
---

# static-ddl-property-nullable

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> * - 属性
>   - number、bool、string、枚举、bytes 及其可空形式。

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> ``device`` 头部可以省略属性表，也可以写空括号。每个属性显式给出类型，以 ``default expression`` 指定可选默认值；没有默认值时装配必须提供。提供 none 与省略属性不同。

## 验收义务

前提：属性分别声明可空 number 并给出默认值、可空 string 且不给出默认值。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；属性允许 `T?` 形式，缺少默认值的可空属性由装配提供值。

## 输入

```ddl
device StaticFixture(limit: number? default 1, label: string?) {}
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
