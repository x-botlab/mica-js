---
kind: compile
---

# static-ir-builder-append-after-return

## 规范来源

[docs/spec/ir/builder.rst](../../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 函数返回、break、continue、stop 等终结当前路径后继续追加操作，报告构造错误。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_CONTROL_FLOW
>   - 非法跳转、不可达后缀、未穷尽选择、缺失正常返回或 yield。

## 验收义务

前提：真实 DeviceBuilder 的 void 函数体先以 return 终结路径，随后在同一回调中追加对另一 void 函数的 call。

操作：实际执行构造与 finish 调用。

预期：构造或完成被拒绝，诊断包含 IR_CONTROL_FLOW。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createDeviceBuilder();
  builder.memory({ name: 'data', length: 1 });
  builder.fn({ name: 'next', params: [] }, () => {});
  builder.fn({ name: 'retire', params: [] }, (body) => {
    body.return();
    body.call('next');
  });
  return builder.finish();
};
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_CONTROL_FLOW'));
  return true;
});
```
