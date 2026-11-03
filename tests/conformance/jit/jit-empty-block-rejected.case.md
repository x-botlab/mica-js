---
kind: compile
---

# jit-empty-block-rejected

## 规范来源

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> ``BlockIR.instructions`` 至少包含一条指令。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_JIT_BOUNDARY
>   - 无效指令分组、块位置不匹配或 waitUntil 尾位置不合法。

## 验收义务

前提：真实 JitBlockBuilder 没有追加任何指令就调用 finish。

操作：实际执行块构造与完成调用。

预期：完成被拒绝，诊断包含 IR_JIT_BOUNDARY。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => adapter.createJitBlockBuilder().finish();
```

## 断言

```typescript
assert.throws(attempt, (error) => {
  assert.ok(error && Array.isArray(error.diagnostics));
  assert.ok(error.diagnostics.length > 0);
  assert.ok(error.diagnostics.some((d) => d.code === 'IR_JIT_BOUNDARY'));
  return true;
});
```
