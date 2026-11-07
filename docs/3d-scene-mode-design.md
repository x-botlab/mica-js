# 3D 场景模式设计方案

## 1. 概述

### 1.1 设计目标

在现有的 2D Widget 模式基础上，增加 3D 场景模式，支持物理维度的仿真。3D 场景模式支持：

- **多原理图实例**：一个场景可运行多个独立的电路仿真（每个装配体对应独立的原理图）
- **装配体复用**：装配体定义可在多个场景中复用
- **物理仿真**：基于 MuJoCo 的确定性物理引擎

### 1.2 核心原则

- **分层复用**：复用现有的 `@mica-js/core`、`@mica-js/device`、`@mica-js/simulator` 层，仅在表现层增加 3D 能力
- **统一时钟**：3D 物理仿真与所有电气仿真实例共享同一虚拟时间轴（`TimePs`），采用锁步同步
- **确定性**：物理仿真结果可复现，支持步进、暂停、回放
- **隔离性**：每个电路仿真运行在独立的 sandbox 中，防止相互干扰

---

## 2. 架构设计

### 2.1 包结构

新增以下包：

```
packages/
  ├── scene-3d/              # 3D 场景核心
  │   ├── src/
  │   │   ├── format/        # .scene3d 文档格式
  │   │   ├── physics/       # 物理引擎适配层
  │   │   ├── entities/      # 实体系统（静态、动态、关节、装配体）
  │   │   ├── sensors/       # 传感器系统
  │   │   └── runtime/       # 3D 场景运行时
  │   └── package.json
  │
  └── scene-editor/          # 3D 场景编辑器
      ├── src/
      │   ├── viewport/      # Three.js 视口
      │   ├── controls/      # 相机控制、gizmo
      │   ├── inspector/     # 属性面板
      │   └── library/       # 预制件库
      └── package.json
```

### 2.2 文档格式

#### 2.2.1 场景文档：`.scene3d`

```typescript
export const SCENE3D_VERSION = 1;

/** 3D 场景文档根结构 */
export interface Scene3DDocument {
  readonly version: typeof SCENE3D_VERSION;

  /** 场景级原理图（用于非装配体实体，可选） */
  readonly schematic?: string;

  /** 物理世界配置 */
  readonly world: WorldConfig;

  /** 场景中的所有实体（包括装配体实例） */
  readonly entities: readonly SceneEntity[];

  /** 环境配置（光照、天空盒等） */
  readonly environment: EnvironmentConfig;

  /** 材质预设库 */
  readonly materials?: MaterialLibrary;
}
```

#### 2.2.2 装配体定义：`.assembly.json`

装配体是可复用的实体组合，通常对应一个完整的机器人或机械结构：

```typescript
export const ASSEMBLY_VERSION = 1;

/** 装配体定义 */
export interface AssemblyDefinition {
  readonly version: typeof ASSEMBLY_VERSION;

  /** 装配体名称 */
  readonly name: string;

  /** 装配体绑定的原理图 */
  readonly schematic: string;

  /** 装配体内的实体（模型、关节、传感器等） */
  readonly entities: readonly SceneEntity[];

  /** 装配体质心（可选，用于整体操作） */
  readonly centerOfMass?: Vec3d;
}
```

**工作方式**：

- 装配体定义保存在独立的 `.assembly.json` 文件中，可被多个场景复用
- 每个装配体定义绑定一个原理图文件
- 场景实例化装配体时，会为每个实例创建独立的电路仿真器（sandbox）
- 装配体内的传感器和关节通过相对绑定连接到装配体自己的原理图

#### 2.2.3 材质预设库

/** 材质预设库 _/
export interface MaterialLibrary {
/_* 预设材质集合 */
readonly presets: Record<string, MaterialPreset>;

/** 默认材质名称（用于亚克力板） */
readonly default?: string;
}

/** 材质预设 */
export interface MaterialPreset {
readonly displayName: string;

/** 密度 (g/cm³) */
readonly density: number;

/** 物理属性 */
readonly friction: number;
readonly restitution: number;

/** 默认视觉属性（可被实体覆盖） */
readonly color?: string;
readonly opacity?: number;
readonly metalness?: number;
readonly roughness?: number;
}

/** 内置材质预设 */
export const BUILTIN_MATERIAL_PRESETS: Record<string, MaterialPreset> = {
'acrylic': {
displayName: '标准亚克力',
density: 1.18,
friction: 0.5,
restitution: 0.3,
color: '#ffffff',
opacity: 0.9
},
'acrylic-colored': {
displayName: '彩色亚克力',
density: 1.18,
friction: 0.5,
restitution: 0.3,
opacity: 0.85
},
'pc-board': {
displayName: 'PC板（聚碳酸酯）',
density: 1.20,
friction: 0.4,
restitution: 0.5,
color: '#f0f0f0',
opacity: 0.95
},
'wood': {
displayName: '木板',
density: 0.65,
friction: 0.6,
restitution: 0.2,
color: '#d2b48c'
},
'aluminum': {
displayName: '铝板',
density: 2.70,
friction: 0.3,
restitution: 0.4,
color: '#c0c0c0',
metalness: 0.8,
roughness: 0.3
},
'steel': {
displayName: '钢板',
density: 7.85,
friction: 0.4,
restitution: 0.3,
color: '#808080',
metalness: 0.9,
roughness: 0.4
}
};

````

### 2.2.2 装配体定义格式

装配体定义（`.assembly.json`）是可复用的机器人/装配体模板：

```typescript
/** 装配体定义 */
export interface AssemblyDefinition {
  readonly version: 1;

  /** 装配体名称 */
  readonly name: string;

  /** 人类可读显示名 */
  readonly displayName?: string;

  /** 绑定的原理图文件路径 */
  readonly schematic: string;

  /** 装配体包含的实体（模型、关节、传感器等） */
  readonly entities: readonly SceneEntity[];

  /** 装配体质心（可选，用于整体操作） */
  readonly centerOfMass?: Vec3d;

  /** 元数据 */
  readonly metadata?: {
    readonly author?: string;
    readonly description?: string;
    readonly thumbnail?: string;
    readonly tags?: readonly string[];
  };
}
````

**工作原理**：

1. **装配体定义**是模板，包含：
   - 绑定的原理图（`schematic` 字段）
   - 实体列表（模型、关节、传感器）
   - 实体间的话题绑定（相对于装配体自己的原理图）

2. **场景实例化**装配体时：
   - 创建独立的电路仿真器（sandbox）
   - 加载装配体绑定的原理图
   - 将实体的话题绑定映射到该仿真器

3. **示例**：

```json
// robot-car.assembly.json
{
  "version": 1,
  "name": "robot-car",
  "displayName": "双轮循迹小车",
  "schematic": "./robot-car.sch",
  "entities": [
    {
      "id": "chassis",
      "type": "model",
      "geometry": { "type": "box", "size": [0.15, 0.05, 0.1] },
      "position": [0, 0.025, 0],
      "rotation": [0, 0, 0, 1]
    },
    {
      "id": "left-wheel",
      "type": "model",
      "geometry": { "type": "cylinder", "radius": 0.03, "height": 0.02 },
      "position": [-0.06, 0, -0.05],
      "rotation": [0, 0, 0, 1]
    },
    {
      "id": "left-motor",
      "type": "joint",
      "jointType": "revolute",
      "bodyA": "chassis",
      "bodyB": "left-wheel",
      "axis": [0, 0, 1],
      "bindings": {
        "torque": {
          "symbol": "motor-left",
          "port": "torque"
        },
        "position": {
          "symbol": "encoder-left",
          "port": "angle"
        }
      }
    },
    {
      "id": "distance-sensor",
      "type": "sensor",
      "sensorType": "distance",
      "config": { "type": "distance", "maxRange": 2.0, "fov": 15, "updateRate": 10 },
      "position": [0.08, 0.025, 0],
      "rotation": [0, 0, 0, 1],
      "bindings": {
        "distance": {
          "symbol": "ultrasonic-1",
          "port": "distance"
        }
      },
      "mountedOn": "chassis"
    }
  ]
}

