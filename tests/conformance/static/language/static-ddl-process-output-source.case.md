---
kind: compile
---

# static-ddl-process-output-source

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> source 为一个静态名称或成员路径，根为本实例 state、derived、pin.sample 或 input notification，字段必须由静态类型确认；不接受调用、运算或动态索引。

## 验收义务

前提：反应过程以 output notification 为源。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
output notification changed; process observe on changed {}
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
await assert.rejects(compile, '拒绝 output notification 作为反应过程源。');
```
