---
format: mica-case/v1
id: host-byte-length-validation-before-full-queue-overflow
kind: simulation
---

# host-byte-length-validation-before-full-queue-overflow

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

## 验收义务

前提：字节上限 2、容量 2 的 drop_oldest 输入队列已接纳空字节和两字节消息。

操作：发送三字节消息，捕获同步异常，再推进消费队列。

预期：板保持 ready，输出仍为空字节和原两字节消息；本例不约束该异常的具体类型或文本。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
        input channel incoming: bytes(maxLength: 2, capacity: 2, overflow: Overflow.drop_oldest);
        output channel out: bytes(maxLength: 2, capacity: 2);
        process start {
          let first = await incoming.receive(); out.send(first);
          let second = await incoming.receive(); out.send(second);
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
const { device, values } = await importModule('./fixture.mjs');

const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(board.dispose.bind(board));

context.inputs.incoming.send(new Uint8Array());
context.inputs.incoming.send(new Uint8Array([1, 2]));
assert.throws(() => context.inputs.incoming.send(new Uint8Array([3, 4, 5])));
assert.equal(board.status, 'ready');
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(
  values(batches).map((value) => [...value]),
  [[], [1, 2]],
);

board.dispose();
```
