---
kind: comparison
---

# batch-execution-mixed-process-and-jit-equivalence

## 规范来源

[宿主合批开关](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> ``batchExecution`` 是显式布尔开关，省略为 ``false``；``true`` 仅在吞吐模式生效，精确模式保留逐指令路径。

[调度合批窗口](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 启用 ``batchExecution`` 的吞吐板可以在当前入口已经派发、即将执行模型代码时尝试合批。准入 MUST 同时满足：执行阶段可用；当前入口有效；模型 FIFO 与 JIT FIFO 为空；电气与观察队列已经完成发布闭包；当前入口是本轮唯一就绪入口。

[JIT 通用合批标记](../../../docs/spec/jit/throughput.rst)

<!-- prettier-ignore -->
> 可合批的 JIT 形状是单个带标记的循环头指令：``nextPc`` 指向不同退出地址，指令体为 ``if (cursor < limit)``，真分支执行一轮操作后按 ``redirect(headPc, d)`` 回到自身，假分支自然结束。

## 验收义务

前提：同一模型含一个过程填充循环和一个 JIT 填充循环，两者各自把 256 字节写成 42。过程在 3000 ps 后才开始循环，每轮 10 ps；JIT 从 0 ps 开始循环，每轮 10 ps。过程与 JIT 共用同一实例，过程通过 `registerProcessBatch` 登记第 0 个直接 `while`，JIT 在每次同步翻译中提交循环头标记。

操作：分别以 `batchExecution: false` 和 `true` 建立吞吐板；每种配置分别按单次推进、固定切片和带种子的累计切片推进到 7000 ps，记录完成消息、公开 memory、最终板时间与状态。

预期：所有运行的 JIT 完成消息都在 2560 ps 出现，过程完成消息都在 5560 ps 出现，两条消息的 cursor 都是 256；两个公开 memory 均为 256 个 42；最终板时间 7000、状态 ready。切片只改变推进边界，不能改变这些时间或内容；开启合批的板与关闭合批的板逐项一致。

## 对照输入

```json
{
  "model": "device BatchMixed(startAt: number default 0) {\n  assert isSafeInteger(startAt) && startAt >= 0;\n  public memory code[2];\n  public memory processBytes[256];\n  public memory jitBytes[256];\n  state processCursor: number = 0;\n  state jitCursor: number = 0;\n  state pc: number = 0;\n  record Done { tag: number; cursor: number; }\n  output channel done: Done(capacity: 8);\n  fn finishJit() { done.send({ tag: 2, cursor: jitCursor }); }\n  process start {\n    await ticks(startAt);\n    while processCursor < 256 {\n      store8(processBytes, processCursor, 42);\n      processCursor = processCursor + 1;\n      await ticks(10);\n    }\n    done.send({ tag: 1, cursor: processCursor });\n  }\n}",
  "description": {
    "instances": [
      {
        "id": "mixed",
        "type": "mixed",
        "props": {
          "startAt": 3000
        }
      }
    ],
    "nets": []
  },
  "fixedSlices": [1, 7, 39, 40, 41, 2559, 2560, 2561, 2999, 3000, 3001, 4000, 5559, 5560, 5561, 7000],
  "seeded": {
    "seed": 1586127412,
    "count": 24,
    "end": 7000,
    "maxStep": 700
  }
}
```

## 执行步骤

```typescript
const { createRun, messages, seededTargets, types } = await importModule('./batch-support.mjs');
const model = await adapter.compileDDL(inputs.model);

function attach(context) {
  context.registerProcessBatch({
    process: { kind: 'start', index: 0 },
    loop: 0,
  });
  context.attachJit({
    entry: 'cpu',
    code: 'code',
    pc: 'pc',
    translate(input, builder) {
      if (input.pc === 0) {
        builder.instruction({ pc: 0, nextPc: 1 }, (body) => {
          const cursor = body.readState('jitCursor', types.number);
          body.if(body.lessThan(cursor, 256), (step) => {
            step.store8('jitBytes', cursor, 42);
            step.writeState('jitCursor', step.add(cursor, 1));
            step.redirect(0, 10);
          });
        });
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
}

const schemes = [
  { name: 'single', targets: [7000] },
  { name: 'fixed', targets: inputs.fixedSlices },
  { name: 'seeded', targets: seededTargets(inputs.seeded) },
];
const runs = [];
for (const batchExecution of [false, true]) {
  for (const scheme of schemes) {
    const run = createRun(adapter, {
      id: 'mixed',
      model,
      description: inputs.description,
      options: { execution: 'throughput', batchExecution },
      create: attach,
    });
    t.after(run.board.dispose.bind(run.board));
    for (const target of scheme.targets) {
      run.board.runUntil(target);
      assert.equal(run.board.status, 'ready');
      assert.equal(run.board.time, target);
    }
    runs.push({ batchExecution, scheme: scheme.name, ...run });
  }
}
```

## 断言

```typescript
const expectedMessages = [
  { time: 2560, value: { tag: 2, cursor: 256 } },
  { time: 5560, value: { tag: 1, cursor: 256 } },
];
const expectedBytes = Array.from({ length: 256 }, () => 42);
for (const run of runs) {
  const label = `batchExecution=${run.batchExecution} scheme=${run.scheme}`;
  assert.deepEqual(messages(run.batches, 'done'), expectedMessages, label);
  assert.deepEqual([...run.contexts[0].memory.processBytes], expectedBytes, label);
  assert.deepEqual([...run.contexts[0].memory.jitBytes], expectedBytes, label);
  assert.equal(run.board.status, 'ready', label);
  assert.equal(run.board.time, 7000, label);
}

const outputs = (batchExecution, scheme) =>
  messages(
    runs.find((run) => run.batchExecution === batchExecution && run.scheme === scheme).batches,
    'done',
  );
for (const scheme of ['single', 'fixed', 'seeded']) {
  assert.deepEqual(outputs(true, scheme), outputs(false, scheme), scheme);
}
assert.deepEqual(outputs(true, 'seeded'), outputs(true, 'fixed'));
assert.deepEqual(outputs(false, 'seeded'), outputs(false, 'single'));
```
