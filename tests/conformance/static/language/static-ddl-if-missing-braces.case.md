---
kind: compile
---

# static-ddl-if-missing-braces

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 条件及各分支必须使用花括号；支持 ``else if``。match 只作为语句，被匹配值求值一次，按源码顺序选择匹配分支，完成后 MUST NOT 贯穿：

## 验收义务

前提：if 的被选分支写成不带花括号的单条赋值语句。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：if 分支必须使用花括号，该定义被静态拒绝并给出非空诊断消息；近邻仅补上分支花括号即合法。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
process start {
if count > 0 count = 1;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
state count: number = 0;
process start {
if count > 0 {
count = 1;
}
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
