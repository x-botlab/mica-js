---
format: mica-case/v1
id: host-notification-last-time-and-final-public-memory
kind: simulation
---

# host-notification-last-time-and-final-public-memory

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

[docs/spec/memory.rst](../../../docs/spec/memory.rst)

## 验收义务

前提：模型在时间 0、2 发通知，时间 4 再把公开存储改为 3 而不通知。

操作：推进到 5，在 sync 中读取最终存储，再以同一目标推进一次。

预期：首批通知时间是 2，但 sync 读到存储 3；第二批无通知，输出为 null。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
        public memory data[1]; output notification changed;
        process start {
          store8(data, 0, 1); changed.notify();
          await ticks(2); store8(data, 0, 2); changed.notify();
          await ticks(2); store8(data, 0, 3);
        }
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
const { device } = await importModule('./fixture.mjs');

const observed = [];
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    sync(batch, ctx) {
      observed.push([...ctx.memory.data]);
    },
  },
  description,
);
t.after(board.dispose.bind(board));

board.runUntil(5);
assert.deepEqual(batches[0].outputs.changed, { time: 2 });
assert.deepEqual(observed, [[3]]);
board.runUntil(5);
```

## 断言

```typescript
assert.equal(batches[1].outputs.changed, null);

board.dispose();
```
