---
'@mica-js/compiler': minor
'@mica-js/simulator': minor
---

缩短高频总线场景的仿真耗时：电气脏集、时间事件堆与观测派发改为零分配形式，无挂起点的进程体控制流不再拆成机器块，停泊 JIT 只在其依赖实际变化时重扫。并口摄像头负载的稳态帧耗时约降到原来的 45%（`camera-mcu`，RTF 1.8x → 3.7x）。

- `ResumableProgram` 新增只读 `blocks`，报告该 body 编译出的机器块数；过程探针新增 `programs: [{ key, blocks }]`，既有字段名不变。
- `DeviceContext` 新增可选 `attachBus`，用于声明有界传输端点（`spi` / `parallel-sync`）。未调用它的器件行为完全不变；`transfer` 返回 `false` 表示调用方必须退回逐引脚路径。

新增 `gray-camera`（160×120 灰度摄像头，DCMI+DMA）与 `spi-screen`（320×240 RGB565 SPI）两个基准。传输端点为原型：`transfer` 目前只在 `phase === 'idle'` 可用，由宿主在推进窗口之间调用，器件执行期内的调用与 `precise` 对照尚未实现。
