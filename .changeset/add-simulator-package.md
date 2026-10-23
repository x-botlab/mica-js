---
'@mica-js/simulator': minor
---

接入电气层：`DeviceSimHostContext` 新增 `modules`（接线端不必重复加载器件），`getTopics()` 的每一项新增 `designator`（符号未写位号时回退到 id），并新增现成宿主实现 `createCircuitHost({ supplyVoltage })`：用 `deriveSchematicTopology` 把原理图折成网表并交给 `createPowerRuntime`，`builtin:power` / `builtin:ground` 作为合成实例提供供电与 0 V 地参考，器件因此读到真实引脚电平与触点状态；`builtin:label` / `builtin:power` / `builtin:ground` / `builtin:text` 只参与建网，不再当器件实例化。
