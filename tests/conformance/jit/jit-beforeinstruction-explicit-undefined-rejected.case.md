---
kind: compile
---

# jit-beforeinstruction-explicit-undefined-rejected

## 规范来源

[docs/spec/jit/index.rst](../../../docs/spec/jit/index.rst)

<!-- prettier-ignore -->
> 可选 ``beforeInstruction`` 仅省略时表示无钩子，显式 ``undefined`` 或 ``null`` 按原值校验并拒绝；其他可选字段同样只有省略才采用默认。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 可选字段仅在省略时采用默认值；显式传入 ``undefined`` 或 ``null`` 时按原值校验，只有语言允许可空的位置接受 ``null``。

## 验收义务

前提：同一模型与同一 translate 回调分别建立两块板：第一块省略 beforeInstruction，第二块显式写 beforeInstruction: undefined。

操作：实际执行两次 createBoard。

预期：省略钩子的板状态为 ready；显式 undefined 的板创建被拒绝。

## 输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n}",
  "description": {
    "instances": [
      {
        "id": "jit",
        "type": "jit"
      }
    ],
    "nets": []
  }
}
```

## 执行步骤

```typescript
const model = await adapter.compileDDL(input.model);
const translate = (position, builder) => {
  builder.instruction({ pc: position.pc, nextPc: position.pc + 1 }, (body) => body.stop());
  return builder.finish();
};
const build = (hook) => {
  const library = adapter.createDeviceLibrary([
    {
      id: 'jit',
      model,
      create(ctx) {
        const options = { entry: 'cpu', code: 'code', pc: 'pc', translate };
        ctx.attachJit(hook ? { ...options, beforeInstruction: undefined } : options);
        return { sync() {}, dispose() {} };
      },
    },
  ]);
  return adapter.createBoard(library, input.description);
};
const baseline = build(false);
t.after(baseline.dispose.bind(baseline));
const attempt = () => build(true);
```

## 断言

```typescript
assert.equal(baseline.status, 'ready');
assert.throws(attempt);
```
