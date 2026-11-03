---
kind: comparison
---

# jit-waituntil-stable-point-ignores-transient-true

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 等待依据稳定点的当前条件，而非每个中间片段或同步反应轮的历史边沿。模型队列及反应闭包稳定前暂时为 true、随后变为 false，不使已挂起等待完成；反应体之间不复查等待，也不恢复 JIT。需要保留短暂变化时，模型显式记入状态。

## 验收义务

前提：谓词依赖 state ready；启动过程在同一同步片段内先把 ready 置真再置假，4 ps 后再次置真。首条指令发送 1 后等待该谓词，位置 1 的指令发送 2 并停止。

操作：先推进到 1 ps，再推进到 5 ps。

预期：0 ps 的瞬态真值不让等待完成，只有 1 输出；ready 在 4 ps 稳定为真后发送 2。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state ready: bool = false;\n  pure fn awake(): bool { return ready; }\n  process start {\n    ready = true;\n    ready = false;\n    await ticks(4);\n    ready = true;\n  }\n}",
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
const { board, batches } = await setup(
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
            body.call('emit', 1);
            body.waitUntil('awake');
          });
        else
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
assert.deepEqual(values(batches), [1]);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2]);
assert.equal(batches.at(-1).outputs.out[0].time, 4);
```
