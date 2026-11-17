# @mica-js/sandbox

通用 JavaScript 沙箱，负责不可信脚本的隔离执行、沙箱生命周期管理和跨边界通信。适用于需要隔离运行扩展、widget 或仿真脚本的宿主。

调用方提供自包含的 worker 脚本；通信复用 `MessagePort` 和 `@mica-js/core/rpc`。本包不定义器件或 widget 的业务协议。

## 主要入口

- `@mica-js/sandbox`：`SandboxWorker` 及沙箱运行时类型。
- `@mica-js/sandbox/vite`：`micaSandboxPlugins()`，支持沙箱 worker 的构建与加载。

开发服务器会监听 worker 入口及其传递依赖；文件变化时重新打包，并使
`?sandbox-worker` 和 `?sandbox-worker-code` 两种导入失效，触发页面热更新。
