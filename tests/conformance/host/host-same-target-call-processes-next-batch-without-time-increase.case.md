---
format: mica-case/v1
id: host-same-target-call-processes-next-batch-without-time-increase
kind: simulation
---

# host-same-target-call-processes-next-batch-without-time-increase

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

## 验收义务

前提：板已推进到 3，再暂存输入 7 和触发其消费者的通知。

操作：再次调用 runUntil(3)。

预期：两次推进均返回 undefined；第二批为 3 到 3 并输出 7，时间不增加。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
        input channel incoming: number(capacity: 2); input notification wake;
        output channel out: number(capacity: 2);
        process receiveOne on wake { let n = await incoming.receive(); out.send(n); }
       }
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe"
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('./fixture.mjs');

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

assert.equal(board.runUntil(3), undefined);
context.inputs.incoming.send(7);
context.inputs.wake.notify();
```

## 断言

```typescript
assert.equal(board.runUntil(3), undefined);
assert.equal(board.time, 3);
assert.deepEqual(values(batches), [7]);
assert.deepEqual(
  batches.map((batch) => [batch.from, batch.to]),
  [
    [0, 3],
    [3, 3],
  ],
);

board.dispose();
```
