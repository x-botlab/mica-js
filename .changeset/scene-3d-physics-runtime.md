---
'@mica-js/scene-3d': minor
---

新增物理运行时适配层（#180）：

- `physics/` 模块：`PhysicsRuntime` 契约（`initialize` / `step` / `addBody` / `addJoint` / `setJointTarget` / `getBodyTransform` / `getJointState` / `raycast` / `dispose`），面向世界坐标系（右手系、Y 轴向上）。
- `RigidBodyConfig`、`JointConfig`、`JointTarget`、`JointState`、`RaycastHit` 等类型；`JOINT_TYPES` 与 `JOINT_TARGET_KINDS` 运行时常量。
- `MujocoRuntime`：确定性内存替身，模拟重力自由落体、逐轴运动约束、关节位置 / 速度 / 力矩目标与包围球射线检测；真实 MuJoCo WASM 适配后续接入。
- `DEFAULT_GRAVITY` 使用 Y 轴 `-9.81 m/s²`，与 `.scene3d` 世界坐标一致。
