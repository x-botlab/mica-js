# @mica-js/simulator

在虚拟时钟上运行电路与原理图器件。`@mica-js/simulator` 提供统一 IR 的 `Circuit`，以及用于原理图集成的 `DeviceSimulationHost`；`@mica-js/simulator/sandbox` 提供沙箱宿主接入。本包不内建任何具体器件模型，器件定义由调用方提供。

## 电气作者接口（接入中）

内部准备函数 `prepareElectricalDevice(definition, properties, factory)` 校验 JSON 的引脚、二端电阻和理想触点声明，解析实例属性，并执行配对同步工厂。准备函数及其编译中间结果暂不从包入口公开；器件作者可使用公开的工厂上下文和初始化参数类型。工厂通过 `ctx.electrical.initializeResistor` 和 `initializePin` 显式提供初始值。属性和已验证的电气数据是独立的递归只读快照；工厂结束后禁止继续初始化。

普通电阻仍有配对 JS，只是不需要每 tick 行为。完整 JSON / JS 示例见 [器件定义](../../docs/rfc/0005-device-definition.md)。

编译器内部的[资源链接器](./src/unified-ir/compiler/electrical-network.ts)已将这些初始化结果映射为电阻、参考电压源、GPIO 驱动、独立上下拉及双向触点。只合并导线端点，不合并电阻两端；未初始化采样或驱动能力的被动引脚仍保留。

[线性求解内核](./src/unified-ir/compiler/resistive-solver.ts)在同一 IR 模块中生成行缩放、选主元 LU 与前后代入，不调用宿主 JS 数值求解器。固定理想电压节点隔开未知节点组；全部有限支路（含暂时禁用的支路）参与保守分组，未变组保留分解和解。源电压变化仅更新受影响组的解；理想触点变化或源使能变化重新分组。单节点组绕过 LU；只有一个潜在未知节点且其余节点均被理想源固定时使用直接装配，源关闭时退回通用求解。受控失效入口仍分别更新拓扑、矩阵与右端项版本，稳定求解直接命中缓存。浮空有独立状态；源冲突和数值失败保留上一份完整发布快照，冗余理想源的电流标记为不确定。参考解释器与 JIT 的分压、电桥、触点、上下拉、极端数值及批量采样已有对照测试，RFC 的电阻 JSON/JS 示例也经过链接和实际求解。

[器件操作](./src/unified-ir/compiler/electrical-operations.ts)通过现有 `DeviceBehaviorApi` 提供独立输出使能、数字与模拟输出意图、开漏、独立上下拉、数字输入解释和原子数字／电阻／触点补丁。输出未就绪时保持释放；浮空数字输入读低，滞回记忆按每次成功求解更新。kernel 可用 `bind(builder)` 取得相同操作，新电气路径禁止直接读写旧电气数组，器件私有状态仍可正常使用。

内部器件生成器与主循环已接入这些操作：初始化和 update 后解析，电气故障暂停后续阶段，失败不发布部分电气快照。主循环单独记录完整 tick 数；`Circuit` 的批处理时钟也只推进已完成的前缀，即使后续 tick 发生 IR trap。

公共 `compileCircuit`、`Circuit` 和原理图加载已接入配对工厂描述：将 JSON 字段与配对 JS 的默认导出组合为 `DeviceDescription` 的 `factory`，通过实例 `properties` 提供覆盖值。每实例工厂只执行一次；reset 恢复初值并重新解析，不重新调用工厂。普通电阻无需 tick。调用方必须显式提供仿真级 `interpretation` 和所引用的 `sources`；仅 `GND` 固定为 0 V，不隐式创建 VDD/VCC。

`Circuit.getVoltage('R1.B')` 读取物理电压，`getCurrent('R1.body')` 读取已声明电阻从第一端到第二端的电流；结果区分 `determinate`、`floating` 和 `indeterminate`，只有确定值包含 `value`。`getPin` 要求输入能力；新模型拒绝 `setPin` / `writePin` 直接覆盖电气数组，运行期调阻经普通器件状态与 typed IR 提交。

