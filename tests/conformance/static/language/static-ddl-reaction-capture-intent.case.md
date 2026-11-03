---
kind: compile
---

# static-ddl-reaction-capture-intent

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> previous / current 是源最终类型的不可变快照。每项 capture 从表达式推断类型，接受 number、bool、string、枚举、记录、bytes、sample 及其单层可空形式；intent、intent? 与资源引用拒绝。

## 验收义务

前提：capture 初始化为 intent 空列表。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
reaction observe on count as (before, after) capture saved = [] {}
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
await assert.rejects(compile, '拒绝 capture 产生 intent 值。');
```
