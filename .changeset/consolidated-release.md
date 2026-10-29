---
'@mica-js/canvas-editor': minor
'@mica-js/core': minor
'@mica-js/device': minor
'@mica-js/ir': minor
'@mica-js/sandbox': minor
'@mica-js/schematic-editor': minor
'@mica-js/simulator': minor
'@mica-js/widget': minor
---

- `@mica-js/canvas-editor`：导出 `CanvasEditor` 类与文档装载 API，由 host provider 创建并持有 WidgetHost；同步编辑/仿真模式，并打通 widget 与 device guest 的直连通道。保留 `createCanvasEditor` 工厂；旧 `host` 选项迁移到 `hostProvider`。
- `@mica-js/core`：增加 RPC、logging、lifecycle 公开子路径，统一 `Event<T>` / `Emitter` 与资源释放接口，并提供 `level` / `message` 话题投递及画布端口声明。
- `@mica-js/device`：支持话题投递声明、步首输入与步末输出钩子、诊断，以及 FIFO 和字节存储。
- `@mica-js/ir`：增加数值与浮点位模式转换工具；JIT 新增短循环展开和热门区域间直接调用优化。
- `@mica-js/sandbox`：通过 `?sandbox-worker` / `?sandbox-worker-code` 在内存中构建自包含 guest，不再需要发布独立 guest 脚本。
- `@mica-js/schematic-editor`：公开 `SchematicEditor` 和 `DocumentModel` 的内容、撤销及变更事件 API，并修复导线 T 型吸附忽略网格的问题；旧编辑器 API 需要迁移。
- `@mica-js/simulator`：新增统一 IR 编译器、`Circuit` 运行时、通用器件描述与访问器，以及原理图、电路和 sandbox 版本的 `DeviceSimulationHost`。不再导出内置器件模型，调用方需提供器件描述；旧调度器 API 继续支持但已弃用。sandbox guest 在构建时内联。
- `@mica-js/widget`：新增画布实例事件与绑定校验、HostFs 文档读取、话题投递与器件 guest 直连，以及音频 API。guest 和 AudioWorklet 在构建时内联；移除旧 runtime 和独立脚本入口。`onDidXxx` 订阅统一返回 `Event<T>` 的 Disposable。
