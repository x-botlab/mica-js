---
kind: comparison
---

# jit-redirect-delay-defers-target-until-elapsed

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> #. 消费 ``delay``，结束后重新进入指令边界。

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> delay 期间依赖可以变化，但该延时先完成，再重入边界；它不因条件变化提前结束。

## 验收义务

前提：首条指令发送 1 后调用以 delay 5 转向位置 2 的辅助函数，其后还有一次发送 88；启动过程在 2 ps 发送 99。位置 2 的指令发送 2 并停止。

操作：推进真实板到 6 ps，记录每次翻译的板时间与输出时间。

预期：99 在 2 ps 到达，位置 2 的翻译与 2 的输出都在 5 ps；88 不执行。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  fn jump() { redirect(2, delay: 5); }\n  process start {\n    await ticks(2);\n    out.send(99);\n  }\n}",
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
let live;
const { board, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.model),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        translations.push({ pc: input.pc, time: live.time });
        if (input.pc === 0)
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.call('emit', 1);
            body.call('jump');
            body.call('emit', 88);
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
live = board;
t.after(board.dispose.bind(board));
board.runUntil(6);
const messages = () =>
  batches.flatMap((batch) =>
    batch.outputs.out.map((message) => ({ value: message.value, time: message.time })),
  );
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 99, 2]);
assert.deepEqual(messages(), [
  { value: 1, time: 0 },
  { value: 99, time: 2 },
  { value: 2, time: 5 },
]);
assert.deepEqual(translations, [
  { pc: 0, time: 0 },
  { pc: 2, time: 5 },
]);
```
