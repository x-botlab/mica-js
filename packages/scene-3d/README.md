# @mica-js/scene-3d

3D 场景核心包：`.scene3d` 文档、物理实体、传感器与确定性运行时。

当前处于 Phase 1 阶段：提供跨层共用的 3D 数学类型（`Vec2d` / `Vec3d` / `Quaternion` / `Transform`）、`.scene3d` 文档格式类型、`.assembly.json` 装配体定义类型、实体系统类型（`SceneEntity` / `ModelEntity` / `AssemblyInstance` / `JointEntity` / `SensorEntity`、几何、碰撞体、材质与物理描述符）、`physics/` 物理运行时适配层（`PhysicsRuntime` 契约与确定性的 `MujocoRuntime` 内存替身），以及 `runtime/` 的 `Scene3DRuntime`（锁步时间同步）。真实 MuJoCo WASM 引擎与电路仿真器由后续 issue 逐步接入。

## 安装与构建

```bash
pnpm --filter @mica-js/scene-3d build     # ESM + 打包后的 d.ts
pnpm --filter @mica-js/scene-3d test      # Vitest
pnpm --filter @mica-js/scene-3d typecheck # tsc --noEmit
```

## 用法

```ts
import { Quaternion, Transform, Vec3d } from '@mica-js/scene-3d';

const body = Transform.from({ x: 0, y: 0, z: 0.05 }, Quaternion.fromEuler(0, 0, Math.PI / 2));

const wheel = Vec3d.add(body.position, { x: 0.1, y: 0, z: 0 });
const forward = Quaternion.rotate(body.rotation, Vec3d.unitX);
const axle = Vec3d.cross(forward, Vec3d.unitZ);
```

```ts
import { BUILTIN_MATERIAL_PRESETS, SCENE3D_VERSION, type Scene3DDocument } from '@mica-js/scene-3d';

const scene: Scene3DDocument = {
  version: SCENE3D_VERSION,
  world: {
    gravity: { x: 0, y: -9.81, z: 0 },
    physicsStep: 1000 / 60,
    ground: { enabled: true, friction: 0.8, restitution: 0.1 },
  },
  entities: [],
  environment: { ambientLight: { color: '#ffffff', intensity: 0.8 } },
  materials: { presets: BUILTIN_MATERIAL_PRESETS, default: 'acrylic' },
};
```

```ts
import { Quaternion, Vec3d, type ModelEntity } from '@mica-js/scene-3d';

const crate: ModelEntity = {
  id: 'crate',
  type: 'model',
  position: Vec3d.zero,
  rotation: Quaternion.identity,
  geometry: { type: 'box', size: { x: 0.2, y: 0.2, z: 0.2 } },
  material: { friction: 0.6, restitution: 0.2 },
  collider: { type: 'box', size: { x: 0.2, y: 0.2, z: 0.2 } },
  physics: { bodyType: 'dynamic', mass: 0.5 },
};
```

```ts
import { MujocoRuntime, Vec3d } from '@mica-js/scene-3d';

const physics = new MujocoRuntime();
await physics.initialize({ bodyType: 'dynamic' });

const ball = physics.addBody({
  position: { x: 0, y: 1.5, z: 0 },
  collider: { type: 'sphere', radius: 0.1 },
});

physics.step(16);
const { position } = physics.getBodyTransform(ball);
const hit = physics.raycast(Vec3d.zero, Vec3d.unitY, 10);
```

## 约定

| 约定       | 说明                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 单位       | 长度用米（m），角度用弧度（rad）；编辑器 UI 可以自行换算成毫米与角度                             |
| 坐标系     | 右手系；叉积按 `a × b` 计算                                                                      |
| Euler 顺序 | 内旋 X → Y → Z，与 Three.js 的 `'XYZ'` 一致                                                      |
| 不可变性   | 所有类型只读，所有函数纯函数：返回新对象，不修改入参，便于共享与比较                             |
| 共享常量   | `Vec3d.zero` / `Vec3d.unitZ` / `Quaternion.identity` / `Transform.identity` 已冻结，可跨实体复用 |
| 退化输入   | 零向量归一化为零向量，零四元数归一化为单位四元数，零轴不产生旋转，避免 `NaN`                     |

## API

### `Vec2d`

平面坐标或尺寸，`{ x, y }`；用于 `plane` 几何的 `size`。

### `Vec3d`

位置或方向，`{ x, y, z }`。

常量：`zero`、`one`、`unitX`、`unitY`、`unitZ`。

函数：`add`、`sub`、`scale`、`dot`、`cross`、`length`、`normalize`、`equals`（可选 `epsilon`）。

### `Quaternion`

四元数 `{ x, y, z, w }`，其中 `w` 为标量部分。

函数：

