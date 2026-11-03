---
format: mica-case/v1
id: jit-nonadjacent-boundaries-rejected
kind: compile
---

# jit-nonadjacent-boundaries-rejected

## 规范来源

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 相邻指令的前一 nextPc 必须等于后一 pc；接纳时第一条 pc 必须匹配本次 translate 输入。末条 nextPc 可以指向块外。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_JIT_BOUNDARY
>   - 无效指令分组、块位置不匹配或 waitUntil 尾位置不合法。

## 验收义务

前提：真实 JitBlockBuilder 追加两条指令，第一条的 nextPc 为 1，第二条的 pc 为 2。

操作：实际执行块构造与完成调用。

预期：完成被拒绝，诊断包含 IR_JIT_BOUNDARY。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = () => {
  const builder = adapter.createJitBlockBuilder();
  builder.instruction({ pc: 0, nextPc: 1 }, (body) => body.elapse(1));
  builder.instruction({ pc: 2, nextPc: 3 }, (body) => body.stop());
  return builder.finish();
};
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
