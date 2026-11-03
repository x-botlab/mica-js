---
format: mica-case/v1
id: static-ir-builder-cross-body-value
kind: compile
---

# static-ir-builder-cross-body-value

## 规范来源

[docs/spec/ir/builder.rst](../../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 函数、过程、reaction 响应、每项 reaction capture 及独立 JIT 块之间不复用值或局部句柄。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCOPE
>   - 句柄归属、支配关系或局部可见性错误。

## 验收义务

前提：真实 DeviceBuilder 在函数体的构造回调中保存 load8 得到的值句柄，并在 start 过程体中把它交给 store8。

操作：实际执行构造与 finish 调用。

预期：构造或完成被拒绝，诊断包含 IR_SCOPE。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createDeviceBuilder();
  builder.memory({ name: 'data', length: 1 });
  let saved;
  builder.fn({ name: 'read', params: [] }, (body) => {
    saved = body.load8('data', 0);
  });
  builder.start((body) => body.store8('data', 0, saved));
  return builder.finish();
};
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_SCOPE'));
  return true;
});
```
