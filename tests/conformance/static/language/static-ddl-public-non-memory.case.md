---
kind: compile
---

# static-ddl-public-non-memory

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> memory 是实例独立固定字节区，长度允许为零。``public`` 仅修饰 memory，授予配对 JavaScript 只读用途的借用权限。初始化、范围与借用合同见 :doc:`/memory`。

## 验收义务

前提：`public` 修饰 state 声明。

操作：编译该 device 定义。

预期：`public` 只适用于 memory，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-memory-zero-length`。

## 输入

```ddl
device StaticFixture {
public state count: number = 0;
}
```

## 执行步骤

```typescript
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
