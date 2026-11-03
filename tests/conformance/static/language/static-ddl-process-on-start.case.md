---
kind: compile
---

# static-ddl-process-on-start

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 其他过程必须显式写 ``process name on source``；不提供 ``on start`` 形式或无 on 的任意名称入口。过程不能像 fn 一样被调用。新板启动时入口何时生效由 :doc:`/javascript/lifecycle` 和 :doc:`/execution/scheduling` 统一规定。

## 验收义务

前提：命名过程使用 `on start` 作为触发源。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：不提供 `on start` 形式，该定义被静态拒绝并给出非空诊断消息；近邻把源改为 state 即合法。

## 输入

```ddl
device StaticFixture {
state flag: bool = false;
process observe on start {
flag = true;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
state flag: bool = false;
process observe on flag {
flag = true;
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