- `fromAxisAngle(axis, radians)` — 轴角构造；轴无需归一化
- `fromEuler(x, y, z)` — 内旋 X → Y → Z
- `multiply(a, b)` — Hamilton 积，先应用 `b` 再应用 `a`
- `conjugate(q)` — 单位四元数的逆旋转
- `normalize(q)`
- `rotate(q, v)` — 用单位四元数旋转向量
- `equals(a, b, epsilon?)`

### `Transform`

实体摆放：`position`、`rotation`，以及可选的 `scale`（缺省表示单位缩放）。

常量 `Transform.identity`，构造函数 `Transform.from(position, rotation?, scale?)`。

### `.scene3d` 文档格式

`SCENE3D_VERSION`（当前为 `1`）标识文档 schema 版本；读取方应拒绝不认识的版本。

`Scene3DDocument` 的根字段：

| 字段          | 说明                                                            |
| ------------- | --------------------------------------------------------------- |
| `version`     | schema 版本，固定为 `SCENE3D_VERSION`                           |
| `schematic?`  | 绑定的 `.sch` 原理图                                            |
| `world`       | 物理世界：`gravity`（m/s²）、`physicsStep`（ms）与可选 `ground` |
| `entities`    | 场景实体，使用 `entities/` 中的 `SceneEntity` 基类              |
| `environment` | `ambientLight` 必填，`directionalLight` 与 `skybox` 可选        |
| `materials?`  | 场景级 `MaterialLibrary`                                        |

文档单位：长度用米（m）、角度用弧度（rad）、质量用千克（kg）；材质密度用 g/cm³，
`friction` / `restitution` / `opacity` / `metalness` / `roughness` 均为 0–1 的无量纲系数。

`MaterialPreset` 将物理属性（`density`、`friction`、`restitution`）与视觉默认值（`color`、
`opacity`、`metalness`、`roughness`）打包；`MaterialLibrary.presets` 以名称为键，`default`
指定未命名时的默认预设。

内置 `BUILTIN_MATERIAL_PRESETS` 提供 13 种预设：

| 类别     | 预设                                                                  |
| -------- | --------------------------------------------------------------------- |
| 板材     | `acrylic`、`acrylic-colored`、`pc-board`、`wood`、`aluminum`、`steel` |
| 3D 打印  | `pla`、`abs`、`petg`、`tpu`                                           |
| 常见塑料 | `pvc`、`pp`、`nylon`                                                  |

单元测试校验所有预设的 `density > 0`，且 `friction` / `restitution` / 视觉系数均落在 0–1。

### `.assembly.json` 装配体定义格式

`ASSEMBLY_VERSION`（当前为 `1`）标识装配体定义的 schema 版本；读取方应拒绝不认识的版本。
`AssemblyDefinition` 把可复用的机器人/装配体模板绑定到一个原理图：

| 字段            | 说明                                            |
| --------------- | ----------------------------------------------- |
| `version`       | schema 版本，固定为 `ASSEMBLY_VERSION`          |
| `name`          | 稳定名称，供 `AssemblyInstance.assembly` 引用   |
| `displayName?`  | 编辑器显示名                                    |
| `schematic`     | 绑定的 `.sch` 原理图；每个实例各自加载一份      |
| `entities`      | 装配体内的实体（模型、关节、传感器）            |
| `centerOfMass?` | 装配体局部坐标下的质心                          |
| `metadata?`     | `author` / `description` / `thumbnail` / `tags` |

关节通过 `inputBinding` / `outputBinding`、传感器通过 `binding` 绑定到装配体自己的原理图，
因此同一装配体定义可以在场景中多次实例化，每个实例拥有独立的电路仿真器。

`validateAssemblyDefinition(value)` 校验 `JSON.parse` 的结果并返回 `{ ok, diagnostics }`，不会
抛异常；未知字段会被忽略，以便向前兼容。`examples/robot-car.assembly.json` 是一个包含底盘、
车轮、电机与传感器的完整示例。

### 实体系统

实体类型定义在 `entities/`：

- `SceneEntity` — 所有实体共有的 `id`、`type`、可选 `name`，以及初始 `position` / `rotation`
- `ModelEntity` — `type: 'model'`，在基类之上组合 `geometry`、`material`、`collider` 与 `physics`
- `AssemblyInstance` — `type: 'assembly'`，通过 `assembly`（`package:name`）引用装配体定义，可选 `overrides`
- `JointEntity` — `type: 'joint'`，`inputBinding` 接收力矩/推力指令，`outputBinding` 发布位置反馈
- `SensorEntity` — `type: 'sensor'`，`sensorType` + `config` 描述 10 种传感器，`mountedOn` 指定挂载实体，`bindings` 发布读数
- 绑定点统一为 `{ symbol, port }`：实体不再通过 `symbol` 整体绑定器件
- `PhysicsConfig` — `bodyType` 支持 `static` / `dynamic` / `kinematic`；可配置 `mass`、`velocity`、`angularVelocity` 与逐轴 `constraints`
- `GeometryDescriptor` — 基础形状联合：`box`、`sphere`、`cylinder`、`capsule`、`plane`；`GEOMETRY_TYPES` 给出同样的顺序
- `ColliderDescriptor` — `box` / `sphere` / `cylinder` / `capsule`，以及从几何体生成的 `trimesh` / `convex-hull` 和递归的 `compound`
- `MaterialDescriptor` — 可选渲染属性（颜色、贴图、金属度、粗糙度、透明度）与必填的 `friction` / `restitution`

