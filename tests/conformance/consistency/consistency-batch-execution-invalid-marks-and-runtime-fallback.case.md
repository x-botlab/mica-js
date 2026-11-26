---
kind: comparison
---

# batch-execution-invalid-marks-and-runtime-fallback

## 规范来源

[宿主合批声明](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 每次翻译都必须重新提交标记，包括器件复用已缓存块时；非法、重复或无法证明的标记只取消该入口的优化，原 ``BlockIR`` 仍通过现有翻译校验。

[调度合批窗口](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> ``modelStopBefore`` 省略时使用内部 ``Infinity``；状态已经到期时不产生可合批轮次。

[JIT 通用合批标记](../../../docs/spec/jit/throughput.rst)

<!-- prettier-ignore -->
> 非法、重复或无法证明的标记只取消对应入口的优化，原 ``BlockIR`` 仍须通过现有翻译校验；缓存替换或代码装载撤回旧路由，使用既有 ``revision``、代码失效和续体收尾机制。

## 验收义务

前提：模型同时含一个过程填充循环和一个 JIT 填充循环，各写 64 个字节、每轮 5 ps。过程登记时引用 `stopBefore: 'stopAt'`，该 number 状态的值为 `-1`，不是合法仿真时间。JIT 翻译对同一循环头重复提交两次 `markBatchLoop`，该重复标记应被丢弃而不是使翻译失败。

操作：分别以 `batchExecution: false` 和 `true` 建板，按固定切片推进到 321 ps，记录完成消息和公开 memory。

预期：两板创建和推进均不故障；重复 JIT 标记只取消 JIT 入口的优化，运行期非法 `stopBefore` 让过程本次走普通路径。两板均在 320 ps 先发送过程完成消息、再发送 JIT 完成消息，cursor 都是 64；公开 memory 为 64 个 7；最终板时间 321、状态 ready，开启与关闭合批的运行逐项一致。

## 对照输入

```json
{
  "model": "device BatchFallback {\n  public memory code[2];\n  public memory video[64];\n  state cursor: number = 0;\n  state stopAt: number = -1;\n  state jitCursor: number = 0;\n  state pc: number = 0;\n  record Done { tag: number; cursor: number; }\n  output channel out: Done(capacity: 8);\n  fn finishJit() { out.send({ tag: 2, cursor: jitCursor }); }\n  process start {\n    while cursor < 64 {\n      store8(video, cursor, 7);\n      cursor = cursor + 1;\n      await ticks(5);\n    }\n    out.send({ tag: 1, cursor: cursor });\n  }\n}",
  "description": {
    "instances": [
      {
        "id": "fallback",
        "type": "fallback"
      }
    ],
    "nets": []
  },
  "slices": [1, 5, 159, 319, 320, 321]
}
```

## 执行步骤

```typescript
const { createRun, messages, types } = await importModule('./batch-support.mjs');
const model = await adapter.compileDDL(inputs.model);
const runs = [];
for (const batchExecution of [false, true]) {
  const run = createRun(adapter, {
    id: 'fallback',
    model,
    description: inputs.description,
    options: { execution: 'throughput', batchExecution },
    create(context) {
      context.registerProcessBatch({
        process: { kind: 'start', index: 0 },
        loop: 0,
        stopBefore: 'stopAt',
      });
      context.attachJit({
        entry: 'cpu',
        code: 'code',
        pc: 'pc',
        translate(input, builder) {
          if (input.pc === 0) {
            builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
              const cursor = body.readState('jitCursor', types.number);
              body.if(body.lessThan(cursor, 64), (step) => {
                step.store8('video', cursor, 7);
                step.writeState('jitCursor', step.add(cursor, 1));
                step.redirect(0, 5);
              });
            });
            input.markBatchLoop?.({ pc: 0 });
            input.markBatchLoop?.({ pc: 0 });
          } else {
            builder.instruction({ pc: 1, nextPc: 2 }, (body) => {
              body.call('finishJit');
              body.stop();
            });
          }
          return builder.finish();
        },
      });
      context.loadBytes('code', new Uint8Array([0, 0]));
    },
  });
  t.after(run.board.dispose.bind(run.board));
  for (const target of inputs.slices) {
    run.board.runUntil(target);
    assert.equal(run.board.status, 'ready');
    assert.equal(run.board.time, target);
  }
  runs.push({ batchExecution, ...run });
}
```

## 断言

```typescript
const expected = [
  { time: 320, value: { tag: 1, cursor: 64 } },
  { time: 320, value: { tag: 2, cursor: 64 } },
];
const expectedBytes = Array.from({ length: 64 }, () => 7);
for (const run of runs) {
  const label = `batchExecution=${run.batchExecution}`;
  assert.deepEqual(messages(run.batches, 'out'), expected, label);
  assert.deepEqual([...run.contexts[0].memory.video], expectedBytes, label);
  assert.equal(run.board.status, 'ready', label);
  assert.equal(run.board.time, 321, label);
}
assert.deepEqual(messages(runs[1].batches, 'out'), messages(runs[0].batches, 'out'));
```
