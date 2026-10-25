---
'@mica-js/simulator': minor
---

新增运行期探针 API、板级接线编译与示例器件 IR 绑定，让 Playground 的观测表读到真实电平与触点状态：

- `Circuit.samplePin(symbol, pin)`：按器件 id + 引脚名采样数字电平，返回 `{ value: 0 | 1; ready }`；语义与 `getPin` 一致（有感知的引脚读解算值，纯驱动引脚读实际驱动值）。未知器件抛 `device-not-found`，未知引脚抛 `pin-not-found`。
- `Circuit.sampleConnection(symbol, connection)`：读 `connection_states` 里该触点的槽位，返回 `{ state: 'open' | 'closed'; ready }`，所以域降级写入的 `connection.apply` 补丁立刻可见。未知器件抛 `device-not-found`，未知触点抛 `connection-not-found`。`CircuitErrorCode` 因此新增 `device-not-found` 与 `connection-not-found`。
- `compileBoardTopology(topology, devices)`：把宿主板级接线（`TopologyDefinition`）折成 `{ connections, rails, aliases }`。电源引脚变成以其命名的电平轨、地引脚变成 `GND`，同一条导线上的器件引脚连成一个网；`aliases` 把 `board.SENSE` 这类宿主引脚映射到同一网里的器件引脚，供探针采样。
- `createCircuitExecutor` 新增可选 `topology`（合并板级接线）与 `samplePin` / `sampleConnection`（按符号 id 或位号转发给 `Circuit`，并按 `aliases` 解析宿主引脚）；`DeviceSimExecutor` 把这两个方法声明为可选能力，只有自带电气模型的执行器实现。
- `resolveExampleDevice` / `createIdealButtonDescription` / `createIdealRelayDescription`：把 `packages/device/examples` 里的 `ideal-button`、`ideal-relay` 绑定成统一 IR 描述（被动触点 + 边沿触发 SPDT），使示例拓扑在 `resolveDevice` 下拥有真实电气行为。
- 测试：`runtime/circuit.test.ts`（6 例，电平 / 触点 / 三种缺失错误）与 `circuit-executor-adapter.test.ts` 的探针用例（符号 id 与位号解析、宿主引脚别名、未加载与未知符号）。
