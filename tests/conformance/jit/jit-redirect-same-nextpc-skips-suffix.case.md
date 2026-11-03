---
kind: comparison
---

# jit-redirect-same-nextpc-skips-suffix

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 即使 ``target`` 等于原顺序位置，也必须结束当前路径。比较位置数值不能替代该控制效果。

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> #. 终止当前指令或边界钩子的剩余路径，跨过所有同步辅助调用返回层。
> #. 跳过尚未执行的正常操作和耗时，保留已经发生的状态变化与意图。

## 验收义务

前提：首条指令通过辅助函数 redirect 到 1，其顺序后继也是 1；辅助调用之后还有一次输出和 5 ps 耗时。

操作：推进真实板并读取输出与时间戳。

预期：只执行目标指令并输出 7，时间戳为 0；后缀输出与耗时都被跳过，已发生的状态变化保留。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  fn jump() { redirect(1); }\n}",
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
      translate(input, builder) {
        if (input.pc === 0)
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.call('jump');
            body.call('emit', 88);
            body.elapse(5);
          });
        builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
          body.call('emit', 7);
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
assert.deepEqual(values(batches), [7]);
assert.equal(batches.at(-1).outputs.out[0].time, 0);
```
