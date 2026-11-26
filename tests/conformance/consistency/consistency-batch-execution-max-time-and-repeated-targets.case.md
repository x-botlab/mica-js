---
kind: comparison
---

# batch-execution-max-time-and-repeated-targets

## 规范来源

[执行时间范围](../../../docs/spec/execution/index.rst)

<!-- prettier-ignore -->
> 时间戳表示相对起点的位置，时长表示两个位置之间的间隔。两者的合法范围均为 0 至 7_200_000_000_000_000 ps，包含端点。时间接口 MUST 校验数值类型、有限性、整数性及范围。时间加法、减法和单位换算的结果也必须满足该范围。

[调度目标时刻](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> ``runUntil(T)`` 将耗时推进到 ``T``，并处理 ``T`` 到期的普通模型事件、输入事件及全部同步边界反应闭包，完成后才允许本批 sync。sync 不重新进入模型执行。

[调度合批窗口](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 恢复点 ``due`` MUST 严格早于 ``stop``。实现 MUST 先检查数值与余量，再乘加，并复核 ``n * d <= stop - t - 1``、相关值均为安全整数且时间在合法范围内。

## 验收义务

前提：过程在 7_199_999_999_999_890 ps 恢复，随后每 10 ps 写一个字节并把计数加一，循环上限为 16 字节。推进目标先取最大值前 1 ps，再取最大时间 7_200_000_000_000_000 ps。

操作：分别以 `batchExecution: false` 和 `true` 建板。先连续两次推进到最大值前 1 ps，再推进到最大时间，捕获错误后再次推进到最大时间。

预期：最大时间前 1 ps 的两次推进都保持 ready，板时间不前进、无输出，公开 memory 只提交前 11 个字节为 7。推进到最大时间时，合批不得越过上限；过程在最大时间写入第 12 个字节后，普通等待 10 ps 超出合法范围，推进以 `MODEL_EXECUTION_FAILED` 在 7_200_000_000_000_000 ps 故障。故障后重复推进以 `BOARD_FAULTED` 拒绝，板时间、状态、公开 memory 和输出均不变化。开启与关闭合批的两个运行逐项一致。

## 对照输入

```json
{
  "model": "device BatchMax {\n  public memory video[16];\n  state cursor: number = 0;\n  output channel done: number(capacity: 4);\n  process start {\n    await ticks(7_199_999_999_999_890);\n    while cursor < 16 {\n      store8(video, cursor, 7);\n      cursor = cursor + 1;\n      await ticks(10);\n    }\n    done.send(cursor);\n  }\n}",
  "description": {
    "instances": [
      {
        "id": "max",
        "type": "max"
      }
    ],
    "nets": []
  },
  "maxTime": 7200000000000000
}
```

## 执行步骤

```typescript
const { createRun, messages } = await importModule('./batch-support.mjs');
const model = await adapter.compileDDL(inputs.model);
const MAX = inputs.maxTime;
const runs = [];
for (const batchExecution of [false, true]) {
  const run = createRun(adapter, {
    id: 'max',
    model,
    description: inputs.description,
    options: { execution: 'throughput', batchExecution },
    create(context) {
      context.registerProcessBatch({
        process: { kind: 'start', index: 0 },
        loop: 0,
      });
    },
  });
  t.after(run.board.dispose.bind(run.board));
  const snapshot = () => ({
    time: run.board.time,
    status: run.board.status,
    memory: [...run.contexts[0].memory.video],
    output: messages(run.batches, 'done'),
  });

  run.board.runUntil(MAX - 1);
  const beforeRepeat = snapshot();
  run.board.runUntil(MAX - 1);
  const afterRepeat = snapshot();

  let fault;
  try {
    run.board.runUntil(MAX);
  } catch (error) {
    fault = error;
  }
  const faulted = snapshot();

  let repeated;
  try {
    run.board.runUntil(MAX);
  } catch (error) {
    repeated = error;
  }
  const afterRejected = snapshot();

  runs.push({
    batchExecution,
    beforeRepeat,
    afterRepeat,
    fault: {
      thrown: fault instanceof Error,
      code: fault?.code,
      phase: fault?.diagnostic?.phase,
      time: fault?.diagnostic?.time,
    },
    faulted,
    repeated: { thrown: repeated instanceof Error, code: repeated?.code },
    afterRejected,
  });
}
```

## 断言

```typescript
const readyMemory = [...Array.from({ length: 11 }, () => 7), ...Array(5).fill(0)];
const faultedMemory = [...Array.from({ length: 12 }, () => 7), ...Array(4).fill(0)];
const ready = {
  time: 7_199_999_999_999_999,
  status: 'ready',
  memory: readyMemory,
  output: [],
};
for (const run of runs) {
  const label = `batchExecution=${run.batchExecution}`;
  assert.deepEqual(run.beforeRepeat, ready, label);
  assert.deepEqual(run.afterRepeat, ready, label);
  assert.deepEqual(run.fault, {
    thrown: true,
    code: 'MODEL_EXECUTION_FAILED',
    phase: 'execute',
    time: 7_200_000_000_000_000,
  }, label);
  assert.deepEqual(run.faulted, {
    time: 7_200_000_000_000_000,
    status: 'faulted',
    memory: faultedMemory,
    output: [],
  }, label);
  assert.deepEqual(run.repeated, { thrown: true, code: 'BOARD_FAULTED' }, label);
  assert.deepEqual(run.afterRejected, run.faulted, label);
}
assert.deepEqual(runs[1].faulted, runs[0].faulted);
assert.deepEqual(runs[1].afterRejected, runs[0].afterRejected);
```
