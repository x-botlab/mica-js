---
kind: comparison
---

# jit-target-defers-suffix-after-model-timer-and-reaction

## 规范来源

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：JIT 耗时恰好在目标 T 完成，同期存在模型定时器与 reaction。

操作：推进到 T，重复调用同一目标，再以更大目标推进。

预期：T 到期的普通事件和 reaction 在 sync 前生效；JIT 后缀在相同 T 不运行，目标增大后恢复。

## 对照输入

```json
{
  "models": {
    "jitProbe": "device JitProbe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state trigger: number = 0;\n  reaction observe on trigger as (old, current) { out.send(100); }\n  process start {\n    await ticks(4);\n    out.send(99);\n    trigger = 1;\n  }\n}"
  },
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
  await adapter.compileDDL(inputs.models.jitProbe),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          body.call('emit', 1);
          body.elapse(4);
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

board.runUntil(4);
assert.deepEqual(values(batches), [1, 99, 100]);
board.runUntil(4);
assert.deepEqual(values(batches), [1, 99, 100]);
assert.equal(board.time, 4);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 99, 100, 2]);
assert.equal(batches.at(-1).outputs.out[0].time, 4);

board.dispose();
```
