---
kind: compile
---

# static-ddl-reaction-notification-source

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> source 为本实例 state、derived 或 pin.sample 起始的单一静态路径，允许访问其静态字段，最终类型必须可比较；notification 不能作为 reaction 源。

## 验收义务

前提：reaction 以 input notification 为源。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
input notification changed; reaction observe on changed as (before, after) {}
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
await assert.rejects(compile, '拒绝 input notification 作为 reaction 源。');
```
