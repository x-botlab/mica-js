---
format: mica-case/v1
id: static-ddl-pure-random
kind: compile
---

# static-ddl-pure-random

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 纯函数不能写入实例资源、替换引脚意图、访问消息队列、发送通知、等待、执行 redirect 或调用 random、now。效果检查沿调用图传播，包括短路右侧和条件分支，不能通过辅助调用绕过。

## 验收义务

前提：pure fn 直接调用 random。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
pure fn read() -> number { return random(); }
}
```

## 执行步骤

```typescript
assert.equal(typeof adapter.compileDDL, 'function');
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝 pure 函数调用 random。');
```
