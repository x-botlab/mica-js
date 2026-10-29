# @mica-js/core

## 0.4.0

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
  - @mica-js/ir@0.4.0

## 0.3.0

### Minor Changes

- dea8509: feat(core): IR 实例默认使用 JIT 引擎

  - 新增 `IRSchedulerInstanceDefinition.engine` 选项（'jit' | 'reference'，默认 'jit'）
  - 切换到 `stepBudget` 协议实现批量步数检查
  - 两种引擎的可观测行为完全等价
  - 性能提升约 256×（相对参考解释器）

### Patch Changes

- Updated dependencies [214a324]
- Updated dependencies [1cc2a2b]
- Updated dependencies [214a324]
- Updated dependencies [1cc2a2b]
- Updated dependencies [214a324]
- Updated dependencies [214a324]
- Updated dependencies [2ed90cd]
- Updated dependencies [1cc2a2b]
- Updated dependencies [1cc2a2b]
- Updated dependencies [214a324]
- Updated dependencies [1cc2a2b]
- Updated dependencies [214a324]
- Updated dependencies [214a324]
  - @mica-js/ir@0.3.0

## 0.2.0

### Minor Changes

- 9ea9858: 新增 `@mica-js/widget`：Widget 定义、`WidgetProvider` 接口、静态 provider 与包加载（含路径校验、内容哈希、缓存）。`@mica-js/core/canvas` 增补 `PAYLOAD_TYPES`、`parsePayloadType`、`isAssignable` 与 `PayloadType` 导出，供 widget 端口类型校验复用。
- f6c9dac: 实现连接作者接口与 IR 接入（#57）：器件描述解析 #14 连接声明；`api.ir.connection(id)` 与 `b.connection.apply([{ connection, closed }])` 把建图时固定的对象列表降低为 `static-list` 连接引用与等长 bool SSA 列表；通过 `DeviceInstanceOptions.connections.topology` 绑定 core topology，在合法控制阶段以一份原子 patch 提交，支持普通/生命周期/嵌套块、SSA 按值捕获、稳定同刻顺序、未知/跨实例/非法 patch 诊断，以及冲突后不回滚已提交拓扑。IR 增加通用领域指令列表操作数与可信同步 `IRInstructionExecutor`，core `createIRSchedulerInstance` 可传入执行器。
- d699e7f: 实现话题与 IR 消息桥接（#54）：`api.subscribe/publish/post/postBytes/onOutput/updateBytes` 接入真实 `validateIR` → 参考解释器 → scheduler → device 生命周期链；新增 IR `output` / `outputBytes`、`bridge.send` / `bridge.send_bytes` 与宿主 `IRBridgeHost`，device 侧提供有界输出/输入/发布/更新队列、inbox 预留与释放、初始化暂存与激活顺序、`onTopic` 宿主回调及 `deliver`，并以 `BackpressureError` 和新增 `DeviceErrorCode` 报告背压与非法载荷/句柄/范围。Scheduler 增加不推进时间、不分配事件 ID 的普通消息入口与 `messageId`；`IRStorage` 增加宿主 inbox 写入与原子版本化字节更新。`TopicPayloadType` 随 `DevicePortDescriptor` 一起从包入口导出，宿主可以给端口类型命名。
- c5b688e: 实现数字边沿观察与捕获投递（#56）：`api.ir.observeDigital` 声明静态观察绑定，`b.observe.configure` 降低为 `observe.configure`（静态绑定、bool 启用位、u8 边沿编码 1/2/3）；链接期校验 trigger/capture 均为本实例 signal 引脚且目标 entry 签名恰为 `['u8', ...u32 × captures.length]`。device 按 #25 维护启用、边沿选择与基线，使用 #51 的解析阶段采样和门控结果，在首次启用、显式重配、门控恢复及浮空/待定区间后重建基线且不误报边沿；触发时按同一阶段快照固定 `[u8, ...u32]` 载荷，经 #54 的 `scheduler.enqueueMessage` 普通队列按声明顺序投递，不推进时间、不同步重入。core 新增 `PowerDigitalPinChange` / `PowerDigitalPinObserver` 与 `PowerRuntime.addDigitalPinObserver`，在多观察者注册顺序下 fail-fast 通知变化引脚。新增 `device/observe-pin`、`device/observe-binding`、`device/observe-config`、`device/observe-unavailable`；明确拒绝 `edges=0` 状态观察、模拟量、电压、get/set、组观察与任意比较器。

### Patch Changes

- 645e731: 实现 Provider 生成、依赖跟踪与缓存（#60）：`ir.provider` 声明固定 key/参数/结果布局、生成期受追踪读取与产物可引用引用；`gen.readBytes`/`readState`/`readArray` 登记实际覆盖的版本单元（state/array 使用整资源单元），产物经既有 `validateIR`、imports 白名单与解释器执行。`dispatch` 作为终结指令按规范化 key 复用或按需重生成产物，每次派发校验全部依赖，缓存按实例隔离。新增 `IRProviderError` 与可区分的声明/读取/生成/产物/依赖错误码；生成产物写入自身读依赖时明确拒绝（运行中恢复属于 #61）。device 的 `api.ir.provider` 与 core 的调度接入同步可用。
- Updated dependencies [f6c9dac]
- Updated dependencies [d699e7f]
- Updated dependencies [dbf7d60]
- Updated dependencies [a5d8ce5]
- Updated dependencies [645e731]
  - @mica-js/ir@0.2.0

## 0.1.1

### Patch Changes

- 69dc4b0: 实现器件工厂上下文与实例生命周期（#53）：`createDeviceInstance` 同步调用一次工厂，提供固定 `api.props` 与声明封闭的 `api.ir`，在真实 IR 校验/链接通过后安装实例并把 initialize 作为公共控制工作驱动；支持 reset、故障暂停、幂等 destroy 与清理后的 `onDispose`，并以受控 storage 句柄阻止销毁后访问。核心调度器允许在 `faulted` 状态下销毁仍存在的实例以完成队列与引用清理，但不恢复执行能力。

## 0.1.0

### Minor Changes

- 503b44b: 新增原理图 `.sch` 与画布 `.cnv` 两个文档格式子路径：解析、序列化与校验，拓扑推导，编辑命令与撤销重做，命中测试，器件注册表，以及 `string` / `number` / `integer` / `boolean` / `enum` / `color` / `image` / `binary` 属性系统与资源引用。
