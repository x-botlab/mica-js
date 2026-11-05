---
kind: comparison
---

# jit-wide-block-cache-and-invalidation

## 规范来源

[指令边界与推进终点](../../../docs/spec/jit/execution.rst)

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

## 验收义务

前提：每块包含最多 32 条有独立耗时和输出的指令，块末跳回首地址；翻译捕获对应代码字节。

操作：重复执行已翻译块，在指令等待结束的推进终点修改未来代码，分别整段和不规则切片推进。

预期：每个 PC 命中自己的指令入口，热块不重复翻译；推进终点不开始或恢复指令。改码不重放当前指令，旧缓存失效后从当前 PC 翻译后缀，随后从首地址翻译新块；输出值、时刻和翻译入口均符合独立预期。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[32];\n  state pc: number = 0;\n  output channel out: number(capacity: 256);\n  fn emit(value: number) { out.send(value); }\n}",
  "description": {
    "instances": [{ "id": "jit", "type": "jit" }],
    "nets": []
  }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
const expected = Array.from({ length: 128 }, (_, time) => ({
  time,
  value: time >= 80 && time % 32 === 20 ? 200 : time % 32,
}));

async function execute(cuts) {
  const translations = [];
  const { board, context, batches } = await setup(
    adapter,
    model,
    (ctx) => {
      ctx.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        translate(input, builder) {
          translations.push(input.pc);
          for (let pc = input.pc; pc < 32; pc++) {
            const value = input.code[pc];
            builder.instruction({ pc, nextPc: pc + 1 }, (body) => {
              body.call('emit', value);
              if (pc === 31) body.redirect(0, 1);
              else body.elapse(1);
            });
          }
          return builder.finish();
        },
      });
      ctx.loadBytes('code', Uint8Array.from({ length: 32 }, (_, index) => index));
    },
    inputs.description,
  );
  t.after(board.dispose.bind(board));
  const messages = () => batches.flatMap((batch) => batch.outputs.out);
  for (const target of cuts) {
    board.runUntil(target);
    assert.deepEqual(messages(), expected.slice(0, target));
    board.runUntil(target);
    assert.deepEqual(messages(), expected.slice(0, target));
  }
  assert.equal(board.time, 80);
  assert.deepEqual(translations, [0]);
  context.loadBytes('code', new Uint8Array([200]), 20);
  board.runUntil(80);
  assert.deepEqual(messages(), expected.slice(0, 80));
  assert.deepEqual(translations, [0]);
  board.runUntil(128);
  assert.equal(board.status, 'ready');
  assert.deepEqual(translations, [0, 16, 0]);
  return messages();
}

const whole = await execute([80]);
const sliced = await execute([1, 16, 31, 32, 33, 63, 64, 79, 80]);
```

## 断言

```typescript
assert.deepEqual(whole, expected);
assert.deepEqual(sliced, expected);
```
