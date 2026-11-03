---
format: mica-case/v1
id: host-input-overflow-fault-persists-after-catch
kind: simulation
---

# host-input-overflow-fault-persists-after-catch

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

[docs/spec/errors.rst](../../../docs/spec/errors.rst)

## 验收义务

前提：模型已把公开存储写为 7，容量 2 的 error 输入队列已满。

操作：发送第三条有效消息并捕获溢出异常，然后再次推进。

预期：板立即 faulted，公开存储仍为 7，首故障为 CHANNEL_OVERFLOW；后续推进报 BOARD_FAULTED 且不新增 sync 或首故障事件。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
        input channel incoming: number(capacity: 2, overflow: Overflow.error);
        public memory data[1];
        process start { store8(data, 0, 7); }
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
const { device, diagnostic } = await importModule('./fixture.mjs');

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

const errors = [];
board.onDidError((error) => errors.push(error));
board.runUntil(0);
context.inputs.incoming.send(1);
context.inputs.incoming.send(2);
```

## 断言

```typescript
assert.throws(() => context.inputs.incoming.send(3), diagnostic('CHANNEL_OVERFLOW'));
assert.equal(board.status, 'faulted');
assert.deepEqual([...context.memory.data], [7]);
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'CHANNEL_OVERFLOW');
assert.throws(() => board.runUntil(1), diagnostic('BOARD_FAULTED'));
assert.equal(errors.length, 1);
assert.equal(batches.length, 1);

board.dispose();
```
