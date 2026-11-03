---
format: mica-case/v1
id: static-ddl-const-reassignment
kind: compile
---

# static-ddl-const-reassignment

## 规范来源

[docs/spec/language/statements.rst](../../../../docs/spec/language/statements.rst)

<!-- prettier-ignore -->
> const、函数参数、reaction 的 previous / current 与 capture 绑定、属性、derived、记录字段与 sample / bytes 字段均不可赋值。

## 验收义务

前提：函数声明局部 const 后再次赋值。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn change() { const value = 1; value = 2; }
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
await assert.rejects(compile, '拒绝重赋值局部 const。');
```
