---
kind: comparison
---

# jit-active-instruction-resumes-once-and-reselects-modified-code

## 规范来源

[docs/spec/jit/code-memory.rst](../../../docs/spec/jit/code-memory.rst)

[docs/spec/jit/execution.rst](../../../docs/spec/jit/execution.rst)

## 验收义务

前提：首条指令已执行前缀并在等待；等待期间修改后续代码。

操作：在等待中改码并推进跨越当前指令结束点，观察输出与翻译结果。

预期：不重放已执行前缀；当前旧指令完成后丢弃旧后缀块，并按新代码翻译下一位置。

## 对照输入

```json
{
  "models": {
    "jitProbe": "device JitProbe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n}"
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

const translations = [];
const { board, context, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.models.jitProbe),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input, builder) {
        const bytes = [...input.code];
        translations.push({ pc: input.pc, bytes });
        if (input.pc === 0) {
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.call('emit', bytes[0]);
            body.elapse(4);
            body.call('emit', 20);
          });
        }
        builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
          body.call('emit', bytes[1]);
          body.stop();
        });
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([1, 2]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));

board.runUntil(2);
assert.deepEqual(values(batches), [1]);
context.loadBytes('code', new Uint8Array([9]), 1);
board.runUntil(4);
assert.deepEqual(values(batches), [1]);
board.runUntil(5);
assert.deepEqual(values(batches), [1, 20, 9]);
assert.ok(translations.some((item) => item.pc === 1 && item.bytes[1] === 9));
board.runUntil(8);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 20, 9]);

board.dispose();
```
