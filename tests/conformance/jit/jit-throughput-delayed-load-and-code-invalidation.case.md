---
kind: comparison
---

# jit-throughput-delayed-load-and-code-invalidation

## 规范来源

[指令边界与推进终点](../../../docs/spec/jit/execution.rst)

[代码存储与失效](../../../docs/spec/jit/code-memory.rst)

[吞吐执行](../../../docs/spec/jit/throughput.rst)

## 验收义务

直接执行的基本块在外部事件之前让出。事件可以修改寄存器、RAM 与代码；已执行前缀不能重放，挂起指令保留旧的读取结果并恰好完成一次后缀。推进终点不恢复后缀，新代码从下一个 PC 翻译。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  public memory ram[2];\n  state pc: number = 0;\n  state acc: number = 0;\n  state repair: bool = false;\n  output channel out: number(capacity: 8);\n  fn fix() { pc = 1; repair = false; }\n  fn emit() { out.send(acc); out.send(load8(ram, 1)); out.send(load8(ram, 0)); }\n  process start {\n    await ticks(7);\n    acc = 77;\n    store8(ram, 0, 99);\n    store8(code, 0, 9);\n  }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
async function execute(execution, cuts, cpuQuantum, invalidPc = '') {
  const source = invalidPc ? inputs.model.replace('    acc = 77;',
    `    pc = ${invalidPc};\n    repair = true;\n    acc = 77;`) : inputs.model;
  const model = await adapter.compileDDL(source);
  const translations = [];
  const { board, context, batches } = await setup(adapter, model, (ctx) => {
    ctx.attachJit({
      entry: 'cpu', code: 'code', pc: 'pc',
      beforeInstruction: { when: 'repair', call: 'fix' },
      translate(input, builder) {
        translations.push({ pc: input.pc, code: input.code[0] });
        if (input.code[0] === 9) {
          builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
            body.call('emit');
            body.stop();
          });
        } else {
          if (input.pc === 0) {
            builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
              body.store8('ram', 0, body.add(body.load8('ram', 0), 1));
              const captured = body.load8('ram', 0);
              body.writeState('acc', captured);
              body.elapse(3);
              body.store8('ram', 1, captured);
            });
          }
          builder.instruction({ pc: 1, nextPc: 0 }, (body) => body.redirect(0, 2));
        }
        return builder.finish();
      },
    });
  }, inputs.description, { execution, cpuQuantum });
  t.after(board.dispose.bind(board));
  for (const target of cuts) board.runUntil(target);
  assert.equal(board.time, 8);
  assert.deepEqual(batches.flatMap((batch) => batch.outputs.out), []);
  assert.deepEqual([...context.memory.ram], [99, 1]);
  board.runUntil(8);
  assert.deepEqual([...context.memory.ram], [99, 1]);
  board.runUntil(9);
  return { messages: batches.flatMap((batch) => batch.outputs.out), translations };
}
const precise = await execute('precise', [8], 10_000_000);
const throughput = await execute('throughput', [8], 10_000_000);
const sliced = await execute('throughput', [1, 3, 5, 6, 7, 8], 2);
for (const invalidPc of ['0 / 0', '1 / 0', '-1 / 0']) {
  assert.deepEqual(await execute('precise', [8], 10_000_000, invalidPc), precise);
  assert.deepEqual(await execute('throughput', [8], 10_000_000, invalidPc), precise);
}
```

## 断言

```typescript
assert.deepEqual(precise.messages, [
  { time: 8, value: 77 }, { time: 8, value: 2 }, { time: 8, value: 99 },
]);
assert.deepEqual(throughput, precise);
assert.deepEqual(sliced, precise);
assert.deepEqual(precise.translations, [{ pc: 0, code: 0 }, { pc: 1, code: 9 }]);
```
