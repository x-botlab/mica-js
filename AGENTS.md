# 项目开发指南

## RPC 与 sandbox

- 创建 RPC 使用 `createRpc`。
- `register` 和 `getProxy` 使用 `RpcServiceId<T>` 与 `defineRpcService` 定义的常量。
- wire 层的服务标识保持为可序列化的 `string` key。
- sandbox 复用现有 RPC，不实现第二套 RPC。
- sandbox 只传递 `MessagePort`；RPC 统一通过 `createRpc(port)` 创建，事件使用现有的 `onDidXxx` 订阅机制。
- 二进制数据使用 transfer hooks 传递。
- HostFs 通过 typed RPC service 暴露。

## 工作区约定

- 优先复用 `@mica-js/core/lifecycle` 的 `Event<T>`、`Emitter` 与 Disposable；`onDidXxx` 订阅返回 Disposable。
- 包的开发入口在 `exports` 中用 `source` 指向源码；发布入口在 `publishConfig.exports` 中仅指向 `dist`，两份公开子路径保持一致。
- 只针对相关功能运行包级 `typecheck`、`test`、`build`；发布流程不靠功能测试验证。RFC 文档另遵守 `.github/instructions/rfc.instructions.md`。
