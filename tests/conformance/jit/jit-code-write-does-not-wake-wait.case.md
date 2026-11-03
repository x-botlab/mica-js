---
kind: comparison
---

# jit-code-write-does-not-wake-wait

## 规范来源

[docs/spec/jit/interrupts.rst](../../../docs/spec/jit/interrupts.rst)

<!-- prettier-ignore -->
> 代码版本变化不单独唤醒条件等待，醒来后再按版本规则选取后续路径。

## 验收义务

前提：首条指令先发送消息，再以当前为 false 的 pure 谓词 waitUntil；模型过程在 4 ps 把该状态置真。等待期间向代码存储写入后继字节 9。

操作：先推进到 3 ps，再推进到 5 ps。

预期：3 ps 时仍在等待，没有新翻译也没有新输出；5 ps 等待完成后按新代码继续，输出 9 且不重放已执行前缀。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n  state ready: bool = false;\n  pure fn awake(): bool { return ready; }\n  process start {\n    await ticks(4);\n    ready = true;\n  }\n}",
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
        translations.push(input.pc);
        if (input.pc === 0)
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.call('emit', 1);
            body.waitUntil('awake');
          });
        else
          builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
            body.call('emit', input.code[1]);
            body.stop();
          });
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([0, 2]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
board.runUntil(1);
assert.deepEqual(values(batches), [1]);
context.loadBytes('code', new Uint8Array([9]), 1);
board.runUntil(3);
assert.deepEqual(values(batches), [1]);
assert.deepEqual(translations, [0]);
board.runUntil(5);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 9]);
assert.deepEqual(translations, [0, 1]);
```