常量 `ENTITY_TYPES`、`BODY_TYPES`、`GEOMETRY_TYPES` 与 `SENSOR_TYPES` 可用于编辑器列表和运行时校验。

### 传感器系统

`sensors/` 提供确定性的距离、IMU、GPS 和颜色传感器：

- `SensorData` — 10 种传感器读数的判别联合，每条读数带 picoseconds 虚拟时间戳
- `Sensor` — 抽象基类；`tryUpdate(physics, currentTime)` 按 `config.updateRate` 节流，未到采样时间返回 `null`
- `createDefaultSensorRegistry({ document })` — 为每个场景创建独立的默认注册表；传入文档会自动为颜色传感器建立材质颜色解析器
- `SensorRegistry` — 可注册自定义工厂：`registry.register('my-sensor', entity => new MySensor(entity))`
- 颜色传感器从世界位姿**朝下发射射线读取赛道颜色**，将命中的材质颜色或 `SurfaceColorResolver` 解析结果转换为 RGB；没有命中或没有颜色时按白色 `[255, 255, 255]` 处理
- `createMaterialColorResolver` 使用命中 `bodyId` 对应模型的 `material.color`（支持 `#rrggbb` / `#rgb`），`samplers` 可按命中点覆写赛道位图颜色；`createSolidColorResolver` 适合测试
- `mountedOn` 指定父实体时，`getWorldTransform()` 组合父刚体位姿与传感器局部偏移；IMU 的 `.getBodyMotion()` 是物理运行时可选能力，不支持时退化为零运动
- IMU 读数在**传感器自身坐标系**：`angularVelocity` 与 `linearAcceleration`（比力，含重力反作用，静止时沿背离地面轴向读 `+9.81`）都按 `orientation` 的逆旋转到局部轴；`orientation` 仍是世界系四元数

宿主默认每次创建自己的注册表，也可以通过 `Scene3DHostOptions.sensors` 注入自定义注册表：

```ts
const sensors = createDefaultSensorRegistry({ document });
const host = await createScene3DHost({ document, physics, renderer, sensors });
```

### 物理运行时

`physics/` 提供与具体引擎解耦的 `PhysicsRuntime` 适配层（#180）：

- `PhysicsRuntime` — `initialize` / `step` / `addBody` / `addJoint` / `setJointTarget` / `getBodyTransform` / `getJointState` / `raycast` / `dispose`
- `RigidBodyConfig` — 刚体描述：`collider` 必填，`bodyType`、`position`、`rotation`、`mass`、`velocity`、`angularVelocity`、`constraints` 可选
- `JointConfig` — `revolute` / `prismatic` / `spherical` / `fixed`，连接 `bodyA`（与可选的 `bodyB`，省略表示世界），支持 `limits` 与 `motor`
- `JointTarget` — `position` / `velocity` / `torque` 三种命令；`JointState` 返回 `position` / `velocity` / `torque`
- `RaycastHit` — 命中的 `bodyId`、`distance`、`point` 与 `normal`
- `MujocoRuntime` — 当前为确定性的内存替身：世界坐标系 Y 轴向上（`DEFAULT_GRAVITY` 为 `-9.81`），模拟重力自由落体、逐轴运动约束、关节伺服与包围球射线检测；接触、摩擦、转动惯量与精确网格射线检测留给真实 MuJoCo WASM 适配

```ts
import { MujocoRuntime, Vec3d } from '@mica-js/scene-3d';

const physics = new MujocoRuntime();
await physics.initialize({ bodyType: 'dynamic' });

const ball = physics.addBody({
  position: { x: 0, y: 1.5, z: 0 },
  collider: { type: 'sphere', radius: 0.1 },
});

physics.step(16);
const { position } = physics.getBodyTransform(ball);
const hit = physics.raycast(Vec3d.zero, Vec3d.unitY, 10);
```

### 场景运行时与时间同步

`runtime/` 提供 `Scene3DRuntime`（#182）：它把物理引擎与（后续接入的）电路仿真器放在同一条虚拟时间轴上，采用**锁步（lockstep）**推进。

`step(deltaMs)` 的固定执行顺序：