// race-track.scene3d（使用装配体）
{
  "version": 1,
  "entities": [
    {
      "id": "car-1",
      "type": "assembly",
      "assembly": "robot-car",  // 引用装配体定义
      "position": [0, 0.1, 0],
      "rotation": [0, 0, 0, 1]
    },
    {
      "id": "car-2",
      "type": "assembly",
      "assembly": "robot-car",  // 复用同一定义
      "position": [1, 0.1, 0],
      "rotation": [0, 0, 0, 1]
    }
  ]
}
```

运行时：

- `car-1` 创建独立的电路仿真器 → 加载 `robot-car.sch`
- `car-2` 创建另一个独立的电路仿真器 → 加载 `robot-car.sch`
- 两辆车的传感器和电机互不干扰

### 2.2.3 场景文档格式

```typescript
/** 场景文档根对象 */
export interface Scene3DDocument {
  readonly version: 1;

  /** 场景级原理图（用于非装配体实体，可选） */

  /** 物理世界配置 */
  readonly world: WorldConfig;

  /** 场景中的所有实体 */
  readonly entities: readonly SceneEntity[];

  /** 环境配置（光照、天空盒等） */
  readonly environment: EnvironmentConfig;
}

/** 物理世界配置 */
export interface WorldConfig {
  /** 重力加速度 (m/s²) */
  readonly gravity: Vec3d;

  /** 物理步长 (ms)，默认 16.67ms (60Hz) */
  readonly physicsStep: number;

  /** 地面配置 */
  readonly ground?: {
    readonly enabled: boolean;
    /** 地面材质（用于循迹图像等） */
    readonly texture?: string;
    readonly friction: number;
    readonly restitution: number;
  };
}

/** 环境配置 */
export interface EnvironmentConfig {
  readonly ambientLight: {
    readonly color: string;
    readonly intensity: number;
  };
  readonly directionalLight?: {
    readonly color: string;
    readonly intensity: number;
    readonly position: Vec3d;
  };
  readonly skybox?: string;
}
```

### 2.3 实体系统

```typescript
/** 场景实体类型 */
export type EntityType =
  | 'model'       // 物理模型（静态或动态，包括标准模型和亚克力板）
  | 'assembly'    // 装配体（机器人）
  | 'joint'       // 关节
  | 'sensor';     // 传感器

/** 场景实体基类 */
export interface SceneEntity {
  readonly id: string;
  readonly type: EntityType;
  readonly name?: string;

  /** 初始位置 */
  readonly position: Vec3d;

  /** 初始旋转（四元数） */
  readonly rotation: Quaternion;
}

/** 装配体实例 */
export interface AssemblyInstance extends SceneEntity {
  readonly type: 'assembly';

  /** 引用装配体定义，格式："package:name" */
  readonly assembly: string;

  /** 属性覆盖（可选） */
  readonly overrides?: Record<string, unknown>;
}

/** 物理模型实体（统一静态和动态） */
export interface ModelEntity extends SceneEntity {
  readonly type: 'model';
  readonly geometry: GeometryDescriptor;
  readonly material: MaterialDescriptor;
  readonly collider: ColliderDescriptor;

  /** 物理配置 */
  readonly physics: PhysicsConfig;
}

/** 几何描述 */
export type GeometryDescriptor =
  | { type: 'box'; size: Vec3d }
  | { type: 'sphere'; radius: number }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'capsule'; radius: number; height: number }
  | { type: 'plane'; size: Vec2d }
  | { type: 'mesh'; url: string; format: 'stl' | 'glb' | 'gltf' | 'obj' }  // 标准 3D 模型
  | { type: 'heightmap'; url: string; scale: Vec3d }  // 地形
  | { type: 'acrylic'; definition: AcrylicDefinition };  // 亚克力板（激光切割）

/** 亚克力板定义（激光切割） */
export interface AcrylicDefinition {
  /** 2D 轮廓（SVG path 或顶点数组） */
  readonly contour: AcrylicContour;

  /** 板厚度 (mm) */
  readonly thickness: number;

  /** 材质预设名称，默认 'acrylic' */
  readonly material?: string;

  /** 以下属性可覆盖材质预设 */
  readonly density?: number;     // 覆盖预设密度
  readonly color?: string;       // 覆盖预设颜色（支持透明度）
  readonly opacity?: number;     // 覆盖预设透明度

  /** 表面纹理/图片（独立于预设） */
  readonly texture?: string;

  /** 是否双面贴图 */
  readonly doubleSided?: boolean;
}

/** 2D 轮廓定义 */
export type AcrylicContour =
  | { type: 'svg'; path: string }  // SVG path 数据
  | { type: 'polygon'; points: Vec2d[] }  // 多边形顶点
  | { type: 'circle'; radius: number }
  | { type: 'rect'; width: number; height: number }
  | { type: 'compound'; contours: AcrylicContour[] };  // 组合（支持打孔）

/** 碰撞体描述 */
export type ColliderDescriptor =
  | { type: 'box'; size: Vec3d }
  | { type: 'sphere'; radius: number }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'capsule'; radius: number; height: number }
  | { type: 'trimesh'; source: 'geometry' }  // 使用几何体生成精确网格碰撞
  | { type: 'convex-hull'; source: 'geometry' }  // 使用几何体生成凸包（性能更好）
  | { type: 'compound'; children: ColliderDescriptor[] };

/** 材质描述 */
export interface MaterialDescriptor {
  /** 渲染材质 */
  readonly color?: string;
  readonly texture?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly opacity?: number;  // 透明度（亚克力需要）

  /** 物理材质 */
  readonly friction: number;
  readonly restitution: number;  // 弹性系数
}

/** 物理模型实体（统一静态和动态） */
export interface ModelEntity extends SceneEntity {
  readonly type: 'model';
  readonly geometry: GeometryDescriptor;
  readonly material: MaterialDescriptor;
  readonly collider: ColliderDescriptor;

  /** 物理配置 */
  readonly physics: PhysicsConfig;
}

/** 物理配置 */
export interface PhysicsConfig {
  /** 刚体类型 */
  readonly bodyType: 'static' | 'dynamic' | 'kinematic';

  /** 质量 (kg)，dynamic 必须提供，static 忽略 */
  /** 对于亚克力板，可以省略由系统根据密度和体积自动计算 */
  readonly mass?: number;

  /** 初始速度（仅 dynamic） */
  readonly velocity?: Vec3d;
  readonly angularVelocity?: Vec3d;

  /** 运动约束 */
  readonly constraints?: {
    readonly freezePosition?: { x?: boolean; y?: boolean; z?: boolean };
    readonly freezeRotation?: { x?: boolean; y?: boolean; z?: boolean };
  };
}

/** 关节类型 */
export type JointType =
  | 'revolute'    // 旋转关节（单轴）
  | 'prismatic'   // 平移关节（单轴）
  | 'spherical'   // 球形关节（三自由度）
  | 'fixed';      // 固定连接

