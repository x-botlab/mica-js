---
kind: compile
---

# static-ddl-bytes-channel-missing-max

## 规范来源

[docs/spec/language/declarations.rst](../../../../docs/spec/language/declarations.rst)

<!-- prettier-ignore -->
> 方向以 DDL 为参照，声明必须显式 input 或 output。通道的 capacity 必填，overflow 可省略；bytes 通道另需 maxLength，其他负载不能带该选项。选项名不可重复，容量、上限与策略均为创建期表达式。

## 验收义务

前提：bytes input channel 仅指定 capacity，未指定 maxLength。

操作：编译该 device 定义。

预期：编译拒绝该定义。

## 输入

```ddl
device StaticFixture {
input channel incoming: bytes(capacity: 8);
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
await assert.rejects(compile, '拒绝 bytes 通道省略必填 maxLength。');
```
