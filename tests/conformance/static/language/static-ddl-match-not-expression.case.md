---
kind: compile
---

# static-ddl-match-not-expression

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 局部被匹配值在具体非空分支收窄；若前支已排除 none，后续 ``_`` 分支可按非空类型使用。match 本身不返回值；需要计算分支结果时使用外层 let 或三元表达式。

## 验收义务

前提：局部初始化右侧直接使用 match 作为表达式。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：match 只作为语句、不返回值，该定义被静态拒绝并给出非空诊断消息；近邻把 match 作为独立语句即合法。

## 输入

```ddl
device StaticFixture {
enum Mode { idle, active }
state mode: Mode = Mode.idle;
fn discard() {
const result = match mode {
Mode.idle => {}
Mode.active => {}
};
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
enum Mode { idle, active }
state mode: Mode = Mode.idle;
fn discard() {
match mode {
Mode.idle => {}
Mode.active => {}
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
