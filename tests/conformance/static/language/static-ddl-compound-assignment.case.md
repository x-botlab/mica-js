---
kind: compile
---

# static-ddl-compound-assignment

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> 局部声明、调用和赋值按源码顺序执行。可重赋值的 let 与 state 使用 ``=``，不提供复合赋值或自增、自减。引脚意图用 ``<-`` 整体替换：

## 验收义务

前提：过程对 state 使用复合赋值 `+=`。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：复合赋值不属于语言，该定义被静态拒绝并给出非空诊断消息；近邻改用普通赋值即合法。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
process start {
count += 1;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
state count: number = 0;
process start {
count = 1;
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
