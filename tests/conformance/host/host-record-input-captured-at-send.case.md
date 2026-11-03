---
kind: simulation
---

# host-record-input-captured-at-send

## 规范来源

[docs/spec/channels.rst](../../../docs/spec/channels.rst)

## 验收义务

前提：输入记录含声明字段 n、ready 和额外字段 extra。

操作：发送后修改原对象，再推进获取输出，继续推进并销毁。

预期：输出仅包含发送时 n 为 7、ready 为 true 的声明字段；已交付记录跨后续推进及销毁保留内容。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe {
  record Item {
    n: number;
    ready: bool;
  }
  input channel incoming: Item(capacity: 2);
  output channel out: Item(capacity: 2);
  process start {
    let item = await incoming.receive();
    out.send(item);
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

const payload = { n: 7, ready: true, extra: 99 };
context.inputs.incoming.send(payload);
payload.n = 9;
payload.ready = false;
board.runUntil(0);
assert.deepEqual(values(batches), [{ n: 7, ready: true }]);
board.runUntil(1);
```

## 断言

```typescript
assert.deepEqual(values(batches), [{ n: 7, ready: true }]);

board.dispose();

assert.deepEqual(values(batches), [{ n: 7, ready: true }]);
```
