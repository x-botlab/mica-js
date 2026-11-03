---
format: mica-case/v1
id: static-ir-builder-recursive-call
kind: compile
---

# static-ir-builder-recursive-call

## 规范来源

[docs/spec/ir/schema.rst](../../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 无环同步调用；pure 声明施加纯效果限制。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_DEPENDENCY
>   - 创建期、derived 或同步调用图中的非法依赖环。

## 验收义务

前提：真实 DeviceBuilder 的函数体通过 call 直接调用自身，随后调用 finish。

操作：实际执行构造与 finish 调用。

预期：构造或完成被拒绝，诊断包含 IR_DEPENDENCY。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createDeviceBuilder();
  builder.fn({ name: 'recur', params: [] }, (body) => body.call('recur'));
  return builder.finish();
};
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_DEPENDENCY'));
  return true;
});
```
