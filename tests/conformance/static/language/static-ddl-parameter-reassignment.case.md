---
kind: compile
---

# static-ddl-parameter-reassignment

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> 所有形参类型显式给出，参数不可重新赋值；需要修改时先建立 let 副本。

## 验收义务

前提：函数直接给 number 形参重新赋值。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
fn change(value: number) { value = 2; }
}
```

## 执行步骤

```typescript
const compile = async () => {
  await adapter.compileDDL(input);
};
```

## 断言

```typescript
await assert.rejects(compile, '拒绝重赋值函数值形参。');
```
