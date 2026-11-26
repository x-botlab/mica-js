---
kind: comparison
---

# batch-execution-half-open-event-and-two-devices

## 规范来源

[调度合批窗口](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 通过准入的第 ``k`` 轮等价于在 ``t + k * d`` 写入，``k`` 从 0 到 ``n - 1``；恢复点 ``due`` MUST 严格早于 ``stop``。

[调度合批窗口](../../../docs/spec/execution/scheduling.rst)

<!-- prettier-ignore -->
> 合批 MUST 保持逐项可观察等价：跳过的内部唤醒不改变外部事件的相对稳定顺序；区间内没有其它入队动作，且 ``due`` 早于全部外部边界。

[宿主合批开关](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 启用后，过程与 JIT 入口可在同一个调度准入点提交多个无观察交错的轮次；关闭或未提供候选时保持原执行路径。

## 验收义务

前提：同一类型装配两个实例。实例 `first` 的过程从 0 ps 开始，每轮 10 ps 把 16 个字节写成 42；实例 `second` 的过程等待 1000 ps 后才开始同样的循环。`first` 另有一个由宿主通知启动的快照过程，在 40 ps 读取共享 `cursor` 并发送快照。40 ps 正好是填充循环第 4 轮后的恢复点，外部快照事件必须在第 40 ps 的那一轮之前执行。

操作：分别以 `batchExecution: false` 和 `true` 建板，通知 `first` 的快照输入，然后按固定切片 `[1, 39, 40, 41, 159, 160, 161, 999, 1000, 1160, 1200]` 推进。

预期：两个实例都只发送各自的过程完成消息，`first` 在 160 ps 完成、`second` 在 1160 ps 完成；快照在 40 ps 发送且 cursor 为 4，即不包含 40 ps 当刻开始的第 5 轮。两个实例的公开 memory 最终都是 16 个 42；开启与关闭合批的运行逐项一致，最终板时间 1200、状态 ready。

## 对照输入

```json
{
  "model": "device BatchEvent(delay: number default 0) {\n  assert isSafeInteger(delay) && delay >= 0;\n  public memory video[16];\n  state cursor: number = 0;\n  record Note { tag: number; cursor: number; }\n  output channel out: Note(capacity: 16);\n  input notification snap;\n  process start {\n    await ticks(delay);\n    while cursor < 16 {\n      store8(video, cursor, 42);\n      cursor = cursor + 1;\n      await ticks(10);\n    }\n    out.send({ tag: 1, cursor: cursor });\n  }\n  process snapshot on snap {\n    await ticks(40);\n    out.send({ tag: 2, cursor: cursor });\n  }\n}",
  "description": {
    "instances": [
      {
        "id": "first",
        "type": "event",
        "props": {
          "delay": 0
        }
      },
      {
        "id": "second",
        "type": "event",
        "props": {
          "delay": 1000
        }
      }
    ],
    "nets": []
  },
  "slices": [1, 39, 40, 41, 159, 160, 161, 999, 1000, 1160, 1200]
}
```

## 执行步骤

```typescript
const { createRun, messages } = await importModule('./batch-support.mjs');
const model = await adapter.compileDDL(inputs.model);
const runs = [];
for (const batchExecution of [false, true]) {
  const run = createRun(adapter, {
    id: 'event',
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
  run.contexts[0].inputs.snap.notify();
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
  { time: 40, value: { tag: 2, cursor: 4 } },
  { time: 160, value: { tag: 1, cursor: 16 } },
  { time: 1160, value: { tag: 1, cursor: 16 } },
];
const expectedBytes = Array.from({ length: 16 }, () => 42);
for (const run of runs) {
  const label = `batchExecution=${run.batchExecution}`;
  assert.deepEqual(messages(run.batches, 'out'), expected, label);
  assert.deepEqual([...run.contexts[0].memory.video], expectedBytes, label);
  assert.deepEqual([...run.contexts[1].memory.video], expectedBytes, label);
  assert.equal(run.board.status, 'ready', label);
  assert.equal(run.board.time, 1200, label);
}
assert.deepEqual(messages(runs[1].batches, 'out'), messages(runs[0].batches, 'out'));
```
