---
'@mica-js/simulator': minor
---

新增 Circuit 领域指令内联降级（Domain Instruction Lowering），把 `connection.apply` 与 `observe.configure` 在编译期展开成核心 IR，运行时不再有执行器调用或宿主导跳：

- `compiler/lowering/`：新增 `DomainInstructionLowering` pass 及 `connection-lower.ts` / `observe-lower.ts`。`run()` 会扫描整个模块，若仍有 `connection.apply` / `observe.configure` 残留则报 `invalid-ir`。
- `DeviceDescription.connections`：声明两脚可切换连接（`pins` + `initial: 'open' | 'closed'`），`DeviceBehaviorApi.connection.apply/set` 把补丁降级为 `connection_states` 写入加 `PIN_INPUT[sink] = select(closed, mergedLevel, baseLevel)`。电平表达式是编译期展开的驱动引脚读取（`pin_mode == push-pull && pin_output` 的 OR），没有 netlist 遍历。常量补丁（如 `apply(false)`）不读状态、不生成 `select`。
- 共用同一网络的多个开关（SPDT 继电器的常开/常闭触点）合并为一个 `solve_connections_<id>` 函数：一次调用、每个 sink 只写一次；`ElectricalSolverGenerator` 把同一组开关折叠进 `solve_net_<id>`，使闭合状态在之后每个 tick 的电学求解后依然成立。
- `DeviceDescription.observers` + `DeviceBehaviorApi.observe.configure`：启用时写入 `observe_baselines`，主循环在设备 update 之后追加边沿检测（`bool.xor` / rising / falling），命中时调用生成的 `<deviceId>_observe_<name>` 处理函数；`enabled: false` 降级为零代码。
- `GlobalResourceAllocator` 按声明顺序分配 `connection_states`（以 `initial` 为初值）与 `observe_baselines`，只在存在声明时创建数组，未使用这些特性的电路内存布局不变。
- 测试：`lowering/connection-lower.test.ts` 与 `lowering/observe-lower.test.ts` 覆盖静态消除、动态切换、双触点批量补丁、跨 tick 保持、上升沿过滤、禁用观察器、JSON 前后 JIT/解释器一致性，以及 ideal-button / ideal-relay 两个示例拓扑。
