---
'@mica-js/simulator': minor
---

新增 RFC 0002 §4.5 浮空采样算法 `mica-floating-v2`，统一 IR 的浮空网络不再恒读低电平，而是按拓扑种子与仿真时间确定性采样：

- `runtime/floating.ts`：`sampleFloating(netId, simTimePs, seed)` 是纯函数——FNV-1a 折叠芯片种子、网络号与 64 位时间，再经 `mixFloatingHash` 雪崩后取最低位；`hashTopology(parts)` 生成与拓扑相关的种子。同一时间永远得到同一电平，`reset()` 后逐拍重放完全一致；时间推进则走出伪随机序列。
- 编译器新增 `compiler/floating.ts`：`planFloating(module, netlist)` 判定浮空网络（无强驱动、无 rail），从规范化网表算出种子，并只在确有浮空网络时才分配 `floating_clock`（两字 `u32`，单位 ps）。没有浮空网络的电路内存布局与生成指令逐条不变。
- `emitNetLevel` 在浮空网络上内联采样：无驱动、无 rail、无上/下拉偏置时取采样值；上拉恒高、下拉恒低、强驱动优先，`t = 0`（复位点）保持确定的低电平。`solve_net_<id>` 只在计划的浮空网络上走这条分支，其余网络沿用原有指令序列。
- `MainLoopGenerator` 每拍末推进 `floating_clock`（每次 `TICK_PS`，低位溢出即进位到高位），tick 与 batch 路径因此逐拍一致。`Circuit` 新增只读 `floatingSeed` 暴露拓扑种子；`CompiledCircuit.floating` 暴露种子、采样网络与时钟。
- 测试：`runtime/floating.test.ts` 覆盖纯函数确定性、时间序列、64 位时间高低位、拓扑敏感种子、IR 与参考函数逐拍一致、`reset()` 复现、tick/batch 等价，以及上拉/下拉/强驱动优先于采样。
