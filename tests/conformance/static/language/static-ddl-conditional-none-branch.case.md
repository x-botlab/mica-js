---
kind: compile
---

# static-ddl-conditional-none-branch

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 三元表达式不产生可赋值位置或资源引用；其共同值类型可以是同一类型、T 与 T?，或 T 与 none 形成 T?，不生成其他联合类型。

## 验收义务

前提：有返回值函数声明返回 `number?`，三元表达式的否分支为裸 `none`。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；number 与 none 分支合成为 number?。

## 输入

```ddl
device StaticFixture {
fn limit(flag: bool) -> number? { return flag ? 1 : none; }
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