1. 采集传感器数据（#192 接入前为空实现）
2. 把所有电路仿真器推进到同一目标时间 `currentTime + deltaMs`，并等待全部完成（#214 接入前为空实现）
3. 收集电路发布的关节指令
4. 将指令应用为关节目标（`PhysicsRuntime.setJointTarget`）
5. `PhysicsRuntime.step(deltaMs)` 推进物理
6. 提交 `currentTime = currentTime + deltaMs`

时间同步要点：

- 所有子系统都到达目标时间后物理才前进一步，因此不存在"电路已经跑到刚体前面"的帧
- `currentTime` / `getCurrentTime()` 以毫秒（`TimeMs`）表示；电路层的 `TimePs`（皮秒）在边界处换算
- 时钟最后提交：若 `step` 中途抛错，`currentTime` 停留在上一个完整同步的时间点，可安全重试该帧
- 相同的初始状态 + 相同的 `deltaMs` 序列 → 相同的刚体位姿与关节状态，便于回放和调试
- `deltaMs` 必须为有限且非负的数值，否则抛出 `RangeError`

```ts
import { createMujocoRuntime, Scene3DRuntime } from '@mica-js/scene-3d';

const physics = createMujocoRuntime();
await physics.initialize({ bodyType: 'dynamic' });
physics.addBody({
  position: { x: 0, y: 1.5, z: 0 },
  collider: { type: 'sphere', radius: 0.1 },
});

const runtime = new Scene3DRuntime({ physics });
await runtime.step(1000 / 60);
runtime.getCurrentTime(); // 16.666…
```

`RuntimeOptions` 支持注入 `physics`（调用方负责先 `initialize()`）与设置起始虚拟时间 `startTime`（毫秒，默认 `0`）。

## 仿真主机（SandboxWorker）

`Scene3DHost` 把物理、传感器与电路协调放在隔离 guest 中，主线程只保留渲染与交互：

```
Main Thread ── RPC ── Scene host guest
     │                     ├── PhysicsRuntime（MuJoCo）
     │                     ├── Sensor System
     │                     └── Circuit guests（父子 MessageChannel 直连）
     └── Scene3DClient + Three.js view
```

浏览器应用从 `@mica-js/scene-3d/client` 获取 worker 工厂和客户端：

```ts
import {
  createScene3DHostSandbox,
  createScene3DHostProxy,
  Scene3DClient,
} from '@mica-js/scene-3d/client';

const worker = createScene3DHostSandbox();
const client = await Scene3DClient.create({
  document,
  view: createThreeScene3DView({ canvas }),
  createHost: async ({ document }) => createScene3DHostProxy(worker, { document }),
});

await client.step(1000 / 60); // host 锁步推进 → 批量变换 → 渲染
```

宿主 guest 通过 `sceneHostHost` RPC 服务取得文档并请求电路 guest；主线程只创建和终止
`SandboxWorker`，电路的 `MessagePort` 在场景 guest 与电路 guest 之间直连。guest 只持有通道，
因此删除装配体实例时它会通过 `releaseCircuitSandbox` 请主线程终止对应 worker，避免中途移除实体后
遗留后台 worker。

无头环境不需要浏览器沙箱，可直接在进程内创建一等 host：

```ts
import { createHeadlessRenderer, createMujocoRuntime, createScene3DHost } from '@mica-js/scene-3d';

const host = await createScene3DHost({
  document,
  physics: createMujocoRuntime(),
  renderer: createHeadlessRenderer(),
});
await host.step(1000 / 60);
await host.dispose();
```

`Scene3DHost.step(deltaMs)` 的固定顺序：

1. 同一 `deltaMs` 推送给所有电路仿真器；
2. 锁步屏障：等待全部电路完成；
3. 收集电路在推进期间发出的 `jointCommand`；
4. 在物理步进前应用指令；
5. 物理步进相同 `deltaMs`；
6. 读取到期传感器并通过 `sensorData` 通知所属装配体的电路；
7. 提交虚拟时钟并返回 `entityCount * 16` 的列主序变换批次。

`PhysicsRuntime.removeBody` 为可选能力；`MujocoRuntime` 已实现，移除实体时会同时清理其关节。

## 依赖方向

`@mica-js/scene-3d` 只依赖 `@mica-js/core`（虚拟时间与 RPC）；沙箱相关代码（`client` 与 `guest`）另外使用 `@mica-js/sandbox` 的传输层，`three` 是 `client/three` 的可选 peer。渲染、物理与传感器都在本包内，因此无头环境可以直接在进程内运行 host。

向上不依赖 `@mica-js/editor`：3D 编辑器（视口、gizmo、属性面板）作为 `@mica-js/editor` 的第三个组合根，依赖本包的 `@mica-js/scene-3d/client`，方向始终是 editor → scene-3d。
