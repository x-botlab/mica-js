---
kind: compile
---

# static-ddl-assert-message-type

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> await 不属于 expression，只能用于这里列出的完整右侧或独立语句。ticks 无值，不能初始化或赋值；receive 的结果类型由 input channel 决定。断言第一项须为 bool，消息须为 string，且消息只在失败时求值。

## 验收义务

前提：assert 的第二项消息给出 number 字面量。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：断言消息必须是 string，该定义被静态拒绝并给出非空诊断消息；近邻把消息改为 string 即合法。

## 输入

```ddl
device StaticFixture {
process start {
assert true, 1;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
process start {
assert true, "ok";
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
