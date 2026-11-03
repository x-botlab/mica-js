---
kind: compile
---

# static-ir-builder-use-after-construct-failure

## 规范来源

[docs/spec/ir/builder.rst](../../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 构造回调返回后，其 Builder 关闭；根构造器完成或构造失败后也关闭。再次追加操作或重复完成报告构造错误。

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_LIFECYCLE
>   - 关闭后使用、重复完成或失败后继续构造。

## 验收义务

前提：真实 DeviceBuilder 已因把一个函数体取得的值句柄交给 start 过程体而构造失败，随后再向根 Builder 追加 memory 声明。

操作：捕获第一次构造失败，再实际执行后续追加调用。

预期：第一次失败抛出诊断；后续追加被拒绝，诊断包含 IR_LIFECYCLE。

## 输入

```json
{}
```

## 执行步骤

```typescript
const builder = adapter.createDeviceBuilder();
builder.memory({ name: 'data', length: 1 });
let foreign;
builder.fn({ name: 'read', params: [] }, (body) => {
  foreign = body.load8('data', 0);
});
let constructFailure;
try {
  builder.start((body) => body.store8('data', 0, foreign));
} catch (error) {
  constructFailure = error;
}
const attempt = () => builder.memory({ name: 'other', length: 1 });
```

## 断言

```typescript
assert.ok(constructFailure, 'cross-body handle must fail during construction');
assert.ok(Array.isArray(constructFailure.diagnostics));
assert.ok(constructFailure.diagnostics.length > 0);
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_LIFECYCLE'));
  return true;
});
```
