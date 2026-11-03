---
format: mica-case/v1
id: atomic-channel-received-local-cross-batch
kind: simulation
---

# 已接收值跨批次等待保留

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 清理只影响尚未接收的输入。过程已经接收到局部变量中的值、挂起位置和恢复所需数据跨批次保留。

## 验收义务

前提：输入通道在首批注入唯一值 7；启动过程接收后把值存入局部变量，再等待 3 ps 后发送该局部变量。

操作：先推进到 1，再推进到 3，分别观察两批输出。

预期：推进到 1 时没有输出；推进到 3 时交付已接收的 7，接收值、挂起位置与恢复数据跨批次保留。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe { output channel out: number(capacity: 8); input channel incoming: number(capacity: 1); process start { let saved = await incoming.receive(); await ticks(3); out.send(saved); } }
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
const { device, values } = await importModule('../fixture.mjs');
const { board, context, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
context.inputs.incoming.send(7);
board.runUntil(1);
assert.deepEqual(values(batches), []);
board.runUntil(3);
```

## 断言

```typescript
assert.deepEqual(values(batches), [7]);
```
