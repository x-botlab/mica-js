---
kind: comparison
---

# jit-throughput-observation-and-hook-guards

## 规范来源

[吞吐执行的安全回退](../../../docs/spec/jit/throughput.rst)

[指令边界](../../../docs/spec/jit/execution.rst)

## 验收义务

基本块写入中断条件依赖或被观察的资源时必须保留逐指令发布与中断检查。吞吐模式与精确模式具有相同的输出值、顺序和时刻。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[3];\n  public memory ram[1];\n  state pc: number = 0;\n  state acc: number = 0;\n  state enabled: bool = true;\n  output channel out: number(capacity: 32);\n  derived take: bool = enabled && acc >= 3;\n  fn enter() { out.send(acc); enabled = false; redirect(2, delay: 1); }\n  fn report() { out.send(load8(ram, 0)); }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
async function execute(execution, observe) {
  const source = observe ? inputs.model.replace('  fn enter()',
    '  reaction observed on acc as (old, current) { out.send(current); }\n  fn enter()') : inputs.model;
  const model = await adapter.compileDDL(source);
  const { board, batches } = await setup(adapter, model, (ctx) => {
    ctx.attachJit({
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
    });
  }, inputs.description, { execution });
  t.after(board.dispose.bind(board));
  board.runUntil(20);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await execute('precise', false);
const throughput = await execute('throughput', false);
const observedPrecise = await execute('precise', true);
const observedThroughput = await execute('throughput', true);
```

## 断言

```typescript
assert.deepEqual(precise, [{ time: 5, value: 3 }, { time: 6, value: 3 }]);
assert.deepEqual(throughput, precise);
assert.deepEqual(observedPrecise, [
  { time: 0, value: 1 }, { time: 2, value: 2 }, { time: 4, value: 3 },
  { time: 5, value: 3 }, { time: 6, value: 3 },
]);
assert.deepEqual(observedThroughput, observedPrecise);
```
