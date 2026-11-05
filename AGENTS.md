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

## 性能优化与验证

- 遵循 fail fast：先用最小、可复现的基准验证本次任务的核心指标；未达预期时优先定位瓶颈、调整实现，再复测。
- 不在每轮迭代运行完整性能矩阵或无关基准；仅在核心指标达到预期、需要确认关联回归或收尾时扩大验证范围，并保留相关正确性回归。

## Agent skills

- 项目级 skill 存放在 `.agents/skills/`，版本由 `skills-lock.json` 锁定；增删用 `npx skills@latest add mattpocock/skills -s <name>`。
- `.claude/skills/` 是本机指向 `.agents/skills/` 的链接目录，已忽略，不要提交。
- `spec-writer` 直接随仓库追踪，`skills-lock.json` 里没有它的条目；修改它走普通 git 流程，`npx skills update` 不会覆盖。
- `grill-me` 需手动触发，实际流程在 `grilling`：在写方案或 RFC 前按设计树逐轮追问，把隐含假设逼出来；它只访谈，不动代码。
