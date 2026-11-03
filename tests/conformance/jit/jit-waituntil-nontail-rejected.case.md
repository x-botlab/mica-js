---
format: mica-case/v1
id: jit-waituntil-nontail-rejected
kind: compile
---

# jit-waituntil-nontail-rejected

## 规范来源

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> waitUntil 可以处于 if / match 的尾分支；从该位置返回各外层区域到指令末尾的路径不能再有可执行后缀，所在指令必须为块末条。

[docs/spec/ir/validation.rst](../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> * - IR_JIT_BOUNDARY
>   - 无效指令分组、块位置不匹配或 waitUntil 尾位置不合法。

## 验收义务

前提：真实 JitBlockBuilder 在单条指令内 waitUntil 之后追加 elapse。

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
    body.waitUntil('ready');
    body.elapse(1);
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
