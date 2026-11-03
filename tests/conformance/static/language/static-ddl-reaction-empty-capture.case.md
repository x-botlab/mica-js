---
kind: compile
---

# static-ddl-reaction-empty-capture

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> ``as (previous, current)`` 中的两个名称由作者指定，分别绑定相邻两次源观察的旧值与新值。``capture name = pureExpr, ...`` 整段可省略；出现时至少有一项，可带末尾逗号。reaction 与函数、过程一样只在 device 内声明，名称属于同一器件名称空间，不能作为函数调用。

## 验收义务

前提：reaction 写出 `capture` 关键字但不提供任何绑定。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：capture 出现时至少一项，该定义被静态拒绝并给出非空诊断消息；近邻提供一项 capture 绑定即合法。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
reaction observe on count as (before, after) capture {
count = count + 1;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
state count: number = 0;
reaction observe on count as (before, after) capture saved = count {
count = saved + 1;
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
