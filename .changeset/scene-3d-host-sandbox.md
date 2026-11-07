---
'@mica-js/scene-3d': minor
---

新增 Scene3DHost 架构与多电路仿真器锁步（#214）：

- `Scene3DHost`（sandbox guest）接管物理、传感器与电路协调；`Scene3DClient`（主线程）只负责渲染与交互，通过 `step` / `addEntity` / `removeEntity` / `getTransforms` RPC 通信。
- 环境入口编译期组合：`runtime/host.browser.ts`（OffscreenCanvas + WebGL2）、`runtime/host.node.ts`（headless）、`runtime/host.mock.ts`（测试），由 `@mica-js/scene-3d/runtime/host` 条件导出选择。
- 离屏渲染抽象 `OffscreenRenderer` / `OffscreenSurface`，提供 browser、headless、mock 三种实现。
- `$sandbox.createChildSandbox()` 创建每个装配体实例的电路仿真器；锁步屏障收集全部 `jointCommand` 后再执行物理步进，并返回单个列主序变换批次。
- 主线程客户端从 `@mica-js/scene-3d/client` 导出，Three.js 适配器位于 `@mica-js/scene-3d/client/three`；`three` 为可选 peer 依赖。
- `PhysicsRuntime.removeBody` 增加为可选能力，`MujocoRuntime` 已实现（同时移除引用该刚体的关节）。
