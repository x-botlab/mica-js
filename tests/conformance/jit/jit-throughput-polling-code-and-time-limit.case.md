---
kind: comparison
---

# jit-throughput-polling-code-and-time-limit

## 规范来源

[吞吐执行与轮询等待](../../../docs/spec/jit/throughput.rst)

[代码失效](../../../docs/spec/jit/code-memory.rst)

[时间范围](../../../docs/spec/execution/scheduling.rst)

## 验收义务

同值写代码也使自动轮询依赖失效；重新翻译与新代码执行仍落在原循环相位。跳过重复等待不隐藏绝对时间溢出，推进终点不启动该时刻的指令。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[1];\n  state pc: number = 0;\n  output channel out: number(capacity: 8);\n  fn emit() { out.send(1); }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
async function create(execution) {
  const translations = [];
  const state = await setup(adapter, model, (ctx) => {
    ctx.attachJit({
      entry: 'cpu', code: 'code', pc: 'pc',
      translate(input, builder) {
        translations.push(input.code[0]);
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          if (input.code[0] === 1) { body.call('emit'); body.stop(); }
          else body.redirect(0, 7);
        });
        return builder.finish();
      },
    });
  }, inputs.description, { execution });
  t.after(state.board.dispose.bind(state.board));
  return { ...state, translations };
}
async function patch(execution) {
  const { board, context, batches, translations } = await create(execution);
  board.runUntil(25);
  context.loadBytes('code', new Uint8Array([0]));
  board.runUntil(29);
  assert.deepEqual(translations, [0, 0]);
  context.loadBytes('code', new Uint8Array([1]));
  board.runUntil(35);
  assert.deepEqual(batches.flatMap((batch) => batch.outputs.out), []);
  board.runUntil(36);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await patch('precise');
const throughput = await patch('throughput');
const { board } = await create('throughput');
const maximum = 7_200_000_000_000_000;
const lastStart = maximum - maximum % 7;
board.runUntil(lastStart);
assert.equal(board.time, lastStart);
assert.equal(board.status, 'ready');
assert.throws(() => board.runUntil(maximum));
```

## 断言

```typescript
assert.deepEqual(precise, [{ time: 35, value: 1 }]);
assert.deepEqual(throughput, precise);
assert.equal(board.time, lastStart);
assert.equal(board.status, 'faulted');
```
