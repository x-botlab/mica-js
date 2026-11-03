---
kind: compile
---

# static-ddl-reaction-named-start

## 规范来源

[docs/spec/appendices/grammar.rst](../../../../docs/spec/appendices/grammar.rst)

<!-- prettier-ignore -->
> start 专用于可选且唯一的启动过程；反应过程的 identifier 不能是 start。source-path 必须指向本实例可观察的静态资源路径或 input notification。过程不能出现在普通调用目标中。

## 验收义务

前提：reaction 使用保留的启动过程名称 `start`。

操作：编译该 device 定义。

预期：该定义被静态拒绝，并给出非空诊断消息；同特性合法形式见 `static-ddl-reaction-sync-effects`。

## 输入

```ddl
device StaticFixture {
state count: number = 0;
reaction start on count as (before, after) {
count = count + 1;
}
}
```

## 执行步骤

```typescript
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
