---
kind: compile
---

# static-ddl-property-assignment

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> const、函数参数、reaction 的 previous / current 与 capture 绑定、属性、derived、记录字段与 sample / bytes 字段均不可赋值。普通赋值的目标为可写名称，右侧与声明类型匹配；赋值不产生值，不能连续赋值。

## 验收义务

前提：过程对 device 属性 period 赋值。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：属性在创建后不可赋值，该定义被静态拒绝并给出非空诊断消息；近邻把写入目标换成可写 state 即合法。

## 输入

```ddl
device StaticFixture(period: number default 1) {
process start {
period = 2;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture(period: number default 1) {
state count: number = 0;
process start {
count = 2;
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
