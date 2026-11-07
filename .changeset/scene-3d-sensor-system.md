---
'@mica-js/scene-3d': minor
---

新增传感器系统架构（#192）：

- `entities/`：新增 `SENSOR_TYPES`、`SensorType` 与 10 种传感器的 `SensorConfig` 判别联合（camera、distance、color、imu、gps、light、sound、magnetic、occlusion、touch）；`SensorEntity` 增加 `sensorType`、`config` 与可选的 `mountedOn`。
- `sensors/`：新增 `SensorData` 输出联合类型、`Sensor` 抽象基类与 `MockSensor`。基类以 picoseconds（`TimePs`）虚拟时钟控制采样频率，`tryUpdate()` 在未到采样间隔时返回 `null`，并按 `mountedOn` 组合父实体世界位姿与局部偏移。
- `SensorRegistry` / `sensorRegistry`：按 `sensorType` 注册并创建传感器工厂；未注册或创建失败的传感器由宿主告警后跳过，不阻塞场景。
- `Scene3DHost`：初始化与 `addEntity` 时创建传感器；`step()` 第 6 阶段采样到期传感器，通过 `sensorData` 通知推送到所属装配体的电路沙箱。传感器更新或通知失败只记录日志，不中断当前帧。
- `Scene3DHostOptions.assemblyFor`：注入装配体定义加载器，使宿主能为 `.assembly.json` 中声明的传感器创建运行时；未提供时只创建场景顶层传感器。
- `CircuitSandboxHandle.notify`：新增可选的单向通知能力，宿主用它发送 `CircuitSensorData` 负载。
- 测试：`sensors/base.test.ts` 覆盖采样频率、默认 30 Hz、失败重试与世界位姿组合；`sensors/registry.test.ts` 覆盖注册表生命周期；`runtime/host.test.ts` 覆盖装配体传感器推送、时钟换算、顶层传感器增删以及错误隔离。
