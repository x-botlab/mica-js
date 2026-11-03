---
kind: compile
---

# static-ddl-host-method-call

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 第一行先 first 后 second；第二行先 second 后 first。方法调用只开放 :doc:`builtins` 定义的端点操作，不开放任意宿主方法。类型名不是转换函数，函数也不能作为值保存或动态调用。

## 验收义务

前提：函数在 number 值上调用宿主方法 `toFixed`。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：方法调用只开放内置端点操作，该定义被静态拒绝并给出非空诊断消息；近邻改用内置端点 `outgoing.send` 即合法。

## 输入

```ddl
device StaticFixture {
fn label(value: number) -> string { return value.toFixed(2); }
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
output channel outgoing: number(capacity: 2);
process start {
outgoing.send(1);
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