/** 关节实体 */
export interface JointEntity extends SceneEntity {
  readonly type: 'joint';
/** 关节实体 */
export interface JointEntity extends SceneEntity {
  readonly type: 'joint';
  readonly jointType: JointType;

  /** 连接的两个实体 */
  readonly bodyA: string;  // 实体 ID
  readonly bodyB: string;

  /** 关节在 bodyA 局部坐标系中的锚点 */
  readonly anchorA: Vec3d;

  /** 关节在 bodyB 局部坐标系中的锚点 */
  readonly anchorB: Vec3d;

  /** 关节轴向（局部坐标） */
  readonly axis: Vec3d;

  /** 关节限制 */
  readonly limits?: {
    readonly min?: number;  // 最小角度/位移
    readonly max?: number;  // 最大角度/位移
  };

  /** 电机配置（用于话题控制） */
  readonly motor?: {
    readonly maxForce: number;   // 最大力矩/推力 (N·m 或 N)
    readonly maxVelocity: number; // 最大角速度/线速度 (rad/s 或 m/s)
  };

  /** 端口绑定：接收力矩/推力指令、发布位置/角度反馈 */
  readonly bindings?: Readonly<Record<string, {
    readonly symbol: string;  // 原理图中的符号 ID
    readonly port: string;    // 端口名
  }>>;
}

/** 传感器实体 */
export interface SensorEntity extends SceneEntity {
  readonly type: 'sensor';
  readonly sensorType: SensorType;

  /** 传感器配置（类型特定） */
  readonly config: SensorConfig;

  /** 端口绑定：发布传感器数据 */
  readonly bindings?: Readonly<Record<string, {
    readonly symbol: string;  // 原理图中的符号 ID
    readonly port: string;    // 端口名
  }>>;

  /** 挂载到哪个实体上（如果有） */
  readonly mountedOn?: string;
}

/** 传感器类型 */
export type SensorType =
  | 'camera'      // 摄像头
  | 'distance'    // 距离传感器（超声波/红外）
  | 'color'       // 颜色传感器（循迹）
  | 'imu'         // 惯性测量单元（陀螺仪+加速度计）
  | 'gps'         // GPS
  | 'light'       // 光照传感器
  | 'sound'       // 声音传感器
  | 'magnetic'    // 磁力传感器（霍尔/干簧管）
  | 'occlusion'   // 遮挡传感器（光电门）
  | 'touch';      // 触摸/碰撞传感器

/** 传感器配置（联合类型） */
export type SensorConfig =
  | CameraConfig
  | DistanceConfig
  | ColorConfig
  | IMUConfig
  | GPSConfig
  | LightConfig
  | SoundConfig
  | MagneticConfig
  | OcclusionConfig
  | TouchConfig;

/** 摄像头配置 */
export interface CameraConfig {
  readonly type: 'camera';
  readonly fov: number;        // 视场角
  readonly width: number;      // 分辨率
  readonly height: number;
  readonly near: number;       // 近裁剪面
  readonly far: number;        // 远裁剪面
  readonly updateRate: number; // 更新频率 (Hz)
}

/** 距离传感器配置 */
export interface DistanceConfig {
  readonly type: 'distance';
  readonly maxRange: number;   // 最大测距 (m)
  readonly fov: number;        // 检测锥角度
  readonly updateRate: number;
}

/** 颜色传感器配置（循迹） */
export interface ColorConfig {
  readonly type: 'color';
  readonly sampleRadius: number;  // 采样半径 (m)
  readonly updateRate: number;
}

/** IMU 配置 */
export interface IMUConfig {
  readonly type: 'imu';
  readonly updateRate: number;
  readonly gyroNoise?: number;    // 陀螺仪噪声标准差
  readonly accelNoise?: number;   // 加速度计噪声标准差
}

/** GPS 配置 */
export interface GPSConfig {
  readonly type: 'gps';
  readonly updateRate: number;
  readonly accuracy: number;      // 精度 (m)
  readonly origin?: Vec3d;        // 坐标系原点（场景坐标 -> GPS 坐标）
}

/** 光照传感器配置 */
export interface LightConfig {
  readonly type: 'light';
  readonly updateRate: number;
}

/** 声音传感器配置 */
export interface SoundConfig {
  readonly type: 'sound';
  readonly updateRate: number;
  readonly sensitivity: number;   // 灵敏度
}

/** 磁力传感器配置 */
export interface MagneticConfig {
  readonly type: 'magnetic';
  readonly updateRate: number;
  readonly threshold?: number;    // 触发阈值（干簧管）
}

/** 遮挡传感器配置 */
export interface OcclusionConfig {
  readonly type: 'occlusion';
  readonly range: number;         // 检测距离 (m)
  readonly updateRate: number;
}

/** 触摸传感器配置 */
export interface TouchConfig {
  readonly type: 'touch';
  readonly threshold: number;     // 触发力阈值 (N)
}
```

### 2.4 物理引擎集成

使用 **MuJoCo** 作为物理引擎（WASM 加速，确定性，专为机器人仿真设计）：

```typescript
import type { Model, Data, Simulation } from 'mujoco_wasm';

/** 物理引擎适配层 */
export interface PhysicsRuntime {
  /** MuJoCo 模型 */
  readonly model: Model;

  /** MuJoCo 仿真数据 */
  readonly data: Data;

  /** 仿真实例 */
  readonly simulation: Simulation;

  /** 实体 ID -> MuJoCo body ID 映射 */
  readonly bodies: Map<string, number>;

  /** 关节 ID -> MuJoCo joint ID 映射 */
  readonly joints: Map<string, number>;

  /** 单步推进物理仿真 */
  step(deltaMs: number): void;

  /** 应用力到刚体 */
  applyForce(entityId: string, force: Vec3d, point?: Vec3d): void;

  /** 应用力矩到刚体 */
  applyTorque(entityId: string, torque: Vec3d): void;

  /** 设置关节目标（电机控制） */
  setJointTarget(jointId: string, target: number | Vec3d): void;

  /** 获取刚体状态 */
  getBodyState(entityId: string): BodyState;
}

export interface BodyState {
  readonly position: Vec3d;
  readonly rotation: Quaternion;
  readonly velocity: Vec3d;
  readonly angularVelocity: Vec3d;
}
```

---

## 3. 运行时集成

### 3.1 3D 场景运行时

```typescript
/** 3D 场景运行时，类似 WidgetHost */
export interface Scene3DRuntime {
  /** 加载场景文档 */
  loadScene(doc: Scene3DDocument): Promise<void>;

  /** 连接到仿真器 */
  attachSimulator(simulator: DeviceSimExecutor): void;

  /** 单步推进（物理 + 传感器） */
  advance(toTime: TimePs): AdvanceReport;

  /** 查询实体状态 */
  getEntityState(id: string): EntityState;

  /** 查询传感器数据 */
  getSensorData(id: string): SensorData;

  /** 订阅传感器更新 */
  onSensorUpdate(id: string, callback: (data: SensorData) => void): Unsubscribe;

