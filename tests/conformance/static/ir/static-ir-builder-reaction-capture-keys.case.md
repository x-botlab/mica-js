---
kind: compile
---

# static-ir-builder-reaction-capture-keys

## 规范来源

[docs/spec/ir/validation.rst](../../../../docs/spec/ir/validation.rst)

<!-- prettier-ignore -->
> Builder 的 capture 回调对象键集合必须与描述名称完全一致，额外或缺失回调在构造阶段拒绝。

[docs/spec/ir/builder-api.rst](../../../../docs/spec/ir/builder-api.rst)

<!-- prettier-ignore -->
> 第二参数是按 capture 名称索引的构造回调对象，每个回调获得独立的 ``ReactionCaptureBody<T>``，用 returnValue 交付声明类型的纯计算结果；键集合须与描述完全一致。

## 验收义务

前提：真实 DeviceBuilder 以同一 reaction 描述（单个 capture saved）分别传入完全一致、多一个额外键、缺失该键三种回调对象。

操作：三次实际执行构造与 finish 调用。

预期：一致的回调对象完成并返回 device；额外键与缺失键两次都在构造阶段被拒绝，诊断阶段为 construct。

## 输入

```json
{}
```

## 执行步骤

```typescript
const attempt = (shape) => {
  const builder = adapter.createDeviceBuilder();
  const mode = builder.enum({ name: 'Mode', members: ['a', 'b'] });
  builder.state({ name: 'modeState', type: mode, initial: mode.members.a });
  const capture = (body) => body.returnValue(body.constant(mode, mode.members.a));
  let captures = { saved: capture };
  if (shape === 'missing') captures = {};
  if (shape === 'extra') captures = { saved: capture, extra: capture };
  builder.reaction(
    {
      name: 'watch',
      sourcePath: ['modeState'],
      sourceType: mode,
      previous: 'before',
      current: 'after',
      captures: [{ name: 'saved', type: mode }],
    },
    captures,
    () => {},
  );
  return builder.finish();
};
const valid = attempt('exact');
const extraAttempt = () => attempt('extra');
const missingAttempt = () => attempt('missing');
```

## 断言

```typescript
assert.equal(valid.kind, 'device');
for (const run of [extraAttempt, missingAttempt]) {
  assert.throws(run, (error) => {
    assert.ok(error && Array.isArray(error.diagnostics));
    assert.ok(error.diagnostics.length > 0);
    assert.ok(error.diagnostics.every((diagnostic) => diagnostic.phase === 'construct'));
    return true;
  });
}
```
