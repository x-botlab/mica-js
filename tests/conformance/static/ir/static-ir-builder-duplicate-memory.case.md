---
kind: compile
---

# static-ir-builder-duplicate-memory

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 声明检查名称唯一、合法类型位置、参数及字段重复、前向引用匹配、启动入口唯一、端点方向与配置，以及创建期图、derived 图、同步调用图无环。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_REFERENCE
>   - 名称不存在、类别不匹配、声明重复或资源归属错误。

## 验收义务

前提：真实 DeviceBuilder 两次以同名 data 声明 memory，随后调用 finish。

操作：实际执行构造与 finish 调用。

预期：构造或完成被拒绝，诊断包含 IR_REFERENCE。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createDeviceBuilder();
  builder.memory({ name: 'data', length: 2 });
  builder.memory({ name: 'data', length: 2 });
  return builder.finish();
};
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_REFERENCE'));
  return true;
});
```
