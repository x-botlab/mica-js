---
kind: comparison
---

# jit-throughput-multiple-cpu-poll-order

## 规范来源

[吞吐执行安全边界](../../../docs/spec/jit/throughput.rst)

[稳定指令交错](../../../docs/spec/jit/execution.rst)

## 验收义务

两个 CPU 在同一时刻就绪时，自动轮询优化不能把原本在写入者之前读取的轮询移到写入者之后，从而提前退出等待。不能证明交错等价时使用逐指令执行。

## 对照输入

```json
{
  "model": "device Probe {\n  public memory code[2];\n  public memory ram[1];\n  state pcA: number = 0;\n  state pcB: number = 0;\n  output channel out: number(capacity: 8);\n  fn emit() { out.send(1); }\n}",
  "description": { "instances": [{ "id": "jit", "type": "jit" }], "nets": [] }
}
```

## 执行步骤

```typescript
const { setup } = await importModule('./fixture.mjs');
const model = await adapter.compileDDL(inputs.model);
async function execute(execution, cuts) {
  const { board, batches } = await setup(adapter, model, (ctx) => {
    ctx.attachJit({
      entry: 'cpuA', code: 'code', pc: 'pcA',
      translate(input, builder) {
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          if (input.pc === 0) {
            body.if(body.greaterThan(body.load8('ram', 0), 0),
              (yes) => yes.redirect(1, 10), (no) => no.redirect(0, 10));
          } else { body.call('emit'); body.stop(); }
        });
        return builder.finish();
      },
    });
    ctx.attachJit({
      entry: 'cpuB', code: 'code', pc: 'pcB',
      translate(input, builder) {
        builder.instruction({ pc: input.pc, nextPc: input.pc + 1 }, (body) => {
          body.elapse(10);
          body.store8('ram', 0, 1);
          body.stop();
        });
        return builder.finish();
      },
    });
  }, inputs.description, { execution });
  t.after(board.dispose.bind(board));
  for (const target of cuts) board.runUntil(target);
  return batches.flatMap((batch) => batch.outputs.out);
}
const precise = await execute('precise', [31]);
const throughput = await execute('throughput', [31]);
const sliced = await execute('throughput', [9, 10, 11, 20, 30, 31]);
```

## 断言

```typescript
assert.deepEqual(precise, [{ time: 30, value: 1 }]);
assert.deepEqual(throughput, precise);
assert.deepEqual(sliced, precise);
```
