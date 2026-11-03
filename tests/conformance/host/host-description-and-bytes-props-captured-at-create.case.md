---
kind: simulation
---

# 板创建捕获描述与字节属性

## 规范来源

[docs/spec/javascript/host.rst](../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> 创建时捕获实例、网表、属性、选项和随机初始状态。字节属性复制其视图范围，运行时不重新读取外部描述。

[docs/spec/assembly.rst](../../../docs/spec/assembly.rst)

<!-- prettier-ignore -->
> 装配 MUST 捕获输入字节快照，使调用方随后修改原始数组不影响实例。DDL 和配对 JavaScript 使用这份固定内容，ReadonlyBytes 快照可跨推进和销毁留存。

## 验收义务

前提：模型带 `bytes` 属性与一个经 1 kΩ 上拉到 3.3 V 的引脚；装配的字节属性以 `Uint8Array` 在创建前提供。

操作：创建板后把供电网电位改为 0 V、把原字节数组全部写为 9，并把 `description.instances` 清空；随后推进到 0 并读取输出与 `ctx.props`。

预期：模型与工厂都看到创建时捕获的内容：首字节仍是 5，采样电压仍约 3.3 V，`ctx.props.data` 仍是 [5, 6]；后续修改外部描述与数组都不生效。

## 模型

<!-- prettier-ignore -->
```ddl
device HostProbe(data: bytes) {
  output channel out: number(capacity: 4);
  pin signal(low: 0.8, high: 2.0) = [resistor(to: supply, resistance: 1000)];
  pin supply;
  process start {
    out.send(data[0]);
    const sampled = signal.sample;
    if sampled.voltage != none {
      out.send(sampled.voltage);
    } else {
      out.send(-1);
    }
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
  "nets": [
    {
      "id": "supply",
      "voltage": 3.3,
      "pins": [
        {
          "instance": "probe",
          "pin": "supply"
        }
      ]
    }
  ]
}
```

## 执行步骤

```typescript
const { device, values } = await importModule('./fixture.mjs');
description.instances[0].props = { data: new Uint8Array([5, 6]) };
const observedProps = [];
const { board, batches } = await device(
  adapter,
  await adapter.compileDDL(modelSource),
  {
    sync(batch, ctx) {
      observedProps.push([...ctx.props.data]);
    },
  },
  description,
);
t.after(board.dispose.bind(board));

description.nets[0].voltage = 0;
description.instances[0].props.data.fill(9);
description.instances.length = 0;
board.runUntil(0);
```

## 断言

```typescript
const delivered = values(batches);
assert.equal(delivered[0], 5);
assert.ok(Math.abs(delivered[1] - 3.3) <= 1e-9);
assert.deepEqual(observedProps, [[5, 6]]);
assert.equal(board.status, 'ready');
```
