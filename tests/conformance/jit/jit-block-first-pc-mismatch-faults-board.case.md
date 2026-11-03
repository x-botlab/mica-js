---
kind: comparison
---

# jit-block-first-pc-mismatch-faults-board

## 规范来源

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 相邻指令的前一 nextPc 必须等于后一 pc；接纳时第一条 pc 必须匹配本次 translate 输入。

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

<!-- prettier-ignore -->
> 正在执行的 ``runUntil`` MUST 报告失败；已经故障的板再次调用 ``runUntil`` MUST 立即失败。

## 验收义务

前提：translate 为位置 0 返回的执行块把首条指令写成 pc 1，与实际翻译输入位置 0 不同。

操作：推进真实板一次，检查板状态，再以更大目标重复推进。

预期：首次推进报告失败且板进入 faulted；第二次推进同样失败。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n}",
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
const { setup } = await importModule('./fixture.mjs');
const { board } = await setup(
  adapter,
  await adapter.compileDDL(inputs.model),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        builder.instruction({ pc: input.pc + 1, nextPc: input.pc + 2 }, (body) => body.stop());
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([0]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
const advance = () => board.runUntil(1);
const repeat = () => board.runUntil(2);
```

## 断言

```typescript
assert.throws(advance);
assert.equal(board.status, 'faulted');
assert.throws(repeat);
```
