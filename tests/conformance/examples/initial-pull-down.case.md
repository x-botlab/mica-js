---
kind: simulation
---

# 初始下拉参与首次求解

一个输入通过 10 kΩ 上拉接 3.3 V，同时通过 1 MΩ 下拉接地。两条支路都在 pin 声明中建立；start 只读取采样，不设置输出意图。

首次求解的预期电压是：

$$
V = 3.3 \times \frac{1\,000\,000}{10\,000 + 1\,000\,000}
  \approx 3.267326733\ \mathrm{V}
$$

因此输入应为 valid、high。这里的下拉是本样本的建模选择，不是所有输入的隐含行为。

## 规范来源

[docs/spec/electrical.rst](../../../docs/spec/electrical.rst)

[docs/spec/execution/scheduling.rst](../../../docs/spec/execution/scheduling.rst)

## 验收义务

前提：输入通过 10 kΩ 上拉接 3.3 V、通过 1 MΩ 下拉接地；start 读取采样，reaction 订阅采样变化。

操作：编译模型、按装配建立板并推进到 1 ps，收集读数与通知。

预期：首次读数为 valid、high，电压以 1e-8 V 容差匹配 3.3/1.01；changed 为空，初始基线不触发 reaction。

## 模型

```ddl
device InitialPullDown {
  record Reading {
    voltage: number;
    high: bool;
    valid: bool;
  }

  pin input(low: 0.8, high: 2.0) = [
    resistor(to: supply, resistance: 10_000),
    resistor(to: reference, resistance: 1_000_000)
  ];
  pin supply;
  pin reference;

  output channel readings: Reading(capacity: 1, overflow: Overflow.error);
  output notification changed;

  process start {
    const sampled = input.sample;
    const voltage = sampled.voltage;
    if voltage != none {
      readings.send({
        voltage: voltage,
        high: sampled.level == Logic.high,
        valid: sampled.status == SampleStatus.valid
      });
    } else {
      assert false, "initial sample must have a reference voltage";
    }
  }

  reaction observe on input.sample as (previous, current) {
    changed.notify();
  }
}
```

## 装配

电源与地由板级固定参考提供。模型中的前向 pin 引用保持原样，用来验证声明顺序不影响初始支路。

```json
{
  "instances": [{ "id": "probe", "type": "trial/InitialPullDown" }],
  "nets": [
    {
      "id": "supply",
      "voltage": 3.3,
      "pins": [{ "instance": "probe", "pin": "supply" }]
    },
    {
      "id": "reference",
      "voltage": 0,
      "pins": [{ "instance": "probe", "pin": "reference" }]
    },
    {
      "id": "input",
      "pins": [{ "instance": "probe", "pin": "input" }]
    }
  ]
}
```

## 执行步骤

编译模型、建立板，再推进到 1 ps。通过工厂的 sync 收集公开输出，不读取运行时内部状态。

```typescript
const model = await adapter.compileDDL(modelSource);
const batches: Array<{
  from: number;
  to: number;
  outputs: {
    readings: ReadonlyArray<{
      time: number;
      value: { voltage: number; high: boolean; valid: boolean };
    }>;
    changed: { time: number } | null;
  };
}> = [];

const library = adapter.createDeviceLibrary([
  {
    id: 'trial/InitialPullDown',
    model,
    create() {
      return {
        sync(batch) {
          batches.push(batch);
        },
        dispose() {},
      };
    },
  },
]);

const board = adapter.createBoard(library, description);
t.after(() => board.dispose());
board.runUntil(1);
```

## 断言

预期来自电阻分压公式，而不是从被测实现生成。电压比较显式采用 10 nV 绝对容差；时间与逻辑状态精确比较。

```typescript
assert.equal(board.time, 1);
assert.equal(board.status, 'ready');
assert.equal(batches.length, 1);

const batch = batches[0]!;
assert.equal(batch.from, 0);
assert.equal(batch.to, 1);
assert.equal(batch.outputs.readings.length, 1);
assert.equal(batch.outputs.changed, null);

const reading = batch.outputs.readings[0]!;
assert.equal(reading.time, 0);
assert.equal(reading.value.high, true);
assert.equal(reading.value.valid, true);
assert.ok(Number.isFinite(reading.value.voltage));
assert.ok(Math.abs(reading.value.voltage - 3.3 / 1.01) <= 1e-8);
```

## 格式说明

这是仿真类文件格式示例。正式执行副本位于 `semantics/electrical/`；本目录仅供阅读，不重复登记。一个用例说明一项明确义务；规范引用只标出处，不据此声称整段规范均已覆盖。它只断言上面列出的行为，不代表覆盖 C-153、C-155 的全部分支。

加载器提供 `adapter`、Node 测试上下文 `t`、`node:assert/strict` 的 `assert`，并将模型代码块与装配代码块分别绑定为 `modelSource` 和 `description`。执行步骤与断言按顺序在同一个异步测试作用域执行；`t.after` 在失败时也释放板。
