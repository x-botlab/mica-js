---
kind: compile
---

# static-ddl-function-as-value

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 第一行先 first 后 second；第二行先 second 后 first。方法调用只开放 :doc:`builtins` 定义的端点操作，不开放任意宿主方法。类型名不是转换函数，函数也不能作为值保存或动态调用。

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 所有形参类型显式给出，参数不可重新赋值；需要修改时先建立 let 副本。资源形参只允许 pin 与 memory，资源的使用范围见 :doc:`types`。函数仅能访问参数、自己的局部及所属 device 名称，不捕获调用者局部。函数不能作为值保存或动态调用。

## 验收义务

前提：局部 const 初始化表达式引用函数名本身。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：函数不是值，该定义被静态拒绝并给出非空诊断消息；近邻把函数名改为调用即合法。

## 输入

```ddl
device StaticFixture {
fn action() {}
fn save() {
const reference = action;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
fn action() {}
fn save() {
action();
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
