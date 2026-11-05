---
kind: comparison
---

# jit-throughput-event-horizon

## 规范来源

[受保护执行段与事件视界](../../../docs/spec/jit/throughput.rst)

## 验收义务

时间预算不是固定调度步长。无中间观察者的数值循环可推进到下一真实事件；非指令周期对齐的外设 IRQ、指令前缀与后缀、目标时刻及观察者屏障仍保持精确顺序。最小预算与默认预算给出相同结果。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[3];\n  public memory ram[1];\n  state pc: number = 0;\n  state acc: number = 0;\n  state enabled: bool = true;\n  state irq: bool = false;\n  output channel out: number(capacity: 64);\n  derived take: bool = enabled && irq;\n  fn enter() { out.send(acc); enabled = false; redirect(2, delay: 1); }\n  fn report() { out.send(load8(ram, 0)); }\n  process start { await ticks(25); irq = true; }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
async function execute(execution, cpuQuantum, observed, sliced) {
  const source = observed ? inputs.model.replace('  fn enter()',
    '  reaction observed on acc as (old, current) { out.send(current); }\n  fn enter()') : inputs.model;
  const model = await adapter.compileDDL(source);
  const { board, batches } = await setup(adapter, model, (ctx) => ctx.attachJit({
    entry: 'cpu', code: 'code', pc: 'pc',
    beforeInstruction: { when: 'take', call: 'enter' },
    translate(input, builder) {
      if (input.pc === 2) {
        builder.instruction({ pc: 2, nextPc: 3 }, (body) => {
          body.call('report'); body.stop();
        });
      } else {
        if (input.pc === 0) {
          builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
            const value = body.add(body.load8('ram', 0), 1);
            body.store8('ram', 0, value);
            body.writeState('acc', value);
            body.elapse(1);
          });
        }
        builder.instruction({ pc: 1, nextPc: 0 }, (body) => body.redirect(0, 1));
      }
      return builder.finish();
    },
  }), inputs.description, { execution, cpuQuantum });
  t.after(board.dispose.bind(board));
  if (sliced) {
    board.runUntil(25);
    const before = batches.flatMap((batch) => batch.outputs.out);
    assert.equal(before.some((message) => message.time === 25), false,
      'target event must not execute the JIT hook at the target');
    board.runUntil(26);
    assert.equal(batches.flatMap((batch) => batch.outputs.out)
      .some((message) => message.time === 26), false,
      'IRQ delay finishing at target must not resume the report suffix');
  }
  board.runUntil(40);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await execute('precise', 1, false, false);
const minimumBudget = await execute('throughput', 1, false, true);
const defaultBudget = await execute('throughput', 10000000, false, false);
const observedPrecise = await execute('precise', 1, true, false);
const observedThroughput = await execute('throughput', 10000000, true, true);
```

## 断言

```typescript
assert.deepEqual(precise, [{ time: 25, value: 13 }, { time: 26, value: 13 }]);
assert.deepEqual(minimumBudget, precise);
assert.deepEqual(defaultBudget, precise);
assert.deepEqual(observedThroughput, observedPrecise);
assert.deepEqual(observedPrecise.slice(0, 13),
  Array.from({ length: 13 }, (_, index) => ({ time: index * 2, value: index + 1 })));
assert.deepEqual(observedPrecise.slice(13), precise);
```
