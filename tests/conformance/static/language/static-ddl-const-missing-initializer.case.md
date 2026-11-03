---
kind: compile
---

# static-ddl-const-missing-initializer

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> 参数、局部绑定不能遮蔽当前可见的器件成员、参数或外层局部。兄弟块中互不包含的局部可以复用名称。局部名称在自身初始化完成后可用，初始化不能读取自身。``const`` 与 ``let`` 都必须有初值。

## 验收义务

前提：器件级 const 声明只给出类型，没有初值。

操作：编译该 device 定义。

预期：const 必须有初值，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-creation-forward-dependency`。

## 输入

```ddl
device StaticFixture {
const size: number;
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
