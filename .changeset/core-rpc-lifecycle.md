---
'@mica-js/core': minor
---

新增 `@mica-js/core/rpc` 与 `@mica-js/core/lifecycle` 子入口。RPC 在 MessagePort 上提供双向调用与动态代理：服务端运行时检查成员、`onDidXxx` 自动映射为订阅、参数/返回值/事件可显式 transfer，并处理超时、协议异常、服务注销与断连清理；接口无需方法描述表。`lifecycle` 提供 `IDisposable`、`DisposableStore` 与 `toDisposable`，供 RPC 及其他包统一释放资源。
