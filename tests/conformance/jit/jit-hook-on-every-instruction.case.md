---
kind: comparison
---

# jit-hook-on-every-instruction

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 正常返回不原地重复调用钩子，即使条件仍为 true。条件是否清除由模型修改源状态决定。

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

<!-- prettier-ignore -->
> 同一块内每条指令都保持逻辑指令边界，不仅在进入块时检查一次。

## 验收义务

前提：beforeInstruction 的 when 状态恒为 true，单块包含两条指令，第一条指令完成后进入第二条。

操作：推进真实板一次。

预期：输出序列为钩子、第一条指令、钩子、第二条指令；同一边界不重复调用钩子。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state ready: bool = true;\n  fn hook() { out.send(10); }\n}",
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
const { setup, values } = await importModule('./fixture.mjs');
const translations = [];
const { board, context, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.model),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      beforeInstruction: { when: 'ready', call: 'hook' },
      translate(input, builder) {
        translations.push(input.pc);
        builder.instruction({ pc: 0, nextPc: 1 }, (body) => body.call('emit', 1));
        builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
          body.call('emit', 2);
          body.stop();
        });
        return builder.finish();
      },
    });
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
board.runUntil(1);
```

## 断言

```typescript
assert.deepEqual(values(batches), [10, 1, 10, 2]);
```
