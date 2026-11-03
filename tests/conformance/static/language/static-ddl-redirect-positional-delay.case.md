---
kind: compile
---

# static-ddl-redirect-positional-delay

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> redirect-statement = "redirect", "(", expression,
>                         [ ",", "delay", ":", expression ], ")" ;

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> ``target`` 是位置参数，值为有限 number；``delay`` 是可选命名参数，省略时为零，合法性遵守 :doc:`/execution/index` 的非负时长规则。这是专用控制语法，不将位置和命名实参混用扩展到普通函数调用。

## 验收义务

前提：redirect 以位置实参给出第一个延时数值。

操作：编译该 device 定义。合法 redirect 只在已绑定 JIT 入口的上下文可用，DDL 源内没有等价的合法近邻，因此本例不提供编译期合法对照。

预期：delay 只能用命名形式给出，该 device 定义被静态拒绝并给出非空诊断消息；本例不断言任何 redirect 编译通过。

## 输入

```ddl
device StaticFixture {
process start {
redirect(0, 1);
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
