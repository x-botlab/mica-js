---
kind: comparison
---

# jit-hook-pc-assignment-selects-next-instruction

## 规范来源

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

<!-- prettier-ignore -->
> 边界钩子普通赋值后正常返回时，按该钩子返回后的最终位置准备新指令，不能使用钩子调用前的旧位置。

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 处理函数可以普通赋值，包括修改绑定的 ``pc`` state；普通赋值继续其余语句，不等同于控制转向。

## 验收义务

前提：beforeInstruction 的条件恒为 true；首条指令把位置推进到 1，钩子函数在位置为 1 时普通赋值 pc 为 2。位置 1 与 2 各自的指令分别发送 50 与 2。

操作：推进真实板一次，记录翻译位置与输出。

预期：钩子赋值后按最终位置 2 准备指令，只发送 1 与 2；位置 1 不被翻译或执行。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state ready: bool = true;\n  fn hook() {\n    if pc == 1 {\n      pc = 2;\n    }\n  }\n}",
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
const { board, batches } = await setup(
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
        if (input.pc === 0)
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => body.call('emit', 1));
        else if (input.pc === 1)
          builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
            body.call('emit', 50);
            body.stop();
          });
        else
          builder.instruction({ pc: 2, nextPc: 3 }, (body) => {
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
assert.deepEqual(values(batches), [1, 2]);
assert.deepEqual(translations, [0, 2]);
```
