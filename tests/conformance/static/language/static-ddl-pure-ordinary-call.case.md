---
kind: compile
---

# static-ddl-pure-ordinary-call

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> ``pure fn`` 显式声明纯同步函数；普通 fn 可以调用 pure fn，pure fn 只调用其他 pure fn 或纯内置操作：

## 验收义务

前提：pure fn 调用空的普通 fn。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn ordinary() {} pure fn read() { ordinary(); }
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝 pure 函数调用普通 fn，即使普通函数体无效果。');
```
