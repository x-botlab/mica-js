---
'@mica-js/scene-3d': minor
---

新增主线程直控接口与 Playground 3D 循迹演示：

- `Scene3DHost.setJointTarget()` / `getSensors()` / `setBodyVelocity()`，`Scene3DClient` 对应
  `setJointTarget()` / `readSensors()` / `setBodyVelocity()`
- 刚体可直接设定速度（`PhysicsRuntime.setBodyVelocity`，`MujocoRuntime` 已实现），供遥操作与测试使用
- `JointEntity.jointType` / `bodyA` 改为必填，宿主据此创建物理关节
- 内存物理引擎的 raycast 改为按碰撞体形状求交（`box` 精确、`sphere` 用半径、
  `trimesh`/`convex-hull` 用 `bounds` AABB），并忽略射线起点位于形状内部的刚体
- 传感器忽略自身挂载刚体的命中，避免把载体当成被测目标
- 亚克力板 `paint` 由数据描述（底色 + 沿轴条带）：颜色传感器按命中点取色，渲染端生成纹理
- `apps/playground/scene3d.html`：亚克力循迹底板 + 双轮机器人 + 双颜色传感器，
  主线程比例转向控制，HUD 显示灰度与距离读数
