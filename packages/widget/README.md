# @mica-js/widget

Widget 契约、包加载和运行时，提供实例执行、绘制、音频与端口通信。可作为独立运行时使用，也可由画布编辑器集成。

宿主负责提供文件访问、widget 包和沙箱工厂；执行隔离由 `@mica-js/sandbox` 提供。本包不负责器件电气仿真。

## 主要入口

- `@mica-js/widget`：`createWidgetRuntime`、widget provider 以及内置沙箱和音频 worklet 工厂。
- `@mica-js/widget/author`：仅 Widget 作者类型（工厂、上下文、输入、资源与音频），不加载宿主或沙箱入口；`@mica-js/sdk/widget` 复用此入口。
- `@mica-js/widget/vite`：`micaWidgetPlugins()`，用于 widget 构建集成。

## IWidgetRuntime（编辑器运行时）

`createWidgetRuntime(sandbox, options?)` 创建实例执行层。`sandbox` 由 `createWidgetSandboxFromWorker` 创建；运行时接管其生命周期，`dispose()` 会终止该沙箱。运行时只负责实例执行：不读取文档或文件、不解析 widget 库、不持有仿真时钟，也不接触器件运行时。

- `mount(instance)` 接收编辑器已解析好的 `WidgetModule`、尺寸、属性和预取资源；部分失败会清理访客会话、位图与音频会话，可以重试。首帧可能在 `mount` 兑现前就已提交，因此应在挂载前订阅 `onDidRender`。工厂或首帧失败会在报告后拒绝 `mount`。
- `update(id, update)` 可更新属性、宽高、dpr 和资源；`unmount(id)` 释放实例及位图。
- `deliver(message)` / `dispatch(id, event)` 先按模块定义校验实例、端口方向与载荷类型，再排队到下一次 `step`；未知实例或端口直接拒绝。
- `step({ simTime, dt, mode })` 是唯一的时间推进入口。显式步进开启后，访客不再自动重绘，`invalidate()` 标记的实例在该步统一绘制；直连设备发布也排队到该步开始消费。`step` 会等待直连 widget → simulation 投递全部结算后才兑现，避免主通道的下一次 tick 越过直连投递。
- `onDidRender` 的 bitmap 归运行时所有，保持到同实例下一帧、卸载或运行时释放为止；迟到帧会被关闭。
- `onDidPublish` 是观察通道；`message.direct === true` 表示访客已通过直连端口把消息交给仿真，观察者不得再次路由。
- `setBindings(id, bindings)` 只接收编辑器已经校验过的路由表，不做文档绑定校验。
- 直连端口只使用 `simulation-runtime` 服务，消息为 `{ target: { symbol, port }, payload, simTime }`，时间单位为皮秒。`configure` 在首次挂载前开启显式步进；独立访客未开启显式步进时仍支持自动重绘。
- `audio` 复用 `WidgetAudioEngine`；未提供 `WidgetAudioOptions` 时为保持可用状态的 no-op 控件。
- 并发 mount、update、unmount、setBindings 与 step 串行执行；`dispose()` 取消尚未完成的挂载采纳并释放位图、音频和沙箱。

公开类型包括 `IWidgetRuntime`、`IWidgetRuntimeRouting`、`IPreparedWidgetInstance`、`IWidgetInstanceUpdate`、`IWidgetMessage`、`IWidgetFrame`、`IWidgetFrameContext`、`IWidgetRuntimeDiagnostic`、`WidgetRuntimeError`，以及直连协议 `widgetSimulationRuntimeService`。
