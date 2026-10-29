# @mica-js/sandbox

通过不透明源 iframe 与 Web Worker 隔离不可信 JavaScript。`SandboxWorker` 管理隔离环境和生命周期；调用方提供自包含的 worker 脚本，并通过 `MessagePort` 和 `@mica-js/core/rpc` 建立 RPC。

`@mica-js/sandbox/vite` 导出 `micaSandboxPlugins()`，支持将 `?sandbox-worker` 打包为沙箱类，或通过 `?sandbox-worker-code` 获取内联脚本字符串。
