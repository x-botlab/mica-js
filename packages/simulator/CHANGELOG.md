# @mica-js/simulator

## 0.3.0

### Minor Changes

- 9ed7675: - `@mica-js/canvas-editor`：导出 `CanvasEditor` 类与文档装载 API，由 host provider 创建并持有 WidgetHost；同步编辑/仿真模式，并打通 widget 与 device guest 的直连通道。保留 `createCanvasEditor` 工厂；旧 `host` 选项迁移到 `hostProvider`。
  - `@mica-js/core`：增加 RPC、logging、lifecycle 公开子路径，统一 `Event<T>` / `Emitter` 与资源释放接口，并提供 `level` / `message` 话题投递及画布端口声明。
  - `@mica-js/device`：支持话题投递声明、步首输入与步末输出钩子、诊断，以及 FIFO 和字节存储。
  - `@mica-js/ir`：增加数值与浮点位模式转换工具；JIT 新增短循环展开和热门区域间直接调用优化。
  - `@mica-js/sandbox`：通过 `?sandbox-worker` / `?sandbox-worker-code` 在内存中构建自包含 guest，不再需要发布独立 guest 脚本。
  - `@mica-js/schematic-editor`：公开 `SchematicEditor` 和 `DocumentModel` 的内容、撤销及变更事件 API，并修复导线 T 型吸附忽略网格的问题；旧编辑器 API 需要迁移。
  - `@mica-js/simulator`：新增统一 IR 编译器、`Circuit` 运行时、通用器件描述与访问器，以及原理图、电路和 sandbox 版本的 `DeviceSimulationHost`。不再导出内置器件模型，调用方需提供器件描述；旧调度器 API 继续支持但已弃用。sandbox guest 在构建时内联。
  - `@mica-js/widget`：新增画布实例事件与绑定校验、HostFs 文档读取、话题投递与器件 guest 直连，以及音频 API。guest 和 AudioWorklet 在构建时内联；移除旧 runtime 和独立脚本入口。`onDidXxx` 订阅统一返回 `Event<T>` 的 Disposable。

### Patch Changes

- Updated dependencies [9ed7675]
  - @mica-js/core@0.4.0
  - @mica-js/device@0.3.0
  - @mica-js/ir@0.4.0
  - @mica-js/sandbox@0.3.0

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