  /** Three.js 场景（用于渲染） */
  readonly scene: THREE.Scene;
}
```

### 3.2 与仿真器的集成

```typescript
/** 扩展 DeviceSimHost 支持 3D 场景 */
export interface Scene3DHost extends DeviceSimHost {
  /** 3D 场景运行时 */
  readonly scene3d?: Scene3DRuntime;
}

/** 3D 场景话题类型扩展 */
export type Scene3DPayloadType =
  | TopicPayloadType
  | 'joint-command' // 关节控制指令
  | 'force-command' // 力/力矩指令
  | 'sensor-data' // 传感器数据
  | 'image' // 图像数据（摄像头）
  | 'point-cloud'; // 点云数据

/** 关节控制指令 */
export interface JointCommand {
  readonly mode: 'position' | 'velocity' | 'torque';
  readonly target: number; // 目标位置/速度/力矩
}

/** 传感器数据（联合类型） */
export type SensorData =
  | { type: 'camera'; image: ImageData }
  | { type: 'distance'; distance: number }
  | { type: 'color'; r: number; g: number; b: number }
  | { type: 'imu'; gyro: Vec3d; accel: Vec3d }
  | { type: 'gps'; latitude: number; longitude: number; altitude: number }
  | { type: 'light'; intensity: number }
  | { type: 'sound'; level: number }
  | { type: 'magnetic'; fieldStrength: number }
  | { type: 'occlusion'; blocked: boolean }
  | { type: 'touch'; pressed: boolean; force: number };
```

### 3.3 运行时架构与时间同步

```typescript
/** 3D 场景运行时（主线程） */
export interface Scene3DRuntime {
  /** MuJoCo 物理引擎 */
  readonly physics: PhysicsRuntime;

  /** 多个独立的电路仿真器（sandbox） */
  readonly simulators: Map<string, SimulatorSandbox>;

  /** 传感器系统 */
  readonly sensors: SensorSystem;

  /** 当前虚拟时间 */
  currentTime: TimePs;

  /** 推进一帧（锁步同步） */
  async step(deltaMs: number): Promise<void> {
    const targetTime = this.currentTime + deltaMs * 1_000_000; // 转 ps

    // 1. 采集所有传感器数据
    const sensorData = this.collectSensorData();

    // 2. 并行推进所有电路仿真，等待全部完成（锁步）
    await Promise.all(
      Array.from(this.simulators.entries()).map(async ([id, simulator]) => {
        // 发送传感器数据到对应的原理图实例
        this.publishSensorData(simulator, sensorData.get(id));
        // 推进该电路到目标时间
        await simulator.advance(targetTime);
      })
    );

    // 3. 收集所有电路的控制指令
    const commands = this.collectCommands();

    // 4. 应用到物理引擎（设置关节力矩等）
    this.applyCommands(commands);

    // 5. 推进物理仿真
    this.physics.step(deltaMs);

    this.currentTime = targetTime;
  }
}

/** 电路仿真器沙箱接口 */
export interface SimulatorSandbox {
  /** 向电路发送传感器数据 */
  publish(target: { symbol: string; port: string }, payload: unknown): void;

  /** 订阅电路的控制指令 */
  subscribe(target: { symbol: string; port: string }, callback: (payload: unknown) => void): void;

  /** 推进仿真 */
  advance(targetTime: TimePs): Promise<void>;
}
```

**架构图**：

```
渲染进程 (Three.js 渲染 + 用户交互)
  └─ Scene3DRuntime (仿真主机，主线程)
       ├─ PhysicsRuntime (MuJoCo WASM，主线程)
       ├─ SensorSystem (传感器采集)
       ├─ 场景电路仿真器 (sandbox，可选)
       ├─ 装配体1电路仿真器 (sandbox)
       ├─ 装配体2电路仿真器 (sandbox)
       └─ 装配体N电路仿真器 (sandbox)
```

**时间同步策略**：锁步同步

- 所有电路仿真器必须完成才推进物理
- 确保时间一致性和确定性
- 简化调试和问题追踪

---

## 4. 传感器系统

### 4.1 传感器基类

```typescript
/** 传感器基类 */
export abstract class Sensor<TConfig extends SensorConfig, TData> {
  constructor(
    protected readonly entity: SensorEntity,
    protected readonly config: TConfig,
    protected readonly physics: PhysicsRuntime,
    protected readonly scene: THREE.Scene,
  ) {}

  /** 传感器更新（返回数据或 undefined 表示未到更新时间） */
  abstract update(simTime: TimePs): TData | undefined;

  /** 计算下一次更新时间 */
  protected getNextUpdateTime(currentTime: TimePs): TimePs {
    const updateIntervalPs = (1000 / this.config.updateRate) * 1_000_000;
    return currentTime + updateIntervalPs;
  }
}
```

### 4.2 传感器实现示例

```typescript
/** 距离传感器 */
export class DistanceSensor extends Sensor<DistanceConfig, number> {
  update(simTime: TimePs): number | undefined {
    if (simTime < this.nextUpdateTime) return undefined;

    // 获取传感器位置和方向
    const state = this.physics.getBodyState(this.entity.mountedOn!);
    const origin = this.transformPoint(this.entity.position, state);
    const direction = this.transformDirection(Vec3d.forward, state);

    // Raycast
    const ray = new THREE.Ray(origin, direction);
    const intersects = this.raycaster.intersectObjects(this.scene.children, true);

    const distance = intersects.length > 0 ? intersects[0].distance : this.config.maxRange;

    this.nextUpdateTime = this.getNextUpdateTime(simTime);
    return Math.min(distance, this.config.maxRange);
  }
}

/** 颜色传感器（循迹） */
export class ColorSensor extends Sensor<ColorConfig, { r: number; g: number; b: number }> {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  update(simTime: TimePs) {
    if (simTime < this.nextUpdateTime) return undefined;

    // 获取传感器在地面的投影点
    const state = this.physics.getBodyState(this.entity.mountedOn!);
    const worldPos = this.transformPoint(this.entity.position, state);

    // 从地面纹理采样颜色
    const uv = this.worldToGroundUV(worldPos);
    const color = this.sampleGroundTexture(uv, this.config.sampleRadius);

    this.nextUpdateTime = this.getNextUpdateTime(simTime);
    return color;
  }

  private sampleGroundTexture(uv: Vec2d, radius: number): RGB {
    // 从地面纹理采样（考虑半径内的平均）
    // ...
  }
}

/** IMU 传感器 */
export class IMUSensor extends Sensor<IMUConfig, { gyro: Vec3d; accel: Vec3d }> {
  private lastVelocity?: Vec3d;

  update(simTime: TimePs) {
    if (simTime < this.nextUpdateTime) return undefined;

    const state = this.physics.getBodyState(this.entity.mountedOn!);
    const deltaT = (simTime - this.lastUpdateTime) / 1_000_000_000; // ps -> s

    // 陀螺仪：角速度（带噪声）
    const gyro = this.addNoise(state.angularVelocity, this.config.gyroNoise);

    // 加速度计：线性加速度 + 重力
    const accel = this.lastVelocity
      ? Vec3d.scale(Vec3d.sub(state.velocity, this.lastVelocity), 1 / deltaT)
      : Vec3d.zero;
    const accelWithGravity = Vec3d.add(accel, Vec3d.down.scale(9.81));
    const accelNoisy = this.addNoise(accelWithGravity, this.config.accelNoise);

    this.lastVelocity = state.velocity;
    this.lastUpdateTime = simTime;
    this.nextUpdateTime = this.getNextUpdateTime(simTime);

    return { gyro, accel: accelNoisy };
  }
}

/** GPS 传感器 */
export class GPSSensor extends Sensor<GPSConfig, { lat: number; lon: number; alt: number }> {
  update(simTime: TimePs) {
    if (simTime < this.nextUpdateTime) return undefined;

    const state = this.physics.getBodyState(this.entity.mountedOn!);
    const worldPos = this.transformPoint(this.entity.position, state);

    // 场景坐标 -> GPS 坐标（简化：线性映射 + 噪声）
    const origin = this.config.origin ?? Vec3d.zero;
    const offset = Vec3d.sub(worldPos, origin);

    // 1 度纬度 ≈ 111 km
    const lat = offset.z / 111000 + this.randomGaussian(0, this.config.accuracy / 111000);
    const lon =
      offset.x / (111000 * Math.cos((lat * Math.PI) / 180)) +
      this.randomGaussian(0, this.config.accuracy / 111000);
    const alt = offset.y + this.randomGaussian(0, this.config.accuracy);

    this.nextUpdateTime = this.getNextUpdateTime(simTime);
    return { lat, lon, alt };
  }
}

/** 摄像头传感器 */
export class CameraSensor extends Sensor<CameraConfig, ImageData> {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderTarget: THREE.WebGLRenderTarget;

