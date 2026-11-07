# 3D 场景模式方案总结

## 设计目标

在现有 Mica 仿真器架构基础上增加 **3D 场景模式**，在 2D Widget 之外提供物理维度的机器人仿真，
特别是面向教育场景的激光切割亚克力板建模与循迹赛道仿真。

3D 场景模式与 2D Widget 模式**平行**存在：两者共享同一套 `.sch` 原理图与话题系统，区别只在
"器件如何被驱动、传感器数据从哪里来"。

- 通用实现细节、API 与用法见 [`packages/scene-3d/README.md`](../packages/scene-3d/README.md)。
- 本文件记录**设计决策与实现状态**；任务拆分见 [`3d-scene-issues.md`](./3d-scene-issues.md)。

---

## 实现状态

| 能力             | 状态                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 包结构           | ✅ `@mica-js/scene-3d`（core）+ `/client` + `/client/three`           |
| `.scene3d` 文档  | ✅ 版本 1，物理引擎无关的 JSON                                        |
| 实体与材质预设   | ✅ 实体判别联合 + 13 种内置材质预设                                   |
| 物理适配层       | ✅ `PhysicsRuntime` 契约 + 确定性内存 `MujocoRuntime` 替身            |
| 真实 MuJoCo WASM | ⏳ 未接入（#180），接触/摩擦/转动惯量暂由替身近似                     |
| 亚克力板建模     | ✅ 轮廓解析、挤出网格、质量与惯性、碰撞体、板面印刷图案               |
| 装配体定义       | ✅ `.assembly.json` 版本 1 校验                                       |
| 关节类型与物理   | ✅ `revolute` / `prismatic` / `spherical` / `fixed` 与三种控制目标    |
| 关节 ↔ 话题集成  | ⏳ 未接入（#188–#190），当前由宿主 RPC 直接下指令                     |
| 传感器框架       | ✅ 注册表、采样节流、挂载位姿、读数推送                               |
| 传感器实现       | ✅ 距离 / 颜色 / IMU / GPS；⏳ 摄像头与其余 5 种（#196）              |
| 沙箱宿主         | ✅ `Scene3DHost` guest + `Scene3DClient` 主线程 + 父子 MessageChannel |
| Playground 演示  | ✅ `apps/playground/scene3d.html`（#209）                             |
| 3D 编辑器        | ⏳ 未实现，见下文"编辑器"与 #197–#203                                 |

---

## 架构原则

- **分层复用**：复用 `@mica-js/core`（虚拟时间、生命周期、RPC）、`@mica-js/sandbox`（传输层）
  与现有电气仿真器，新增 `@mica-js/scene-3d` 一个包。
- **不新建编辑器包**：3D 编辑器是 `@mica-js/editor` 的第三个组合根（`packages/editor/src/scene/`），
  依赖方向始终是 editor → scene-3d，`scene-3d` 不反向依赖编辑器。
- **统一时钟**：物理仿真与电气仿真共享 `TimePs` 虚拟时间，边界处换算毫秒。
- **确定性**：相同输入产生相同输出，支持步进、暂停与回放。
- **物理引擎无关**：文档格式不暴露引擎细节，`PhysicsRuntime` 是唯一适配点。
- **主线程只负责渲染与交互**：物理、传感器与电路协调都在隔离 guest 中。

---

## 运行时结构

```
Main Thread ── Scene3DClient + 渲染/交互
     │  RPC（MessagePort，createRpc）
Scene host guest ── Scene3DHost
     ├── PhysicsRuntime（内存替身 / 未来 MuJoCo WASM）
     ├── Sensor System
     └── Circuit guests（父子 MessageChannel 直连，锁步推进）
```

- `Scene3DHost` 是仿真的"上半段"：锁步推进电路、应用关节指令、物理步进、采样传感器。
- `Scene3DClient` 是"下半段"：创建 `SandboxWorker`、等待 guest ready、把批量刚体变换交给渲染 port。
- 电路 guest 与场景 guest 之间直连 `MessageChannel`；主线程只创建与终止 worker。
- 无头环境可跳过沙箱，在进程内直接 `createScene3DHost()`，渲染使用 headless/mock renderer。

主线程保留三个直控接口，用于遥操作、调试与演示：`setJointTarget`、`setBodyVelocity`、`readSensors`。

---

## 文档格式

`.scene3d`（JSON，版本 1）：

- `world`：重力、物理步长、地面。
- `environment`：环境光、方向光、天空盒。
- `materials`：材质预设库，**叠加**在内置预设之上（同名覆盖）。
- `entities`：模型 / 装配体实例 / 关节 / 传感器，以 `type` 判别。

`.assembly.json`（版本 1）：把可复用的机器人模板绑定到一个 `.sch` 原理图。场景中每个实例
各自加载一份原理图并拥有独立电路仿真器，因此同一模板可以多次实例化。

---

## 实体系统

所有物理对象都是实体，通过 `type` 判别：`model`、`assembly`、`joint`、`sensor`。

