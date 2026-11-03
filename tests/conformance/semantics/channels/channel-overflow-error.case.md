---
format: mica-case/v1
id: atomic-channel-overflow-error
kind: simulation
---

# 错误溢出使板故障且保留前缀

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 本次消息不入队，立即使整板进入 ``faulted``。

## 验收义务

前提：输出 `number` 通道的 `capacity` 为 1、`overflow` 为 `Overflow.error`；启动过程先成功发送 1 并把公开字节写为 7，再发送 2。

操作：通过真实 adapter 编译模型，推进到 0 并捕获本次推进的错误。

预期：第二条消息不入队并使整板进入 `faulted`，本次推进失败；没有 sync 批次，此前写入的公开字节仍为 7，后续的 9 不写入。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe { public memory evidence[1]; output channel out: number(capacity: 1, overflow: Overflow.error); process start { out.send(1); store8(evidence, 0, 7); out.send(2); store8(evidence, 0, 9); } }
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
const { device } = await importModule('../fixture.mjs');
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
assert.throws(
  () => board.runUntil(0),
  (error) => error.code === 'CHANNEL_OVERFLOW',
);
```

## 断言

```typescript
assert.equal(board.status, 'faulted');
assert.deepEqual([...context.memory.evidence], [7]);
assert.equal(batches.length, 0);
```