  constructor(...args) {
    super(...args);

    this.camera = new THREE.PerspectiveCamera(
      this.config.fov,
      this.config.width / this.config.height,
      this.config.near,
      this.config.far,
    );

    this.renderTarget = new THREE.WebGLRenderTarget(this.config.width, this.config.height);
  }

  update(simTime: TimePs) {
    if (simTime < this.nextUpdateTime) return undefined;

    // 更新相机位置
    const state = this.physics.getBodyState(this.entity.mountedOn!);
    const worldPos = this.transformPoint(this.entity.position, state);
    const worldRot = this.transformRotation(this.entity.rotation, state.rotation);

    this.camera.position.copy(worldPos);
    this.camera.quaternion.copy(worldRot);

    // 渲染到纹理
    const renderer = this.getRenderer();
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);

    // 读取像素
    const pixels = new Uint8ClampedArray(this.config.width * this.config.height * 4);
    renderer.readRenderTargetPixels(
      this.renderTarget,
      0,
      0,
      this.config.width,
      this.config.height,
      pixels,
    );

    this.nextUpdateTime = this.getNextUpdateTime(simTime);
    return new ImageData(pixels, this.config.width, this.config.height);
  }
}
```

---

## 5. 关节与装配体

### 5.1 关节控制

```typescript
/** 关节控制器 */
export class JointController {
  constructor(
    private readonly joint: JointEntity,
    private readonly physics: PhysicsRuntime,
  ) {}

  /** 设置目标（通过话题接收） */
  setTarget(command: JointCommand): void {
    const rapierJoint = this.physics.joints.get(this.joint.id)!;

    switch (command.mode) {
      case 'position':
        // 位置模式：使用关节电机达到目标位置
        rapierJoint.configureMotorPosition(
          command.target,
          this.joint.motor!.maxForce,
          this.joint.motor!.maxVelocity,
        );
        break;

      case 'velocity':
        // 速度模式：使用关节电机达到目标速度
        rapierJoint.configureMotorVelocity(command.target, this.joint.motor!.maxForce);
        break;

      case 'torque':
        // 力矩模式：直接施加力矩
        const bodyB = this.physics.bodies.get(this.joint.bodyB)!;
        const torqueVec = Vec3d.scale(this.joint.axis, command.target);
        bodyB.applyTorqueImpulse(torqueVec, true);
        break;
    }
  }

  /** 获取当前关节状态 */
  getState(): JointState {
    const rapierJoint = this.physics.joints.get(this.joint.id)!;

    return {
      position:
        this.joint.jointType === 'prismatic'
          ? rapierJoint.limitsEnabled()
            ? rapierJoint.limitsMin()
            : 0
          : 0, // Rapier 暂不直接提供旋转角度，需要通过刚体姿态计算
      velocity: 0, // 同上
      force: rapierJoint.impulse, // 约束力
    };
  }
}

export interface JointState {
  readonly position: number; // 当前位置/角度
  readonly velocity: number; // 当前速度/角速度
  readonly force: number; // 约束力/力矩
}
```

### 5.2 装配体系统

```typescript
/** 装配体管理器 */
export class AssemblyManager {
  private readonly assemblies = new Map<string, Assembly>();

  /** 创建装配体 */
  createAssembly(entity: AssemblyEntity): Assembly {
    const assembly = new Assembly(entity, this.physics);
    this.assemblies.set(entity.id, assembly);
    return assembly;
  }

  /** 获取装配体 */
  getAssembly(id: string): Assembly | undefined {
    return this.assemblies.get(id);
  }
}

/** 装配体实例 */
export class Assembly {
  private readonly parts = new Map<string, SceneEntity>();
  private readonly joints = new Map<string, JointController>();

  constructor(
    private readonly entity: AssemblyEntity,
    private readonly physics: PhysicsRuntime,
  ) {
    this.buildHierarchy();
  }

  private buildHierarchy(): void {
    // 递归创建子实体
    for (const child of this.entity.children) {
      this.parts.set(child.id, child);

      if (child.type === 'joint') {
        const controller = new JointController(child as JointEntity, this.physics);
        this.joints.set(child.id, controller);
      }
    }
  }

  /** 设置关节目标（批量） */
  setJointTargets(commands: Record<string, JointCommand>): void {
    for (const [jointId, command] of Object.entries(commands)) {
      this.joints.get(jointId)?.setTarget(command);
    }
  }

  /** 获取装配体整体状态 */
  getState(): AssemblyState {
    const partStates = new Map<string, BodyState>();
    for (const [id] of this.parts) {
      partStates.set(id, this.physics.getBodyState(id));
    }

    const jointStates = new Map<string, JointState>();
    for (const [id, controller] of this.joints) {
      jointStates.set(id, controller.getState());
    }

    return { parts: partStates, joints: jointStates };
  }
}

