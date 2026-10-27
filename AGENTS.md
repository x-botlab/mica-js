# 项目开发指南

## RPC 与 sandbox

- 创建 RPC 使用 `createRpc`。
- `register` 和 `getProxy` 使用 `RpcServiceId<T>` 与 `defineRpcService` 定义的常量。
- wire 层的服务标识保持为可序列化的 `string` key。
- sandbox 复用现有 RPC，不实现第二套 RPC。
- sandbox 只传递 `MessagePort`；RPC 统一通过 `createRpc(port)` 创建，事件使用现有的 `onDidXxx` 订阅机制。
- 二进制数据使用 transfer hooks 传递。
- HostFs 通过 typed RPC service 暴露。
