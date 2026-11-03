---
kind: compile
---

# static-ddl-reaction-capture-binding-scope

## 规范来源

[docs/spec/language/lexical.rst](../../../../docs/spec/language/lexical.rst)

<!-- prettier-ignore -->
> reaction 的名称也属于器件名称空间。其 previous / current 和 capture 绑定共同建立仅在响应体可见的不可变局部作用域，彼此名称必须唯一，不能遮蔽器件成员或内置名称；响应体内的局部也不能遮蔽它们。捕获初始化表达式不处于该绑定作用域中，不能引用其中任何名称。

## 验收义务

前提：capture 初始化试图读取 previous 绑定。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
reaction observe on count as (before, after) capture saved = before {}
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
await assert.rejects(compile, '拒绝 capture 初始化读取 previous/current 绑定。');
```
