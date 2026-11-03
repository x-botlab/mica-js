---
kind: simulation
---

# 运行期越界电阻构造使整板故障

## 规范来源

[docs/spec/electrical.rst](../../../../docs/spec/electrical.rst)

<!-- prettier-ignore -->
> 运行期非法构造属于框架错误，使整板 ``faulted``；尚未执行的 intent 赋值不发生，之前的资源效果保留。合法数值不替代实例归属与目标类别检查。

<!-- prettier-ignore -->
> 诊断至少区分非法电气参数、矛盾固定电位装配与数值求解失败。参数错误定位所属实例、引脚声明或构造操作，装配错误定位网络，求解错误定位相关网络或分量；运行期诊断包含当前仿真时间与失败原因。

[docs/spec/javascript/host.rst](../../../../docs/spec/javascript/host.rst)

<!-- prettier-ignore -->
> INVALID_ELECTRICAL_PARAMETER / CONFLICTING_REFERENCE / ELECTRICAL_SOLVE_FAILED | 非法电气参数、参考装配冲突或数值求解失败，定位要求见 :doc:`/electrical`。

## 验收义务

前提：引脚 `signal` 的初始意图为空；启动过程先把公开存储首字节写为 1，再以取自可变 `state` 的 0 Ω 构造支路（避免静态常量折叠），随后把第二字节写为 2 并发送输出。

操作：通过真实 adapter 编译模型并推进到 0，捕获本次推进的错误。

预期：0 Ω 低于闭区间下限，电阻构造在运行期失败；整板 `faulted`，第二字节与输出都不发生，第一字节保留。规范把“非法电气参数”固定为 INVALID_ELECTRICAL_PARAMETER，并要求参数错误定位构造操作、运行期诊断携带当前仿真时间，因此断言该码与 `time` 为 0；规范没有为该失败指定 phase，本用例不断言 phase。推进失败以 `SimulationError` 报告并携带同一主诊断，同特性的合法端点由 `pin-resistor-range-endpoints-accepted` 覆盖。

## 模型

<!-- prettier-ignore -->
```ddl
device Probe {
  output channel out: number(capacity: 8);
  public memory evidence[2];
  state requested: number = 0;
  pin signal(low: 0.8, high: 2.0);
  pin reference;
  process start {
    store8(evidence, 0, 1);
    signal.intent <- [resistor(to: reference, resistance: requested)];
    store8(evidence, 1, 2);
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
      "type": "probe"
    }
  ],
  "nets": [
    {
      "id": "reference",
      "voltage": 0,
      "pins": [
        {
          "instance": "probe",
          "pin": "reference"
        }
      ]
    }
  ]
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
t.after(board.dispose.bind(board));

assert.throws(() => board.runUntil(0), (error) => {
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'INVALID_ELECTRICAL_PARAMETER');
  assert.equal(error.diagnostic.code, error.code);
  assert.equal(error.diagnostic.time, 0);
  return true;
});
```

## 断言

```typescript
assert.equal(board.status, 'faulted');
assert.deepEqual([...context.memory.evidence], [1, 0]);
assert.equal(batches.length, 0);
```
