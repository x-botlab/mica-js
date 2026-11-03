---
kind: compile
---

# static-ddl-match-nan-pattern

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> match 必须穷尽。bool 和枚举可以列出全部值；可空类型还须覆盖 none。number、string 以及不能逐项列举的值类型需要 ``_``；bytes 不提供内容模式。只有兜底的 match 也可使用，但不产生新的模式能力。NaN 与 Infinity 不是数值字面量模式。

## 验收义务

前提：number match 的首支使用 `NaN` 作为模式。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：NaN 不是数值字面量模式，该定义被静态拒绝并给出非空诊断消息；近邻改用数值字面量模式即合法。

## 输入

```ddl
device StaticFixture {
fn classify(value: number) -> number {
match value {
NaN => { return 1; }
_ => { return 0; }
}
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
fn classify(value: number) -> number {
match value {
0 => { return 1; }
_ => { return 0; }
}
}
}`;
const accepted = await adapter.compileDDL(neighbor);
assert.equal(accepted.kind, 'device');
const compile = () => adapter.compileDDL(input);
```

## 断言

```typescript
await assert.rejects(compile, (error) => {
  assert.ok(error instanceof Error, '编译拒绝必须抛出 Error。');
  assert.ok(error.message.length > 0, '编译诊断必须给出非空消息。');
  return true;
});
```
