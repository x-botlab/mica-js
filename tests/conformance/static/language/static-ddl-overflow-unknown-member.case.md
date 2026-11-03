---
kind: compile
---

# static-ddl-overflow-unknown-member

## 规范来源

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> ``Logic``、``SampleStatus`` 与 ``Overflow`` 为内置具名枚举。前两者的成员由 :doc:`/electrical` 维护；``Overflow`` 的成员为 ``drop_new``、``drop_oldest`` 和 ``error``，语义见 :doc:`/channels`。用户枚举采用相同的具名成员与类型身份规则。

## 验收义务

前提：bytes 通道的 overflow 选项使用内置枚举中不存在的成员 `newest`。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：Overflow 只有三个已定义成员，该定义被静态拒绝并给出非空诊断消息；近邻改用已定义成员 `Overflow.drop_new` 即合法。

## 输入

```ddl
device StaticFixture {
output channel out: bytes(maxLength: 8, capacity: 1, overflow: Overflow.newest);
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
output channel out: bytes(maxLength: 8, capacity: 1, overflow: Overflow.drop_new);
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
