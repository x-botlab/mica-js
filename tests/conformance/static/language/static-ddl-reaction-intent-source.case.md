---
kind: compile
---

# static-ddl-reaction-intent-source

## 规范来源

[docs/spec/language/functions.rst](../../../../docs/spec/language/functions.rst)

<!-- prettier-ignore -->
> source 为本实例 state、derived 或 pin.sample 起始的单一静态路径，允许访问其静态字段，最终类型必须可比较；notification 不能作为 reaction 源。调用、运算、动态索引及多个源路径均拒绝；多源观察先用 derived 构造具名扁平记录，再以该 derived 为源。

## 验收义务

前提：reaction 以 `probe.intent` 作为源路径。

操作：先编译仅修正该错误点的近邻定义（见执行步骤），再编译该 device 定义。

预期：源必须以 state、derived 或 pin.sample 起始，该定义被静态拒绝并给出非空诊断消息；近邻把源改为 pin.sample 字段即合法。

## 输入

```ddl
device StaticFixture {
pin probe(low: 0.8, high: 2.0);
state count: number = 0;
reaction observe on probe.intent as (before, after) {
count = count + 1;
}
}
```

## 执行步骤

```typescript
const neighbor = `device StaticFixture {
pin probe(low: 0.8, high: 2.0);
state count: number = 0;
reaction observe on probe.sample.level as (before, after) {
count = count + 1;
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
