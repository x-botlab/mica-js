---
'@mica-js/device': minor
'@mica-js/simulator': minor
---

新增 RFC 0007 电源域（布尔 VDD 版本）：器件可声明电源域，宿主可在运行时上电/断电，断电会门控驱动、采样与器件逻辑。

- `@mica-js/device`：`DeviceDescription.powerDomains` 解析 `[{ name, voltage }]`，按声明顺序保留；名称重复、非正电压或未知字段报 `DeviceError`。`voltage` 是标称电压元数据，布尔电路模型不使用它。另导出 `PowerDomainDescription`。
- `@mica-js/simulator`：`DeviceDescription.powerDomains` 与 `DevicePinDescription.powerDomain` 进入统一 IR 编译。`GlobalResourceAllocator` 按器件声明顺序把每个域打包进共享 `power_ready` 数组（初值全 `true`），并解析 `globalPinId -> 域槽位`；引脚未显式绑定域时继承器件主域（第一个声明的域）。
- 门控：`solve_net_<id>` 中被断电域的驱动引脚不再计入 `active` / wired-OR（引脚释放为高阻）；`pin.sampleDigital`、`Circuit.getPin`/`samplePin` 在域断电时返回确定值 `0`；`unified_tick` 跳过断电域器件的 `tick`/`update`，其观察器边沿检测同样跳过（基线仍跟随触发引脚，恢复供电后不补发边沿）。配置与输出锁存保留，重新上电即恢复原驱动意图。
- `Circuit` 新增 `turnOn(symbol, domain)`、`turnOff(symbol, domain)`、`isPowered(symbol, domain)`；`reset()` 把所有域恢复为上电。未声明域的器件恒为供电；`turnOn`/`turnOff` 对其抛 `CircuitError('no-power-domains')`，未知域抛 `CircuitError('power-domain-not-found')`。
- 无电源域声明的电路不分配 `power_ready`，生成的 IR 与之前逐条一致（不引入额外门控指令）。
- 测试：`compiler/power.test.ts` 覆盖槽位打包、引脚绑定、缺失内存与非法声明；`runtime/power.test.ts` 覆盖默认上电、驱动释放/恢复、采样门控、器件逻辑跳过、显式域绑定与 `reset()` 恢复。
