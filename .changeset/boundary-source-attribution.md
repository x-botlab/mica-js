---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
---

Direct JIT 在指令边界按调用点动态发布观察写入：写屏障拆分为入口拦截与运行期发布，支持 immediate 块原地检查点，条件跳转与尾部延时共享续跑出口，减少可观察写入的重复发布。

新增 opt-in 边界归因诊断：`boundary()` 记录调用点来源（`jitSignal`/`polling`/`process`/`checkpointPublish`/`checkpointFinish` 等），通过 `Symbol.for('mica-js.simulator/checkpoints')` 读取只读计数器，默认关闭、不影响正式运行。
