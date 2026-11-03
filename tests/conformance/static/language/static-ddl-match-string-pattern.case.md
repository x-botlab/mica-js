---
kind: compile
---

# static-ddl-match-string-pattern

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 模式为数值字面量（可带一元正负号）、字符串字面量、true、false、枚举成员、none 或兜底 ``_``。模式不执行函数，不提供解构或守卫。重复模式拒绝；正负零视为重复数值模式。兜底必须是最后一支。

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。只有兜底的 match 也可使用，但不产生新的模式能力。NaN 与 Infinity 不是数值字面量模式。

## 验收义务

前提：有返回值函数对 string 参数使用字符串字面量模式，并以最后一支 `_` 覆盖其余值。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；string 模式需要兜底，全部可正常结束分支都返回匹配值。

## 输入

```ddl
device StaticFixture {
fn size(name: string) -> number {
match name {
"small" => { return 1; }
"large" => { return 2; }
_ => { return 0; }
}
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
