---
kind: compile
---

# static-ir-builder-unresolved-call

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> 未解析引用必须在接纳为可执行代码前完成检查。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_REFERENCE
>   - 名称不存在、类别不匹配、声明重复或资源归属错误。

## 验收义务

前提：真实 DeviceBuilder 的 start 过程体通过 call 引用器件中不存在的函数名，随后调用 finish。

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
  builder.start((body) => body.call('missing'));
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
