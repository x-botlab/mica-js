---
kind: compile
---

# static-ddl-intent-state-type

## 规范来源

[docs/spec/language/types.rst](../../../../docs/spec/language/types.rst)

<!-- prettier-ignore -->
> * - 器件级 const、state
>      - number、bool、string、枚举、记录、bytes 及其可空形式。

## 验收义务

前提：state 的显式类型为 intent。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
state branches: intent = [];
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
await assert.rejects(compile, '初始意图扩展不允许 state 使用 intent 类型。');
```
