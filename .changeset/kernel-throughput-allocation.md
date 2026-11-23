---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
---

缩短高频总线场景的仿真耗时：电气脏集、时间事件堆与观测派发改为零分配形式，无挂起点的进程体控制流不再拆成机器块，停泊 JIT 只在其依赖实际变化时重扫。并口摄像头负载的稳态帧耗时约降到原来的 45%（`camera-mcu`，RTF 1.8x → 3.7x）。

`ResumableProgram` 新增只读 `blocks`，报告该 body 编译出的机器块数；过程探针新增 `programs: [{ key, blocks }]`，既有字段名不变。
