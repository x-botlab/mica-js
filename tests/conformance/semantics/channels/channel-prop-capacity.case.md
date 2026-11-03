---
kind: simulation
---

# 容量由创建属性求值

## 规范来源

[docs/spec/channels.rst](../../../../docs/spec/channels.rst)

<!-- prettier-ignore -->
> 容量 ``capacity`` 显式给出，单位为消息条数，MUST 在创建期求值为正安全整数。

## 验收义务

前提：器件属性 `count` 的默认值为 1，装配显式提供 2；输出 `number` 通道的 `capacity` 引用 `count`，启动过程依次发送 1、2、3。

操作：通过真实 adapter 编译模型并推进到 0，收集输出通道交付的消息。

预期：`capacity` 在创建期求值为 2，交付 [1, 2]，第三条按默认 `drop_new` 策略丢弃。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe(count: number default 1) {
  output channel out: number(capacity: count);
  process start {
    out.send(1);
    out.send(2);
    out.send(3);
  }
}
```

## 装配

```json
{
  "instances": [
    {
      "id": "probe",
      "type": "probe",
      "props": {
        "count": 2
      }
    }
  ],
  "nets": []
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('../fixture.mjs');
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {},
  description,
);
t.after(() => board.dispose());
board.runUntil(0);
```

## 断言

```typescript
assert.deepEqual(values(batches), [1, 2]);
```
