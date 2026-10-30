---
'@mica-js/simulator': major
---

电气仿真改为线性电阻网络，并移除旧布尔 / 线或路径、固定电轨与宿主直写引脚。

- 移除 `CircuitCompilationOptions.rails`、`CircuitElectricalOptions.rails` 与 `DEFAULT_RAILS` 导出。非 `GND` 参考必须用 `sources` 显式声明：`electrical: { sources: { VDD: { voltage: 5 } } }`；`GND` 固定为 `0 V`。
- 电阻网络必须显式选择数字输入解释模式：`electrical: { interpretation: 'two-state' | 'retain-in-band' }`，没有默认值。
- 每个器件必须提供配对同步工厂（`DeviceDescription.factory`），用 `initializePin` / `initializeResistor` 声明有限电阻能力；只有 `behaviors`、没有工厂的器件描述不再接受。
- 以配对工厂和电气资源绑定的 `kernel` 仍受支持；删除的只是未绑定工厂／资源的旧执行路径。
- `DevicePinDescription` 只保留 `kind` 与 `side`；`direction`、`role` 与 `DevicePinDirection` 导出不再提供。
- 旧布尔拓扑分析器、线或求解器与共享引脚内存已删除；`CompiledCircuit.memory`、`DeviceBehaviorApi.memory` 与 `DeviceKernelContext.memory` 不再提供。
- `Circuit.setPin` 与 `DeviceAccessor.writePin` 已移除；宿主不能直接改引脚电平，应使用器件状态与类型化 IR 操作。
- 改为器件状态 + 类型化 IR 操作（`writeDigital`、`writeVoltage`、`setPull`、`applyResistors`、`applyConnections`）；宿主用 `DeviceAccessor.setState` 提交输入状态，用 `getState`、`getVoltage`、`getCurrent` 与 `getDiagnostics` 观察结果。
- 多驱动网不再按线或或优先级解析。有限输出电阻、上下拉、电阻支路与闭合触点共同参与电流守恒；相反驱动形成负载，同节点异压理想源报告 `electrical/source-conflict`。
- 新增 `resistor(name).sampleCurrent()`（第一端到第二端的支路电流，单位 A）与 `Circuit.getVoltage` / `Circuit.getCurrent` / `Circuit.getDiagnostics` 观察面。浮空模拟输入的 `sampleVoltage()` 返回确定性伪噪声，不是物理驱动；被动负载应使用支路电流计算压降。
- 求解错误诊断新增 `target?`、`resources` 与 `pins`：`target` 标记可识别的失败操作、支路或源；`resources` 表示受影响的关联网络，不表示全部资源都有责任；`pins` 以 `device.pin` 列出相关引脚。数值求解故障无法归因到单一操作、支路或源时不给出 `target`。`electrical/overcurrent` 的载荷保持不变。

迁移前：

```ts
await Circuit.create(input);
circuit.setPin('drive1.PA0', true);
```

迁移后：

```ts
await Circuit.create(input, {
  electrical: {
    sources: { VDD: { voltage: 5 } },
    interpretation: 'two-state',
  },
});
circuit.devices.drive1.setState('level', true);
circuit.step();
```

`input` 中的器件描述还需提供配对工厂与引脚能力声明。以 JSON 声明 `resistors.body` 与 `resistance` 属性的电阻为例：

```js
export default function createResistor({ electrical, properties }) {
  electrical.initializeResistor('body', {
    resistance: properties.resistance,
    enabled: true,
  });
}
```

完整步骤见 `docs/migration/resistive-electrical-model.md`。
