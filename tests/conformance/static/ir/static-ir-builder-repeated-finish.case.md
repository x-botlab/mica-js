---
kind: compile
---

# static-ir-builder-repeated-finish

## 规范来源

[docs/spec/ir/builder.rst](../../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 构造回调返回后，其 Builder 关闭；根构造器完成或构造失败后也关闭。再次追加操作或重复完成报告构造错误。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_LIFECYCLE
>   - 关闭后使用、重复完成或失败后继续构造。

## 验收义务

前提：根 DeviceBuilder 首次 finish 成功后再次调用 finish。

操作：实际执行两次完成调用。

预期：第二次完成被拒绝，诊断包含 IR_LIFECYCLE。

## 输入

```json
{}
```

## 执行步骤

```typescript
const builder = adapter.createDeviceBuilder();
builder.finish();
const attempt = () => builder.finish();
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_LIFECYCLE'));
  return true;
});
```
