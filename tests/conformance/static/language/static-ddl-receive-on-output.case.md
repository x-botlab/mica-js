---
kind: compile
---

# static-ddl-receive-on-output

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> DDL 在 input channel 上 receive，在 output channel 上 send，在 output notification 上 notify；input notification 用作反应源。

[docs/spec/language/builtins.rst](../../../../docs/spec/language/builtins.rst)

<!-- prettier-ignore -->
> ``await endpoint.receive()`` 从 input channel 取得一个负载值，可以将结果丢弃。非空立即完成，空队列实际挂起。``endpoint.send(value)`` 与 ``endpoint.notify()`` 分别用于 output channel 与 output notification，均无返回值，不挂起。

## 验收义务

前提：过程在 output channel 上 await receive。

操作：编译该 device 定义。

预期：receive 只适用于 input channel，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-same-process-receive`。

## 输入

```ddl
device StaticFixture {
output channel outgoing: number(capacity: 2);
process start {
const value = await outgoing.receive();
}
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