export interface AssemblyState {
  readonly parts: Map<string, BodyState>;
  readonly joints: Map<string, JointState>;
}
```

---

## 6. 亚克力板建模系统

### 6.1 设计理念

亚克力板建模系统模拟真实的激光切割工艺，让用户可以像在现实中一样设计机器人零件：

1. 在 2D 平面绘制轮廓（支持打孔）
2. 设置板材厚度
3. 自动生成 3D 模型和物理属性

### 6.2 典型应用场景

**机器人底板（使用预设材质）**：

```typescript
{
  type: 'model',
  geometry: {
    type: 'acrylic',
    definition: {
      contour: {
        type: 'compound',
        contours: [
          // 外轮廓：200mm × 150mm 矩形
          { type: 'rect', width: 200, height: 150 },
          // 四个角的安装孔：直径 5mm
          { type: 'circle', radius: 2.5, center: { x: -90, y: -65 } },
          { type: 'circle', radius: 2.5, center: { x: 90, y: -65 } },
          { type: 'circle', radius: 2.5, center: { x: -90, y: 65 } },
          { type: 'circle', radius: 2.5, center: { x: 90, y: 65 } }
        ]
      },
      thickness: 3,
      material: 'acrylic',  // 使用标准亚克力预设
      color: '#4080ff'      // 覆盖颜色
    }
  },
  physics: {
    bodyType: 'dynamic'
    // mass 自动计算：(200×150 - 4×π×2.5²) mm² × 3mm × 1.18 g/cm³ ≈ 106g
  },
  material: {
    friction: 0.5,  // 继承自预设
    restitution: 0.3
  },
  collider: { type: 'convex-hull', source: 'geometry' }
}
```

**循迹赛道（白色亚克力 + 黑线纹理）**：

```typescript
{
  type: 'model',
  geometry: {
    type: 'acrylic',
    definition: {
      contour: { type: 'rect', width: 500, height: 2000 },
      thickness: 3,
      material: 'acrylic',
      texture: 'assets/track-black-line.png'  // 黑色循迹线图案
    }
  },
  physics: { bodyType: 'static' },
  material: {
    friction: 0.8,
    restitution: 0.1
  },
  collider: { type: 'box', size: { x: 500, y: 3, z: 2000 } }
}
```

**支架臂（特殊密度材料）**：

```typescript
{
  type: 'model',
  geometry: {
    type: 'acrylic',
    definition: {
      contour: {
        type: 'svg',
        path: 'M 0,0 L 100,0 L 100,10 L 10,10 L 10,50 L 0,50 Z'
      },
      thickness: 5,
      material: 'pc-board',  // PC板预设
      density: 1.5,          // 覆盖：使用加强版材料
      color: '#ff8040'
    }
  },
  physics: { bodyType: 'dynamic' },
  collider: { type: 'trimesh', source: 'geometry' }
}
```

**半透明装饰板**：

```typescript
{
  type: 'model',
  geometry: {
    type: 'acrylic',
    definition: {
      contour: { type: 'circle', radius: 50 },
      thickness: 2,
      material: 'acrylic-colored',
      color: '#00ff88',
      opacity: 0.7,  // 覆盖透明度
      texture: 'assets/logo.png'
    }
  },
  physics: { bodyType: 'static' }
}
```

### 6.3 编辑器功能

**2D 轮廓编辑器**：

- 绘制工具：
  - 矩形工具（拖拽绘制）
  - 圆形工具（中心 + 半径）
  - 多边形工具（点击顶点）
  - 自由曲线（贝塞尔曲线）
- 导入功能：
  - SVG 文件导入（Illustrator/Inkscape 输出）
  - DXF 文件导入（CAD 常用格式）
  - 图片轮廓提取（自动描边）
- 编辑操作：
  - 节点编辑（移动、添加、删除顶点）
  - 布尔运算（合并、减去、相交）
  - 倒角、圆角
  - 阵列复制（安装孔）
- 辅助功能：
  - 网格对齐、吸附
  - 尺寸标注
  - 质量预览（实时显示重量）
  - 质心显示

**3D 预览**：

- 实时挤出预览
- 厚度调整滑块
- 材质颜色选择器
- 透明度调整
- 纹理上传和预览

**物理参数面板**：

- 材质预设选择器（下拉菜单）
  - 内置预设：标准亚克力、PC板、木板、铝板、钢板等
  - 自定义预设（场景级别）
- 高级选项（展开面板）：
  - 密度微调（覆盖预设）
  - 摩擦系数
  - 弹性系数
- 自动计算质量和惯性
- 碰撞体生成选项（凸包/精确网格）

### 6.4 实现技术

**轮廓三角化**（2D → 3D）：

- 使用 Earcut 算法进行 2D 多边形三角化
- 支持打孔（洞多边形）
- 处理 SVG path → 多边形转换

**几何挤出**：

- Three.js `ExtrudeGeometry`（渲染用）
- 自定义三角网格生成（物理碰撞用）
- 生成侧面、顶面、底面

**物理属性计算**：

```typescript
function calculateAcrylicMass(contour: AcrylicContour, thickness: number, density: number): number {
  const area = calculateArea(contour); // 平方毫米
  const volume = area * thickness; // 立方毫米
  const volumeCm3 = volume / 1000; // 立方厘米
  return volumeCm3 * density; // 克
}
```

**碰撞体生成**：

- 凸包：用 QuickHull 算法生成凸包（性能好）
- 精确网格：直接用三角化结果（精确但慢）

---

## 7. 编辑器集成

### 7.1 3D 场景编辑器

```typescript
/** 3D 场景编辑器会话 */
export interface Scene3DEditorSession {
  /** 加载场景 */
  loadScene(doc: Scene3DDocument): void;

  /** 添加实体 */
  addEntity(entity: SceneEntity): void;

  /** 更新实体 */
  updateEntity(id: string, changes: Partial<SceneEntity>): void;

  /** 删除实体 */
  removeEntity(id: string): void;

  /** 选择实体 */
  selectEntity(id: string): void;

  /** Three.js 渲染器 */
  readonly renderer: THREE.WebGLRenderer;

  /** 相机控制 */
  readonly controls: OrbitControls;

  /** Transform gizmo */
  readonly gizmo: TransformControls;
}
```

### 7.2 预制件库

提供常用场景元素的预制件：

```typescript
/** 预制件类型 */
export type PresetType =
  | 'maze-wall' // 迷宫墙壁
  | 'ramp' // 坡道
  | 'stairs' // 楼梯
  | 'track-straight' // 直线赛道
  | 'track-curve' // 弯道赛道
  | 'track-cross' // 十字路口
  | 'ball' // 球
  | 'box' // 方块
  | 'cylinder' // 圆柱
  | 'robot-2wd' // 两轮机器人
  | 'robot-4wd' // 四轮机器人
  | 'robot-arm'; // 机械臂

/** 预制件定义 */
export interface PresetDefinition {
  readonly id: PresetType;
  readonly displayName: string;
  readonly category: 'static' | 'dynamic' | 'robot';

  /** 创建实体 */
  create(options?: Record<string, unknown>): SceneEntity | AssemblyEntity;
}

