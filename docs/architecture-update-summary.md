# 3D 场景模式架构更新总结

**日期**: 2026-10-24
**相关 Checkpoint**: 002-architecture-refinement.md

## 主要更新

基于与用户的讨论，对 3D 场景模式架构进行了重大细化和调整。

## 1. 装配体与原理图绑定模型

### 决策

**装配体定义直接绑定原理图**，场景实例化时创建独立仿真器。

### 文件结构

```
robot-car.assembly.json     # 装配体定义（可复用模板）
  ├─ schematic: "robot-car.sch"
  └─ entities: [模型, 关节, 传感器]

race-track.scene3d          # 场景文档
  ├─ schematic: "scene-ambient.sch"  (可选)
  └─ entities: [
       AssemblyInstance("robot-car"),  # 实例1 → 独立仿真器1
       AssemblyInstance("robot-car"),  # 实例2 → 独立仿真器2
     ]
```

### 工作原理

- 装配体定义 = 可复用的机器人模板
- 每个装配体定义绑定一个原理图文件
- 场景中每个装配体实例创建独立的电路仿真器（sandbox）
- 场景本身也可以有原理图（用于非装配体实体）

## 2. 多仿真器运行时架构

### 架构图

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

### 关键特性

- **隔离性**：每个电路仿真独立 sandbox，防止相互干扰
- **并行性**：仿真器可并发执行
- **安全性**：用户代码 bug 只影响单个装配体
- **复用性**：利用现有 `@mica-js/sandbox` 基础设施

## 3. 时间同步策略

### 决策

采用**锁步同步（Lockstep）**。

### 执行流程

```typescript
async step(deltaMs: number): Promise<void> {
  const targetTime = this.currentTime + deltaMs * 1_000_000;

  // 1. 采集所有传感器数据
  const sensorData = this.collectSensorData();

  // 2. 并行推进所有电路仿真，等待全部完成（锁步）
  await Promise.all(
    simulators.map(async (sim, id) => {
      this.publishSensorData(sim, sensorData.get(id));
      await sim.advance(targetTime);
    })
  );

  // 3. 收集所有电路的控制指令
  const commands = this.collectCommands();

  // 4. 应用到物理引擎
  this.applyCommands(commands);

  // 5. 推进物理仿真
  this.physics.step(deltaMs);

  this.currentTime = targetTime;
}
```

### 优势

- ✅ 确定性：所有仿真器在同一时刻
- ✅ 简单：时间同步逻辑清晰
- ✅ 可调试：易于追踪问题

### 权衡

- ❌ 最慢的仿真器会拖慢整体帧率
- 未来可优化：添加超时机制（混合策略）

## 4. 物理引擎确认

### 决策

使用 **MuJoCo**（而非 Rapier3D）。

### 理由

- ✅ 专为机器人仿真设计
- ✅ 原生支持复杂关节系统
- ✅ 内置传感器模型（IMU、力传感器等）
- ✅ JavaScript/WASM 包可用（`mujoco_wasm`）
- ✅ 确定性物理计算

## 5. 实体话题绑定模型

### 旧模型（已废弃）

```typescript
interface SceneEntity {
  readonly symbol?: string; // ❌ 绑定整个实体到一个器件
}
```

### 新模型

```typescript
// 关节：多端口绑定
interface JointEntity extends SceneEntity {
  readonly bindings?: {
    // 端口绑定（key=端口名，如 "torque", "position"）
    readonly [portKey: string]: {
      readonly symbol: string; // 原理图符号 ID
      readonly port: string; // 符号端口名
    };
  };
}

// 传感器：多端口绑定
interface SensorEntity extends SceneEntity {
  readonly bindings?: {
    // 端口绑定（key=端口名，如 "intensity"）
    readonly [portKey: string]: {
      readonly symbol: string;
      readonly port: string;
    };
  };
}

// 装配体：引用定义，不绑定符号
interface AssemblyInstance extends SceneEntity {
  readonly type: 'assembly';
  readonly assembly: string; // 引用装配体定义
}
```

### 对比 2D Widget 模式

- **2D Widget**：`CanvasWidgetInstance.bindings: Record<port, CanvasBindingTarget>`
- **3D 关节/传感器**：`bindings?: Record<portKey, BindingTarget>`
- **统一模式**：都是端口名作 key，值为 `{symbol, port}`

## 6. 文档和 Issue 更新

### 文档更新

- [docs/3d-scene-mode-design.md](D:/mica-js.worktrees/3d-2d-widget-3d-3d-gps/docs/3d-scene-mode-design.md)
  - 新增 section 2.2.2：装配体定义格式
  - 更新 section 2.3：实体系统（移除 symbol 字段）
  - 更新 section 2.4：MuJoCo 物理引擎
  - 更新 section 3.3：多仿真器运行时架构与锁步同步

### GitHub Issues 更新/创建

| Issue                                                  | 操作      | 说明                                          |
| ------------------------------------------------------ | --------- | --------------------------------------------- |
| [#179](https://github.com/x-botlab/mica-js/issues/179) | ✏️ 更新   | 反映绑定架构变更（bindings 字段统一端口绑定） |
| [#180](https://github.com/x-botlab/mica-js/issues/180) | ✅ 已存在 | MuJoCo 集成（已正确）                         |
| [#213](https://github.com/x-botlab/mica-js/issues/213) | ✨ 新建   | 定义装配体定义文件格式                        |
| [#214](https://github.com/x-botlab/mica-js/issues/214) | ✨ 新建   | 实现多仿真器运行时架构                        |

### Issue 追踪

- [docs/3d-scene-issues.md](D:/mica-js.worktrees/3d-2d-widget-3d-3d-gps/docs/3d-scene-issues.md)
  - Phase 1 从 6 个任务增加到 8 个任务
  - 总任务数从 36 个增加到 38 个
  - 添加架构更新说明

## 下一步

1. **更新 Phase 1 类型定义**（issue #179）：
   - 移除 `SceneEntity.symbol`
   - 添加 `JointEntity.bindings`、`SensorEntity.bindings`（统一端口绑定格式）
   - 创建 `AssemblyDefinition` 和 `AssemblyInstance` 类型

2. **实现装配体定义格式**（issue #213）：
   - 定义 `.assembly.json` schema
   - 支持装配体-原理图绑定
   - 支持实体间相对绑定

3. **继续 Phase 1 实现**：
   - Task 4 (#180): MuJoCo 集成
   - Task 5 (#181): Scene3DRuntime 核心
   - Task 6 (#182): 时间同步机制
   - Task 7 (#213): 装配体定义格式
   - Task 8 (#214): 多仿真器运行时

## 总结

这次架构细化明确了：

- ✅ 装配体如何绑定原理图
- ✅ 多仿真器如何组织和运行
- ✅ 时间如何同步（锁步）
- ✅ 实体如何绑定话题（binding 结构）
- ✅ 物理引擎选择（MuJoCo）

设计现在更加清晰和可执行，可以继续 Phase 1 的实施工作。
