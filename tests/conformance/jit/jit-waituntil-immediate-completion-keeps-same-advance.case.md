---
kind: comparison
---

# jit-waituntil-immediate-completion-keeps-same-advance

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 进入等待时先检查谓词；已为 true 则立即完成，不额外让出。为 false 则建立观察、保存恢复位置并结束片段。

[docs/spec/ir/schema.rst](../../../docs/spec/ir/schema.rst)

<!-- prettier-ignore -->
> 立即满足也只结束该指令路径，不执行额外后缀。

## 验收义务

前提：指令先发送 1，再以恒为 true 的 pure 谓词 waitUntil；块的后续指令位于 nextPc 1。

操作：只推进到 1 ps 一次，记录输出时间与翻译位置。

预期：首次推进内完成等待并执行后一条指令，输出 1 与 2 都发生在 0 ps。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state ready: bool = true;\n  pure fn awake(): bool { return ready; }\n}",
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
      translate(input, builder) {
        translations.push(input.pc);
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
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2]);
for (const batch of batches)
  for (const message of batch.outputs.out) assert.equal(message.time, 0);
assert.deepEqual(translations, [0, 1]);
```
