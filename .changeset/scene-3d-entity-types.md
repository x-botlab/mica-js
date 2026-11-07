---
'@mica-js/scene-3d': minor
---

新增 3D 场景实体系统类型（#179）：

- `entities/` 模块：`SceneEntity` 基类接口与具体实体，实体通过 `type` 判别，`SceneEntity` 统一携带 `id`、初始 `position` / `rotation` 与可选的 `name`；实体本身不再绑定原理图符号。
- `ModelEntity`：`type: 'model'`，组合 `geometry`、`material`、`collider` 与 `physics`。
- `AssemblyInstance`：`type: 'assembly'`，通过 `assembly`（`package:name`）引用 `.assembly.json` 装配体定义，可选 `overrides` 覆盖实例属性。
- `JointEntity`：`type: 'joint'`，`inputBinding` 接收力矩/推力指令、`outputBinding` 发布位置反馈，绑定以 `{ symbol, port }` 指向原理图符号端口。
- `SensorEntity`：`type: 'sensor'`，`binding` 以 `{ symbol, port }` 发布传感器数据。
- `PhysicsConfig`：`bodyType` 支持 `static` / `dynamic` / `kinematic`，可配置 `mass`、`velocity`、`angularVelocity` 与 `freezePosition` / `freezeRotation` 逐轴约束；`BODY_TYPES` 提供运行时枚举。
- `GeometryDescriptor`：`box`、`sphere`、`cylinder`、`capsule`、`plane` 五种基础几何的判别联合，`plane` 使用新增的 `Vec2d`；`GEOMETRY_TYPES` 提供运行时枚举。
- `ColliderDescriptor`：基础形状、从几何体生成的 `trimesh` / `convex-hull`、以及递归 `compound`。
- `MaterialDescriptor`：必填 `friction` / `restitution`，可选颜色、贴图、金属度、粗糙度与透明度。
- 测试：`entities/types.test.ts` 覆盖三种刚体模式、五种几何、碰撞体与材质组合；`entities/types.type-test.ts` 以 `@ts-expect-error` 校验非法判别值、缺失字段与只读约束。
