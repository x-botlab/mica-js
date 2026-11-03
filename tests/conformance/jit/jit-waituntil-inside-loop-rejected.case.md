---
kind: compile
---

# jit-waituntil-inside-loop-rejected

## 规范来源

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 循环及计算子区域内拒绝 waitUntil。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_JIT_BOUNDARY
>   - 无效指令分组、块位置不匹配或 waitUntil 尾位置不合法。

## 验收义务

前提：真实 JitBlockBuilder 在单条指令的循环体中调用 waitUntil，尚未绑定谓词对应的实例。

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
  builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
    body.loop((inner) => {
      inner.waitUntil('ready');
    });
  });
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