/** 预制件库 */
export const PRESET_LIBRARY: Record<PresetType, PresetDefinition> = {
  'maze-wall': {
    id: 'maze-wall',
    displayName: '迷宫墙壁',
    category: 'static',
    create: (opts) => ({
      id: generateId(),
      type: 'static',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      geometry: {
        type: 'box',
        size: { x: opts?.width ?? 2, y: 1, z: 0.1 },
      },
      material: {
        color: '#808080',
        friction: 0.5,
        restitution: 0.3,
      },
      collider: {
        type: 'box',
        size: { x: opts?.width ?? 2, y: 1, z: 0.1 },
      },
    }),
  },

  'track-straight': {
    id: 'track-straight',
    displayName: '直线赛道',
    category: 'static',
    create: (opts) => ({
      id: generateId(),
      type: 'static',
      position: Vec3d.zero,
      rotation: Quaternion.identity,
      geometry: {
        type: 'plane',
        size: { x: opts?.width ?? 0.5, y: opts?.length ?? 2 },
      },
      material: {
        texture: opts?.trackImage ?? 'builtin://track/straight-black-line',
        friction: 0.8,
        restitution: 0.1,
      },
      collider: {
        type: 'box',
        size: { x: opts?.width ?? 0.5, y: 0.01, z: opts?.length ?? 2 },
      },
    }),
  },

  'robot-2wd': {
    id: 'robot-2wd',
    displayName: '两轮机器人',
    category: 'robot',
    create: (opts) => ({
      id: generateId(),
      type: 'assembly',
      position: { x: 0, y: 0.1, z: 0 },
      rotation: Quaternion.identity,
      children: [
        // 车身
        {
          id: generateId(),
          type: 'dynamic',
          position: Vec3d.zero,
          rotation: Quaternion.identity,
          geometry: { type: 'box', size: { x: 0.15, y: 0.05, z: 0.2 } },
          material: { color: '#4080ff', friction: 0.5, restitution: 0.3 },
          collider: { type: 'box', size: { x: 0.15, y: 0.05, z: 0.2 } },
          mass: 0.5,
        },
        // 左轮
        {
          id: 'wheel-left',
          type: 'dynamic',
          position: { x: -0.1, y: 0, z: 0 },
          rotation: Quaternion.fromEuler(0, 0, Math.PI / 2),
          geometry: { type: 'cylinder', radius: 0.04, height: 0.02 },
          material: { color: '#202020', friction: 1.0, restitution: 0.2 },
          collider: { type: 'cylinder', radius: 0.04, height: 0.02 },
          mass: 0.05,
        },
        // 右轮
        {
          id: 'wheel-right',
          type: 'dynamic',
          position: { x: 0.1, y: 0, z: 0 },
          rotation: Quaternion.fromEuler(0, 0, Math.PI / 2),
          geometry: { type: 'cylinder', radius: 0.04, height: 0.02 },
          material: { color: '#202020', friction: 1.0, restitution: 0.2 },
          collider: { type: 'cylinder', radius: 0.04, height: 0.02 },
          mass: 0.05,
        },
        // 左轮关节
        {
          id: 'joint-left',
          type: 'joint',
          jointType: 'revolute',
          position: Vec3d.zero,
          rotation: Quaternion.identity,
          bodyA: 'body',
          bodyB: 'wheel-left',
          anchorA: { x: -0.1, y: 0, z: 0 },
          anchorB: Vec3d.zero,
          axis: { x: 1, y: 0, z: 0 },
          motor: { maxForce: 1.0, maxVelocity: 10 },
          symbol: opts?.leftMotorSymbol ?? 'motor-left',
        },
        // 右轮关节
        {
          id: 'joint-right',
          type: 'joint',
          jointType: 'revolute',
          position: Vec3d.zero,
          rotation: Quaternion.identity,
          bodyA: 'body',
          bodyB: 'wheel-right',
          anchorA: { x: 0.1, y: 0, z: 0 },
          anchorB: Vec3d.zero,
          axis: { x: 1, y: 0, z: 0 },
          motor: { maxForce: 1.0, maxVelocity: 10 },
          symbol: opts?.rightMotorSymbol ?? 'motor-right',
        },
      ],
    }),
  },
};
```

---

## 8. 功能清单

### 8.1 场景建模

- ✅ 基础形状（盒子、球、圆柱、胶囊、平面）
- ✅ 标准 3D 模型（STL、GLB、GLTF、OBJ）
- ✅ 亚克力板建模（2D 轮廓 + 厚度挤出）
- ✅ 地形（高度图）

### 8.2 静态场景

- ✅ 墙壁、迷宫
- ✅ 坡道、楼梯
- ✅ 地面循迹图像（平面 + 纹理）

### 8.3 动态物体

- ✅ 可碰撞物体
- ✅ 质量、摩擦、弹性配置
- ✅ 运动约束（锁定轴向）
- ✅ 自动质量计算（亚克力板）

### 8.4 关节系统

- ✅ 旋转关节（revolute）
- ✅ 平移关节（prismatic）
- ✅ 球形关节（spherical）
- ✅ 固定连接（fixed）
- ✅ 关节限位
- ✅ 电机控制（位置/速度/力矩模式）
- ✅ 通过话题接收指令
- ✅ 反馈关节状态

### 8.5 装配体

- ✅ 多物体组装
- ✅ 关节连接物体
- ✅ 装配体整体控制
- ✅ 预制机器人模型

### 8.6 传感器

### Phase 1：基础架构（2-3 周）

1. 创建 `@mica-js/scene-3d` 包
2. 定义 `.scene3d` 文档格式
3. 集成 MuJoCo WASM
4. 实现基础模型系统（ModelEntity + PhysicsConfig）
5. 实现 `Scene3DRuntime` 与时间同步

### Phase 2：亚克力板建模（1-2 周）

1. 实现 2D 轮廓数据结构（SVG path、多边形等）
2. 几何挤出算法（Earcut 三角化）
3. 物理属性自动计算（质量、惯性）
4. Three.js 渲染支持
5. 碰撞体生成（凸包/精确网格）

### Phase 3：关节与装配体（1-2 周）

1. 实现关节系统（revolute、prismatic）
2. 话题集成（接收指令、发布状态）
3. 实现装配体系统
4. 创建预制机器人模型

### Phase 4：传感器系统（2-3 周）

1. 实现传感器基类
2. 实现基础传感器（距离、颜色、IMU、GPS）
3. 实现摄像头传感器（离屏渲染）
4. 实现其他传感器（光照、声音等）

### Phase 5：编辑器（2-3 周）

1. 创建 `@mica-js/scene-editor` 包
2. Three.js 视口与相机控制
3. 2D 轮廓编辑器（亚克力板）
4. SVG/DXF 导入功能
5. Gizmo 与实体操作
6. 预制件库与拖放
7. 属性面板

### Phase 6：集成与优化（1-2 周）

1. Playground 示例场景
2. 性能优化（物理步长、LOD）
3. 文档与测试
4. 与 2D Widget 共存测试

---

## 10. 技术栈

- **物理引擎**：MuJoCo (WASM)
- **渲染引擎**：Three.js
- **几何处理**：Earcut（三角化）、QuickHull（凸包）
- **文档格式**：JSON（`.scene3d`）
- **2D 轮廓**：SVG path + 多边形
- **类型系统**：TypeScript
- **传感器仿真**：MuJoCo 内置 + 自研（基于 Three.js）

---

## 11. 示例场景

### 11.1 循迹机器人

```json
{
  "version": 1,
  "schematic": "examples/line-follower.sch",
  "world": {
    "gravity": { "x": 0, "y": -9.81, "z": 0 },
    "physicsStep": 16.67,
    "ground": {
      "enabled": true,
      "texture": "assets/track-black-line.png",
      "friction": 0.8,
      "restitution": 0.1
    }
  },
  "entities": [
    {
      "id": "robot",
      "type": "assembly",
      "position": { "x": 0, "y": 0.1, "z": 0 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "children": ["..."]
    },
    {
      "id": "color-sensor",
      "type": "sensor",
      "sensorType": "color",
      "position": { "x": 0, "y": 0.02, "z": 0.15 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "config": {
        "type": "color",
        "sampleRadius": 0.01,
        "updateRate": 50
      },
      "symbol": "color-sensor",
      "mountedOn": "robot"
    }
  ],
  "environment": {
    "ambientLight": { "color": "#ffffff", "intensity": 0.5 },
    "directionalLight": {
      "color": "#ffffff",
      "intensity": 0.8,
      "position": { "x": 5, "y": 10, "z": 5 }
    }
  }
}
```

### 11.2 迷宫探索

```json
{
  "version": 1,
  "schematic": "examples/maze-robot.sch",
  "world": {
    "gravity": { "x": 0, "y": -9.81, "z": 0 },
    "physicsStep": 16.67
  },
  "entities": [
    {
      "id": "maze",
      "type": "static",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "geometry": { "type": "mesh", "url": "assets/maze.glb" },
      "material": { "color": "#808080", "friction": 0.5, "restitution": 0.3 },
      "collider": { "type": "trimesh", "geometry": "assets/maze.glb" }
    },
    {
      "id": "robot",
      "type": "assembly",
      "position": { "x": 0, "y": 0.1, "z": 0 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "children": ["..."]
    },
    {
      "id": "distance-sensor-front",
      "type": "sensor",
      "sensorType": "distance",
      "position": { "x": 0, "y": 0.05, "z": 0.15 },
      "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 },
      "config": {
        "type": "distance",
        "maxRange": 2.0,
        "fov": 15,
        "updateRate": 20
      },
      "symbol": "ultrasonic-front",
      "mountedOn": "robot"
    }
  ],
  "environment": {
    "ambientLight": { "color": "#ffffff", "intensity": 0.6 }
  }
}
```

---

## 13. 补充说明

### 13.1 坐标系统约定

**世界坐标系**：

- 右手坐标系：X 轴向右，Y 轴向上，Z 轴向前
- 单位：米 (m)
- 原点：场景中心或用户指定位置

**局部坐标系**：

- 每个实体有自己的局部坐标系
- 子实体的位置和旋转相对于父实体
- 关节锚点在各自刚体的局部坐标系中定义

**坐标系适配**：

- MuJoCo 使用 Z 轴向上的坐标系
- 需要在物理引擎适配层进行转换
- Three.js 渲染与世界坐标系一致

**角度约定**：

- 文档中存储：**弧度 (rad)**
- 编辑器 UI 显示：**度 (°)**
- 四元数用于旋转表示

### 13.2 单位约定

**长度**：

- `.scene3d` 文档：**米 (m)**
- 亚克力板编辑器 UI：**毫米 (mm)**
  - 用户输入 200mm，存储为 0.2m
  - 符合激光切割机的常用单位
- 物理仿真内部：**米 (m)**

**质量**：

- `.scene3d` 文档：**千克 (kg)**
- 亚克力板密度：**克/立方厘米 (g/cm³)**
  - 标准亚克力 1.18 g/cm³
  - 计算时自动转换单位

**时间**：

- 虚拟时间：**皮秒 (ps)**，与电气仿真统一
- 物理步长配置：**毫秒 (ms)**
- 传感器更新频率：**赫兹 (Hz)**

**角速度**：

- 陀螺仪输出：**弧度/秒 (rad/s)**
- 关节速度控制：**弧度/秒 (rad/s)** 或 **米/秒 (m/s)**

**力和力矩**：

- 力：**牛顿 (N)**
- 力矩：**牛顿·米 (N·m)**

### 13.3 碰撞事件系统

**碰撞事件定义**：

```typescript
export interface CollisionEvent {
  /** 碰撞的两个实体 ID */
  readonly entityA: string;
  readonly entityB: string;

  /** 接触点（世界坐标） */
  readonly contactPoint: Vec3d;

  /** 接触法向量（从 A 指向 B） */
  readonly normal: Vec3d;

  /** 碰撞冲量 (N·s) */
  readonly impulse: number;

  /** 虚拟时间 */
  readonly time: TimePs;
}

// Scene3DRuntime 提供碰撞订阅
interface Scene3DRuntime {
  // ...

  /** 订阅碰撞事件 */
  onCollision(callback: (event: CollisionEvent) => void): Unsubscribe;

  /** 订阅特定实体的碰撞 */
  onEntityCollision(entityId: string, callback: (event: CollisionEvent) => void): Unsubscribe;
}
```

**应用场景**：

- 触摸传感器：检测接触力超过阈值
- 遮挡传感器：检测物体进入/离开区域
- 碰撞声音：根据冲量大小播放音效
- 得分触发：机器人触碰目标区域

### 13.4 调试可视化

编辑器提供的调试工具：

**碰撞体可视化**：

- 线框模式显示碰撞体
- 与渲染几何体对比（检查配置错误）
- 颜色区分：静态（灰色）、动态（绿色）、休眠（蓝色）

**关节可视化**：

- 轴向箭头（显示旋转轴或平移方向）
- 锚点位置（小球标记）
- 关节限位范围（扇形或线段）
- 当前状态（位置、速度、受力）

**传感器可视化**：

- 距离传感器：半透明锥形（显示检测范围和 FOV）
- 摄像头：视锥体线框
- 颜色传感器：地面采样点高亮
- IMU/GPS：坐标轴小工具

**物理调试**：

- 质心位置（十字标记）
- 惯性主轴（椭球体）
- 受力箭头（实时显示力和力矩）
- 速度向量（显示线速度和角速度）

### 13.5 错误处理与诊断

**场景验证**：

```typescript
export interface SceneValidationReport {
  readonly valid: boolean;
  readonly errors: SceneError[];
  readonly warnings: SceneWarning[];
}

export interface SceneError {
  readonly code: string;
  readonly message: string;
  readonly entityId?: string;
  readonly severity: 'error' | 'warning';
}

// 常见错误类型
export type SceneErrorCode =
  | 'invalid-contour' // 轮廓自相交或无效
  | 'triangulation-failed' // 三角化失败
  | 'joint-body-mismatch' // 关节连接的刚体不存在
  | 'mass-not-positive' // 质量必须为正数
  | 'collider-geometry-mismatch' // 碰撞体与几何体不匹配
  | 'sensor-mount-invalid' // 传感器挂载目标不存在
  | 'material-not-found' // 材质预设不存在
  | 'model-load-failed'; // 3D 模型加载失败

// Scene3DRuntime 提供诊断接口
interface Scene3DRuntime {
  // ...

  /** 验证场景配置 */
  validateScene(): SceneValidationReport;

  /** 获取实时诊断信息 */
  getDiagnostics(): Scene3DDiagnostics;
}

export interface Scene3DDiagnostics {
  /** 物理仿真统计 */
  readonly physicsStats: {
    readonly stepTime: number; // 最近一步耗时 (ms)
    readonly bodyCount: number; // 刚体数量
    readonly activeBodyCount: number; // 活跃刚体数量
    readonly contactCount: number; // 接触点数量
  };

  /** 传感器统计 */
  readonly sensorStats: {
    readonly totalSensors: number;
    readonly updateRate: number; // 平均更新频率 (Hz)
  };
}
```

**错误恢复策略**：

- 亚克力板轮廓无效：回退到矩形
- 模型加载失败：使用占位符（粉色盒子）
- 物理仿真爆炸：重置场景到初始状态
- 关节配置错误：跳过该关节，记录警告

### 13.6 性能优化策略

**空间分区**：

- MuJoCo 内置空间分区，无需手动优化
- 大场景可考虑分区加载（视距剔除）

**物理休眠**：

- 静止物体自动休眠（MuJoCo 自动管理）
- 可配置休眠阈值（速度、时间）

**渲染优化**：

- LOD（细节层次）：远处物体使用简化模型
- 视锥剔除：Three.js 自动处理
- 实例化渲染：相同几何体批量绘制

**传感器优化**：

- 摄像头：降低分辨率（远距离传感器 320×240）
- 距离传感器：合批 Raycast（相同方向的传感器）
- 颜色传感器：缓存地面纹理采样

**编辑器优化**：

- 仿真模式 vs 编辑模式：编辑时降低物理精度
- 延迟加载：大模型在视口可见时再加载
- Web Worker：物理计算和渲染分离（MuJoCo WASM 已支持）

---

## 14. 总结

## 14. 总结

该方案在保持现有架构确定性、分层复用原则的基础上，通过新增 `@mica-js/scene-3d` 和 `@mica-js/scene-editor` 两个包，实现了完整的 3D 物理仿真能力：

1. **统一的模型系统**：静态和动态物体都是 ModelEntity，只是 `bodyType` 不同
2. **多种几何类型**：基础形状、标准 3D 模型（STL/GLB/GLTF/OBJ）、亚克力板建模
3. **亚克力板建模**：2D 轮廓编辑 + 厚度挤出，材质预设系统，自动计算物理属性，适合教学场景
4. **关节系统**：支持旋转和平移关节，通过话题控制，反馈状态
5. **装配体**：多物体通过关节组装，支持复杂机器人
6. **传感器**：10 种传感器类型，覆盖视觉、测距、运动、环境、接触等
7. **完善的错误处理**：场景验证、诊断信息、错误恢复
8. **调试可视化**：碰撞体、关节、传感器、受力等可视化工具
9. **明确的单位约定**：米、千克、弧度，编辑器 UI 显示用户友好单位

该设计与现有 2D Widget 模式平行，共享同一仿真内核，可独立使用或共存。物理引擎使用 MuJoCo WASM，专为机器人仿真优化。
