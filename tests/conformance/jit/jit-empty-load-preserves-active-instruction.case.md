---
kind: comparison
---

# jit-empty-load-preserves-active-instruction

## 规范来源

[docs/spec/jit/code-memory.rst](../../../docs/spec/jit/code-memory.rst)

<!-- prettier-ignore -->
> 校验失败不部分写入、不改变代码版本或稳定期；空装载仍校验全部条件，通过后不改变字节、版本或稳定期。

## 验收义务

前提：单指令循环回到同一位置，先输出 7 再耗时 2 ps；1 ps 暂停时对代码存储执行合法空装载。

操作：再推进到 3 ps。

预期：代码内容仍为 [3,0]；0 ps 与 2 ps 各输出一次 7，已执行的指令前缀不重放。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  state pc: number = 0;\n  output channel out: number(capacity: 32);\n  fn emit(value: number) { out.send(value); }\n}",
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
        builder.instruction({ pc: 0, nextPc: 0 }, (body) => {
          body.call('emit', 7);
          body.elapse(2);
        });
        return builder.finish();
      },
    });
    ctx.loadBytes('code', new Uint8Array([3]));
  },
  inputs.description,
);
t.after(board.dispose.bind(board));
board.runUntil(1);
assert.deepEqual(values(batches), [7]);
context.loadBytes('code', new Uint8Array([]));
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7, 7]);
assert.deepEqual([...context.memory.code], [3, 0]);
assert.deepEqual(
  batches.flatMap((batch) => batch.outputs.out.map((message) => message.time)),
  [0, 2],
);
```
