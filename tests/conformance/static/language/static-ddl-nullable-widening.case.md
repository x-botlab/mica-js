---
kind: compile
---

# static-ddl-nullable-widening

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> ``T?`` 表示一个 T 或 ``none``，后者与零、false 和空字符串区分。T 可以自动进入 T?；需要 T 的操作先排除 none。可空标记只出现一次，资源引用和无返回类型不能可空。

## 验收义务

前提：局部注解与函数返回类型为 `T?`，实际表达式分别为 number 与枚举值。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；非可空值可自动进入对应可空类型，无需显式包装。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active }
fn mode(): Mode? { return Mode.idle; }
fn count() -> number? {
const value: number? = 1;
return value;
}
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
