---
'@mica-js/scene-3d': minor
---

新增 `@mica-js/scene-3d`：3D 场景模式的基础设施与运行时。

- **数学与文档**：`Vec2d` / `Vec3d` / `Quaternion` / `Transform` 纯函数工具；`.scene3d` 文档格式
  （世界、环境、材质预设库）与 `.assembly.json` 装配体定义格式，均为版本化的物理引擎无关 JSON。
- **实体系统**：`model` / `assembly` / `joint` / `sensor` 判别联合与基础几何、碰撞体、材质、刚体
  描述符；绑定统一为 `{ symbol, port }` 端口绑定，对齐 2D Widget。
- **亚克力板建模**：2D 轮廓（矩形 / 圆形 / 多边形 / SVG 子集 / 带孔复合）解析、earcut 挤出网格
  （按面组分离法线）、质量与薄板惯性计算、`trimesh` / `convex-hull` 碰撞体与局部 AABB，以及数据
  化的板面印刷图案（`paint`）——颜色传感器按命中点取色，Three.js 适配器据此生成纹理。
- **物理适配层**：`PhysicsRuntime` 契约与确定性的 `MujocoRuntime` 内存替身（重力、逐轴运动约束、
  关节伺服、按碰撞体形状的射线检测）；真实 MuJoCo WASM 适配后续接入。
- **传感器**：注册表、按 picoseconds 虚拟时钟节流的基类、`mountedOn` 世界位姿组合，以及距离、
  颜色、IMU 与 GPS 四种确定性实现；其余 6 种保留类型契约。
- **隔离运行时**：`Scene3DHost` 通过 `@mica-js/sandbox` 的 `SandboxWorker` 在 guest 中承载物理、
  传感器与电路协调，`Scene3DClient` 留在主线程负责渲染与交互；电路 guest 与场景 guest 用父子
  `MessageChannel` 直连。无头环境可跳过沙箱在进程内运行 host。
- **Playground 演示**：`apps/playground/scene3d.html` 的亚克力循迹赛道 + 双轮机器人 + 双颜色
  传感器，主线程比例转向。
