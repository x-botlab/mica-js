---
'@mica-js/scene-3d': minor
---

将 Scene3DHost 迁移到上游 @mica-js/sandbox 的 SandboxWorker + MessagePort 传输层：

- 场景 guest 通过 sceneHostGuest / sceneHostHost RPC 服务通信，物理、传感器与电路协调仍在 host 内完成。
- 每个电路 guest 使用独立 MessageChannel 与场景 guest 直连；主线程只负责创建和终止 worker。
- Scene3DClient 提供 SandboxWorker 工厂与 RPC proxy，同时保留可注入 host seam 供测试使用。
- 无头与 CI 可直接在进程内调用 `createScene3DHost({ document, physics, renderer })`。
- `three` 继续作为可选 peer 依赖，Three.js 适配器位于 `@mica-js/scene-3d/client/three`。
