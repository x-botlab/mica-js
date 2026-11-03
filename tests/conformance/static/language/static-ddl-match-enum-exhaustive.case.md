---
kind: compile
---

# static-ddl-match-enum-exhaustive

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> 枚举支持同类型相等比较与 match；不支持大小排序。

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。

## 验收义务

前提：有返回值函数对枚举参数列出全部成员分支，另有同类型相等比较。

操作：编译该 device 定义，并把产物登记到器件库。

预期：编译成功；枚举分支可枚举穷尽，每个分支都已返回。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active }
state mode: Mode = Mode.idle;
fn weight(value: Mode) -> number {
match value {
Mode.idle => { return 0; }
Mode.active => { return 1; }
}
}
fn idle() -> bool { return mode == Mode.idle; }
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
