---
kind: comparison
---

# jit-throughput-polling-phase

## 规范来源

[吞吐执行与轮询等待](../../../docs/spec/jit/throughput.rst)

## 验收义务

自动证明的无副作用轮询可跳过重复执行，但外部事件不能使 CPU 提前观察输入。依赖变化后按原循环相位重新执行，显式等待标记则按模型声明等待。中断条件属于唤醒依赖。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  public memory ram[1];\n  state pc: number = 0;\n  state irq: bool = false;\n  output channel out: number(capacity: 8);\n  pure fn awake(): bool { return load8(ram, 0) > 0; }\n  fn emit(value: number) { out.send(value); }\n  fn enter() { irq = false; redirect(1, delay: 2); }\n  process start {\n    await ticks(25);\n    store8(ram, 0, 1);\n    irq = true;\n  }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
async function execute(execution, annotated, interrupt, cuts) {
  const source = interrupt ? inputs.model.replace('    store8(ram, 0, 1);', '') : inputs.model;
  const model = await adapter.compileDDL(source);
  const { board, batches } = await setup(adapter, model, (ctx) => {
    ctx.attachJit({
      entry: 'cpu', code: 'code', pc: 'pc',
      ...(annotated ? { polling: [{ pc: 0, predicate: 'awake' }] } : {}),
      ...(interrupt ? { beforeInstruction: { when: 'irq', call: 'enter' } } : {}),
      translate(input, builder) {
        if (input.pc === 0) {
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            body.if(body.greaterThan(body.load8('ram', 0), 0),
              (yes) => yes.redirect(1, 10),
              (no) => no.redirect(0, 10));
          });
        } else {
          builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
            body.call('emit', 7);
            body.stop();
          });
        }
        return builder.finish();
      },
    });
  }, inputs.description, { execution, cpuQuantum: 7 });
  t.after(board.dispose.bind(board));
  for (const target of cuts) board.runUntil(target);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await execute('precise', false, false, [41]);
const automatic = await execute('throughput', false, false, [9, 10, 24, 25, 29, 30, 40, 41]);
const automaticIrq = await execute('throughput', false, true, [25, 31, 32, 33]);
const preciseIrq = await execute('precise', false, true, [33]);
const annotated = await execute('throughput', true, false, [25, 35, 36]);
const annotatedIrq = await execute('throughput', true, true, [25, 27, 28]);
const preciseIgnoresMarker = await execute('precise', true, false, [41]);
```

## 断言

```typescript
assert.deepEqual(precise, [{ time: 40, value: 7 }]);
assert.deepEqual(automatic, precise);
assert.deepEqual(automaticIrq, [{ time: 32, value: 7 }]);
assert.deepEqual(preciseIrq, automaticIrq);
assert.deepEqual(annotated, [{ time: 35, value: 7 }]);
assert.deepEqual(annotatedIrq, [{ time: 27, value: 7 }]);
assert.deepEqual(preciseIgnoresMarker, precise);
```
