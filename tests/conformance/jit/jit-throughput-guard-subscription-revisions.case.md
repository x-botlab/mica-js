---
kind: comparison
---

# jit-throughput-guard-subscription-revisions

## 规范来源

[受保护执行段与动态依赖](../../../docs/spec/jit/throughput.rst)

## 验收义务

观察源在状态与内存之间切换时，直接执行屏障须随实际订阅更新。多个观察者共享资源时，移除其中一个订阅不得解除剩余观察者的屏障。最后一个订阅移除后可重新使用直接执行。中断条件短路分支新增实际读取依赖时，即使观察订阅未变，也须更新屏障。所有变化前后的值、时间及同刻顺序与精确执行相同。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[5];\n  public memory leftRam[1];\n  public memory rightRam[1];\n  state pc: number = 0;\n  state left: number = 0;\n  state right: number = 0;\n  state useLeft: bool = true;\n  state watchMemory: bool = false;\n  state secondLeft: bool = true;\n  state armed: bool = false;\n  state irqLeft: bool = false;\n  output channel out: number(capacity: 256);\n  derived watched: number = watchMemory ? (useLeft ? load8(leftRam, 0) : load8(rightRam, 0)) : (useLeft ? left : right);\n  derived second: number = secondLeft ? left : right;\n  derived take: bool = armed && (irqLeft ? left >= 4 : right >= 4);\n  reaction changed on watched as (previous, current) { out.send(current); }\n  reaction shared on second as (previous, current) { out.send(1000 + current); }\n  fn acknowledge() { out.send(9000 + left * 100 + right); armed = false; }\n  process start {\n    await ticks(7); useLeft = false;\n    await ticks(2); armed = true;\n    await ticks(2); secondLeft = false;\n    await ticks(2); watchMemory = true;\n    await ticks(4); useLeft = true;\n    await ticks(6); secondLeft = true; irqLeft = true; armed = true;\n    await ticks(6); watchMemory = false;\n  }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
async function execute(execution, interrupt, sliced) {
  const source = interrupt ? inputs.model
    .replace('  reaction changed on watched as (previous, current) { out.send(current); }\n', '')
    .replace('  reaction shared on second as (previous, current) { out.send(1000 + current); }\n', '')
    : inputs.model;
  const model = await adapter.compileDDL(source);
  const { board, batches } = await setup(adapter, model, (ctx) => ctx.attachJit({
    entry: 'cpu', code: 'code', pc: 'pc',
    ...(interrupt ? { beforeInstruction: { when: 'take', call: 'acknowledge' } } : {}),
    translate(input, builder) {
      for (let pc = input.pc; pc <= 4; pc++) {
        builder.instruction({ pc, nextPc: pc + 1 }, (body) => {
          if (pc === 4) body.redirect(0, 1);
          else {
            const name = pc < 2 ? 'left' : 'right';
            if (pc % 2 === 0)
              body.writeState(name, body.add(body.load8(`${name}Ram`, 0), 1));
            else body.store8(`${name}Ram`, 0, body.add(body.load8(`${name}Ram`, 0), 1));
            body.elapse(1);
          }
        });
      }
      return builder.finish();
    },
  }), inputs.description, { execution });
  t.after(board.dispose.bind(board));
  for (const target of sliced ? [6, 7, 9, 11, 13, 17, 18, 23, 29, 35] : [35])
    board.runUntil(target);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await execute('precise', false, false);
const throughput = await execute('throughput', false, false);
const sliced = await execute('throughput', false, true);
const preciseIrq = await execute('precise', true, false);
const throughputIrq = await execute('throughput', true, false);
const slicedIrq = await execute('throughput', true, true);
```

## 断言

```typescript
assert.deepEqual(throughput, precise);
assert.deepEqual(sliced, precise);
assert.deepEqual(throughputIrq, preciseIrq);
assert.deepEqual(slicedIrq, preciseIrq);
assert(precise.some((message) => message.time === 13));
assert(precise.some((message) => message.time === 17));
assert(precise.some((message) => message.value >= 1000 && message.value < 9000));
assert.equal(preciseIrq.filter((message) => message.value >= 9000).length, 2);
```
