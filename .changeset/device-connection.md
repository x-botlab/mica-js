---
'@mica-js/device': minor
'@mica-js/ir': minor
'@mica-js/core': minor
---

实现连接作者接口与 IR 接入（#57）：器件描述解析 #14 连接声明；`api.ir.connection(id)` 与 `b.connection.apply([{ connection, closed }])` 把建图时固定的对象列表降低为 `static-list` 连接引用与等长 bool SSA 列表；通过 `DeviceInstanceOptions.connections.topology` 绑定 core topology，在合法控制阶段以一份原子 patch 提交，支持普通/生命周期/嵌套块、SSA 按值捕获、稳定同刻顺序、未知/跨实例/非法 patch 诊断，以及冲突后不回滚已提交拓扑。IR 增加通用领域指令列表操作数与可信同步 `IRInstructionExecutor`，core `createIRSchedulerInstance` 可传入执行器。
