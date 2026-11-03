---
kind: compile
---

# static-ddl-sample-equality

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``intent`` 是支路组合值，``sample`` 是已发布的只读采样快照。两者可以保存到局部、传参、返回或形成可空值；intent 构造与 sample 字段由 :doc:`builtins`、:doc:`/electrical` 定义。sample 按字段相等，intent 不提供相等比较；intent? 仍可与 none 比较。

## 验收义务

前提：两个 sample 值形参做相等比较，另读取 sample 的 `level` 字段与内置枚举成员比较。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；sample 可作为值形参并按字段相等比较，字段类型由内置枚举声明确认。

## 输入

```ddl
device StaticFixture {
fn same(first: sample, second: sample) -> bool { return first == second; }
fn high(value: sample) -> bool { return value.level == Logic.high; }
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
