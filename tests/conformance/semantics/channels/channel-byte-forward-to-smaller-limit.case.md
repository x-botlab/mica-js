---
kind: simulation
---

# 转发字节按目标通道上限校验

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 字节值本身不携带通道上限；向另一个通道转发时，按目标 ``maxLength`` 校验实际长度：来自上限 256 的通道、实际长度为 32 的字节值，可以发送到上限 64 的通道。

## 验收义务

前提：输入通道 `chunks` 的 `maxLength` 为 4，输出通道 `copies` 的 `maxLength` 为 2；模型把收到的字节原样转发。

操作：两块独立板共用该模型；A 板注入两字节消息，B 板注入三字节消息，各自推进到 0。

预期：A 板交付内容为 [1, 2] 的两字节消息并保持 `ready`；B 板的输入合法但转发违反输出上限，本次推进以执行故障失败，没有 sync 批次。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  input channel chunks: bytes(maxLength: 4, capacity: 4);
  output channel copies: bytes(maxLength: 2, capacity: 4);
  process start {
    let first = await chunks.receive();
    copies.send(first);
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
const { device, fault, values } = await importModule('../fixture.mjs');
const model = await adapter.compileDDL(modelSource);

const accepted = await device(
  adapter,
  model,
  {
    create(ctx) {
      ctx.inputs.chunks.send(new Uint8Array([1, 2]));
    },
  },
  description,
);
t.after(accepted.board.dispose.bind(accepted.board));
accepted.board.runUntil(0);

const rejected = await device(
  adapter,
  model,
  {
    create(ctx) {
      ctx.inputs.chunks.send(new Uint8Array([1, 2, 3]));
    },
  },
  description,
);
t.after(rejected.board.dispose.bind(rejected.board));
fault(rejected.board, () => rejected.board.runUntil(0));
```

## 断言

```typescript
const forwarded = values(accepted.batches, 'copies')[0];
assert.deepEqual([...forwarded], [1, 2]);
assert.equal(accepted.board.status, 'ready');

assert.equal(rejected.board.status, 'faulted');
assert.equal(rejected.batches.length, 0);
```