原理图工厂把每个 symbol 的实例属性交给配对工厂。Host/guest 的本地启动选项可指定 `electrical`；`DeviceSimulationHost`、RPC 方法和报告 DTO 保持不变，`executed` 和时间按实际完成 tick 计算。RFC 电阻 JSON/JS 的两实例分压器已覆盖真实原理图解析、reference/JIT、单步/批处理、故障暂停和 reset。

Playground 的 LED、教学 MCU、按钮和继电器已迁移为同目录 JSON/JS：元数据加载不执行 JS，worker 通过现有文件服务读取配对工厂。示例显式使用 5 V 的 VDD/VCC、MCU 的 50 Ω 高低输出电阻以及 0.3/0.7 比例输入门限。LED 仅观察，不模拟二极管负载；按钮触点双向且机械闭合与供电无关；继电器的两组触点原子换向，不复制电平。去抖参数来自实例属性。

新增 `demo:potentiometer`：`position` 输入和 `actualPosition` 输出均为 [0, 1] 的 number。输入先经已有 `deliver` 队列，在下一 tick 写普通状态，再通过一次 IR `applyResistors` 原子调整上下两支路。number 输出将浮点状态转换为 JS number，通用 `DeviceAccessor.getState` 仍保留 FloatBits。阻值为 `endResistance + trackResistance * (1-position)` 与 `endResistance + trackResistance * position`；正端点电阻是显式属性，不是隐藏 epsilon。默认轨道 10000 Ω、每端 10 Ω、位置 0.5；真实负载会影响滑端电压。topic 回读的是位置，不是伪造的模拟电压；物理电压仍由本地 `Circuit.getVoltage` 观察。

输入能力的 `sampleVoltage()` 返回确定节点的实际电压；浮空时按 RFC 的 `mica-floating-v2` 算法采样，不向物理解算添加噪声、隐式接地或泄漏。仅为 IR 中实际调用模拟采样的引脚生成辅助函数和阶段状态，重复读取共享同一份；即使首次读取尚未发生，也按成功求解记录浮空阶段。纯数字引脚不生成这些辅助状态；没有模拟读取的电路不执行模拟时钟更新。`floatingSeed` 默认为 0；同一浮空阶段、参考电压与时间下重复读取逐位一致，供电未就绪时返回正零，恢复后按既有阶段继续。`step(dt = 1)` / `runBatch(count, dt = 1)` 的 dt 单位为 ps，必须是正安全整数；内部时钟只推进成功完成的 tick，按 2^53 ps 回绕，reset 恢复初始时钟和浮空阶段。现有宿主使用其原有 tick 时长，不改变 RPC。

`getCurrent` 还接受 `{ kind: 'contact', device, name }`、`{ kind: 'source', name }`，以及 `{ kind: 'drive' | 'pull-up' | 'pull-down', device, pin }`。触点沿声明的第一端到第二端为正；源、输出驱动和偏置以向网络供电为正。闭合理想触点存在环流自由度或两侧理想源分担不唯一时返回 `indeterminate`；无源浮空纯电阻网络的有限支路电流确定为零，不与节点电压浮空混淆。

`getDiagnostics()` 返回最后发布快照的只读活动诊断：声明电阻／引脚驱动的过流按资源唯一列出，恢复后消失，过流本身不暂停；参数错误、理想源冲突与数值失败锁存故障，reset 清除。它不是事件流或历史记录，batch 内出现后消失的过流不保留，目前也不提供完整故障资源溯源。没有增加电气 RPC 或诊断 DTO。

其余旧夹具与执行路径尚未全部清理；暂存的旧执行路径不作为最终兼容模式，新旧模型混合明确拒绝。分组与单节点路径已实现，但通用路径仍有稠密存储、全局装配／残差和电流快照发布成本，尚非完整稀疏求解器；完整诊断上下文仍待完成。[性能文档](./docs/PERFORMANCE.md)包含稳定、RHS 更新、调阻和触点变化的真实 Circuit 基准；算术微基准不能替代端到端数据。

```sh
pnpm --filter @mica-js/simulator exec vitest run --config vitest.electrical.config.ts
```
