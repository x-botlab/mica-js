---
kind: compile
---

# static-ddl-channel-missing-direction

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 方向以 DDL 为参照，声明必须显式 input 或 output。通道的 capacity 必填，overflow 可省略；bytes 通道另需 maxLength，其他负载不能带该选项。选项名不可重复，容量、上限与策略均为创建期表达式。

## 验收义务

前提：channel 声明省略方向修饰符。

操作：编译该 device 定义。

预期：缺少显式 input 或 output 方向，该定义被静态拒绝并给出非空诊断消息；同特性合法形式见 `static-ddl-bytes-channel-config`。

## 输入

```ddl
device StaticFixture {
channel incoming: number(capacity: 2);
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
