---
format: mica-case/v1
id: static-ddl-process-intent-source
kind: compile
---

# static-ddl-process-intent-source

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> intent 与 intent? 不作为变化触发源。

## 验收义务

前提：反应过程以 intent derived 为源。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
derived branches: intent = []; process observe on branches {}
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
await assert.rejects(compile, '拒绝 intent derived 作为过程变化源。');
```
