---
kind: compile
---

# static-ddl-named-argument-duplicate

## 规范来源

[docs/spec/language/expressions.rst](../../../../docs/spec/language/expressions.rst)

<!-- prettier-ignore -->
> 普通函数允许出现在表达式中，其同步副作用按求值顺序发生；无返回调用只能作为语句。调用使用全部位置实参或全部命名实参，两种形式 MUST NOT 混用。全部形参必须匹配且恰好提供一次；实参按源码顺序计算，不因形参声明顺序重排：

## 验收义务

前提：命名实参对同一形参 `left` 提供两次。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：每个形参必须恰好提供一次，该定义被静态拒绝并给出非空诊断消息；近邻对每个形参各提供一次即合法。

## 输入

```ddl
device StaticFixture {
pure fn sum(left: number, right: number) -> number { return left + right; }
const total = sum(left: 1, left: 2);
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
pure fn sum(left: number, right: number) -> number {
return left + right;
}
const total = sum(left: 1, right: 2);
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
