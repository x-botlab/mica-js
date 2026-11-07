---
'@mica-js/scene-3d': minor
---

新增场景运行时与锁步时间同步（#182）：

- `Scene3DRuntime`：`step(deltaMs)` 按固定顺序推进传感器采集、电路仿真器、关节指令与物理引擎；所有子系统到达同一目标时间后才提交 `currentTime`，保证确定性回放。
- `TimeMs` 毫秒虚拟时间类型、`RuntimeOptions`（注入 `physics`、设置起始 `startTime`）与 `JointCommand` 指令形状；`currentTime` / `getCurrentTime()` 读取当前时间。
- 传感器采集（#192）与电路仿真器推进（#214）暂时为空实现；`step` 抛错时时钟停留在上一个完整同步的时间点。