- **几何**：`box`、`sphere`、`cylinder`、`capsule`、`plane`，以及亚克力板生成的挤出几何。
- **碰撞体**：基础形状、`trimesh`、`convex-hull`（标记 `source: 'geometry'`）与递归 `compound`。
- **刚体模式**：`static`（墙壁、迷宫、地面）、`dynamic`、`kinematic`（运动学控制）。
- **绑定**：关节用 `inputBinding` / `outputBinding`、传感器用 `bindings`，统一为 `{ symbol, port }`，
  且以端口名为 key —— 与 2D Widget 的 `CanvasWidgetInstance.bindings` 同构。

---

## 亚克力板建模（核心特性）

模拟真实激光切割工艺：用户绘制 2D 轮廓与厚度，系统生成网格与物理属性。

- **轮廓**：`rect`（可选圆角）、`circle`、`polygon`、`svg`（子集）、`compound`（外轮廓 + 孔）。
- **网格**：earcut 三角化后挤出，顶点按面组（顶盖 / 底盖 / 侧壁）分离，侧壁法线朝外、
  孔壁法线朝孔内，UV 按轮廓包围盒归一化。
- **物理**：面积 × 厚度 × 密度（g/cm³ → kg/m³）得质量，薄板长方体近似主惯性矩；提供局部 AABB
  供射线检测使用，使传感器打到真实板厚而不是包围球。
- **材质**：13 种内置预设（板材、3D 打印、塑料），预设库按场景叠加，实体可局部覆盖。
- **板面印刷**：`paint` 以数据描述（底色 + 沿轴条带），传感器与渲染共用同一份定义，无需把位图
  跨沙箱传递；复杂图案再用 `SurfaceColorResolver.samplers` 覆写采样。

---

## 关节系统

- **类型**：`revolute`（旋转）、`prismatic`（平移）、`spherical`、`fixed`。
- **控制**：`position` / `velocity` / `torque` 三种目标。
- **反馈**：位置、速度、力矩。
- **连接**：`bodyA`（父）与可选 `bodyB`（省略表示世界锚点）。
- **目标路径**：原理图设备 → 话题 → 关节实体 → `PhysicsRuntime.setJointTarget`（话题集成未完成前
  由宿主 RPC 直接下指令）。

---

## 传感器系统

框架已完备：注册表 + 采样节流（picoseconds 虚拟时钟）+ `mountedOn` 世界位姿组合 + 读数按
`sensorData` 推送到所属装配体的电路沙箱，单个传感器失败只记录日志、不中断当前帧。

| 传感器      | 数据                                         | 状态    |
| ----------- | -------------------------------------------- | ------- |
| `distance`  | 最近命中距离（锥形固定射线图案）             | ✅      |
| `color`     | 命中表面 RGB + 灰度                          | ✅      |
| `imu`       | 角速度、比力、姿态（传感器局部系）           | ✅      |
| `gps`       | 经纬高 + 精度，噪声按 `sensor.id` 播种可复现 | ✅      |
| `camera`    | RGBA 帧                                      | ⏳ #196 |
| `light`     | 照度                                         | ⏳      |
| `sound`     | 声强                                         | ⏳      |
| `magnetic`  | 磁场强度（干簧管）                           | ⏳      |
| `occlusion` | 光电门遮挡                                   | ⏳      |
| `touch`     | 接触力                                       | ⏳      |

未实现的 6 种已有完整的类型契约，因此文档与接线可以先行编写；宿主遇到未注册的传感器会告警并
跳过，不会阻塞场景加载。颜色传感器沿 `config.direction`（默认朝下）发射射线取色，因此不仅能读
地面，也能读任意被照射表面（例如立起来的亚克力板）。

---

## 时间同步与确定性

- 物理与电气共享虚拟时钟：文档/宿主用毫秒，传感器读数用 picoseconds 时间戳。
- 固定步长（默认 16.67 ms / 60 Hz），支持子步细分。
- **锁步**：所有电路仿真器到达同一目标时间后才推进一步物理，时钟最后提交 —— `step` 中途抛错时
  时钟停留在上一个完整同步点，可安全重试。
- 代价：最慢的仿真器决定整体帧率；后续可加超时降级。
- 相同初始状态 + 相同 `deltaMs` 序列 → 相同结果，便于回放与调试。

---

## 编辑器（未实现）

3D 编辑器作为 `@mica-js/editor` 的第三个组合根，消费 `@mica-js/scene-3d/client`：

- Three.js 视口、相机控制、Transform Gizmo、实体选择。
- 2D 轮廓编辑器（绘制、节点编辑、布尔运算、倒角），SVG 导入。
- 属性面板（位置、旋转、物理属性、传感器配置）与预制件库。
- 调试可视化：碰撞体线框、关节轴与锚点、传感器作用范围。

---

## 坐标与单位

- **世界坐标系**：右手系，Y 轴向上，单位米。MuJoCo（Z 轴向上）在适配层换算。
- **长度**：文档米，编辑器 UI 毫米；**质量** 千克，密度 g/cm³；**角度** 文档弧度，UI 度；
  **时间** 毫秒（宿主）/ 皮秒（电路与传感器）。

---

## 示例场景

- **循迹机器人**（已实现）：白色亚克力赛道 + 印刷黑线，双轮差速底盘 + 两个朝下颜色传感器，
  主线程比例转向。
- **迷宫探索**：亚克力墙板拼装 + 距离传感器 + GPS。
- **机械臂抓取**：多关节臂 + `prismatic` 夹爪 + 摄像头 + 触觉传感器（依赖摄像头与接触传感器）。
