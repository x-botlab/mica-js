# @mica-js/simulator

## 0.2.2

### Patch Changes

- @mica-js/core@0.3.1
  - @mica-js/device@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [dea8509]
  - @mica-js/core@0.3.0
  - @mica-js/device@0.2.1

## 0.2.0

### Minor Changes

- 2bf587b: 接入电气层：`DeviceSimHostContext` 新增 `modules`（接线端不必重复加载器件），`getTopics()` 的每一项新增 `designator`（符号未写位号时回退到 id），并新增现成宿主实现 `createCircuitHost({ supplyVoltage })`：用 `deriveSchematicTopology` 把原理图折成网表并交给 `createPowerRuntime`，`builtin:power` / `builtin:ground` 作为合成实例提供供电与 0 V 地参考，器件因此读到真实引脚电平与触点状态；`builtin:label` / `builtin:power` / `builtin:ground` / `builtin:text` 只参与建网，不再当器件实例化。

## 0.1.0

### Minor Changes

- 2bf587b: 新增 `@mica-js/simulator`：把原理图里的器件实例跑在一条虚拟时钟上。`createDeviceSimExecutor({ devices })` 返回 `DeviceSimExecutor`：`loadSchematic(document)` 按符号建实例并跑 `initialize`（先建后换，失败保留旧运行时），`advance(delta)` **同步**推进时间片并返回 `{ from, to, executed, reason }`，`getTopics()` 给出每个实例的端口，`onPublish` / `deliver(target, payload)` 与画布互投载荷，`deliver` 收 `unknown`（端口类型由器件层校验）并延迟到下一次 `advance` 开头以保持同一时刻的调用顺序，`reset()` 用缓存的模块重建实例、`dispose()` 幂等释放——两者都是同步的，除 `loadSchematic` 外整个接口不返回 promise。取值统一为方法（`getState()` / `getSimTime()` / `getSchematic()` / `getTopics()`），`loadSchematic` 只接收已解析的 `SchematicDocument`。`DeviceSimExecutor` 结构上满足 `@mica-js/widget` 的 `WidgetHostSimulation`，可以直接作为 `WidgetHostOptions.simulation` 挂到 `WidgetHost` 上，仿真与宿主跑在同一个 JS 线程。引脚、网络与电气求解尚未接入，属于下一里程碑。

### Patch Changes

- 2290810: 为 `DeviceSimExecutor` 增加宿主接线口 `DeviceSimExecutorOptions.host`：工厂在每次 `loadSchematic` / `reset()` 建运行时各调用一次，拿到该运行时自己的 `scheduler` 与 `schematic`，返回逐实例的 `pinHost`、`topology`、`instanceOptions`（例如 `updateResources: ['firmware']`）以及实例销毁后的 `dispose`。执行器仍不拥有电路定义，只负责透传与生命周期排序（先销毁实例，再释放宿主接线）；工厂抛错时按“先建后换”保留旧运行时，`dispose` 抛错转成 `simulator/dispose-failed` 诊断。这样 `b.pin.*` / `b.observeDigital` / `b.connection.apply` 的器件（例如 `packages/device/examples` 的按钮、继电器与教学 MCU）才能真正通过执行器运行；未配置 `host` 时的行为不变。
- Updated dependencies [9ea9858]
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [c5b688e]
- Updated dependencies [dbf7d60]
- Updated dependencies [766a4d1]
- Updated dependencies [a5d8ce5]
- Updated dependencies [645e731]
  - @mica-js/core@0.2.0
  - @mica-js/device@0.2.0
