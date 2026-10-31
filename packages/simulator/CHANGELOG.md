# @mica-js/simulator

## 1.0.0

### Major Changes

- 0aca467: 电气仿真改为线性电阻网络，并移除旧布尔 / 线或路径、固定电轨与宿主直写引脚。

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

## 0.4.0

### Minor Changes

- c206942: 多驱动网（一个网络上接多个驱动引脚）默认按线或求解，不再需要开关：移除 `CircuitCompilationOptions.allowMultiDriver`、`CircuitElectricalOptions.allowMultiDriver` 与 `TopologyOptions.allowMultiDriver`，并移除 `driver-conflict` 诊断与错误码。双向 GPIO 与按钮接在同一个网这类必须的行为仿真因此可以直接编译，也不会再产生警告；单驱动网的求解路径与结果不变。
- c206942: 统一 IR 的全局引脚空间上限从 256 提升到 `UNIFIED_PIN_CAPACITY = 4096`，单设备引脚上限 `DEVICE_PIN_STRIDE` 从 32 提升到 512，板级原理图不再因为「一个 40 脚 MCU 就超限」而编译失败。

  共享的 `pin_mode` / `pin_output` / `pin_input` 内存改为按电路实际声明的引脚数分配，容量常量只作为分配期上限；因此提高上限不增加每个电路的内存与创建、`reset()` 开销。`createPinMemory(module, capacity?)` 新增可选参数以支持按需分配，缺省仍为全容量。`compiled.pins.capacity` 仍报告上限值。

### Patch Changes

- Updated dependencies [368414f]
  - @mica-js/core@0.5.0

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
