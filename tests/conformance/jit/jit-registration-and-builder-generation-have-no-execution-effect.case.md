---
kind: comparison
---

# jit-registration-and-builder-generation-have-no-execution-effect

## 规范来源

[docs/spec/jit/code-memory.rst](../../../docs/spec/jit/code-memory.rst)

## 验收义务

前提：工厂 `attachJit` 只绑定；随后使用真实 Builder 生成指令块。

操作：登记后先观察是否翻译或执行，再推进板。

预期：登记与生成均无执行效果；推进后 Builder 指令调用模型函数并到达 stop。

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
const { board, batches } = await setup(
  adapter,
  await adapter.compileDDL(inputs.models.jitProbe),
  (ctx) => {
    ctx.attachJit({
      entry: 'cpu',
      code: 'code',
      pc: 'pc',
      translate(input) {
        translations.push(input.pc);
        const builder = adapter.createJitBlockBuilder();
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
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

assert.equal(board.status, 'ready');
assert.deepEqual(translations, []);
assert.deepEqual(batches, []);
board.runUntil(1);
assert.deepEqual(values(batches), [7]);
assert.ok(translations.length > 0);
board.runUntil(2);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7]);

board.dispose();
```
