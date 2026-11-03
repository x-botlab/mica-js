---
kind: compile
---

# jit-block-builder-cross-instruction-value

## 规范来源

[docs/spec/ir/builder.rst](../../../docs/spec/ir/builder.rst)

<!-- prettier-ignore -->
> 每条 JIT 指令独立拥有局部作用域；指令内的值和槽可跨其等待保留，指令之间通过实例 state 或 memory 传值。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_SCOPE
>   - 句柄归属、支配关系或局部可见性错误。

## 验收义务

前提：真实 JitBlockBuilder 在第一条指令中取得 load8 的值句柄，并在第二条指令中把它交给 store8。

操作：实际执行块构造与完成调用。

预期：完成被拒绝，诊断包含 IR_SCOPE。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createJitBlockBuilder();
  let saved;
  builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
    saved = body.load8('data', 0);
  });
  builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
    body.store8('data', 1, saved);
  });
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
