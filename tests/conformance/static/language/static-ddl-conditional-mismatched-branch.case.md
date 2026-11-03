---
kind: compile
---

# static-ddl-conditional-mismatched-branch

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 三元表达式不产生可赋值位置或资源引用；其共同值类型可以是同一类型、T 与 T?，或 T 与 none 形成 T?，不生成其他联合类型。

## 验收义务

前提：三元表达式的两个分支分别为 number 与 string。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：两分支不构成共同值类型，该定义被静态拒绝并给出非空诊断消息；近邻仅把两分支与返回类型统一为 number 即合法。

## 输入

```ddl
device StaticFixture {
fn label(flag: bool) -> string { return flag ? 1 : "x"; }
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
fn label(flag: bool) -> number {
return flag ? 1 : 2;
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
