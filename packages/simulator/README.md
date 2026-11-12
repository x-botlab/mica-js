# @mica-js/simulator

基于[器件仿真规范](../../docs/spec/index.rst)的同步运行时。DDL、TypeScript Builder 和动态生成块使用共享器件模型与 JS 编译后端。根入口保持 DOM 无关，调用方决定运行位置；浏览器可选 sandbox 入口提供编辑器使用的隔离适配。

## 入口

- `@mica-js/simulator`：`createDeviceLibrary`、`createBoard`、`SimulationError` 和宿主类型。
- `@mica-js/simulator/device`：器件工厂、context、通道、批次、字节视图和 JIT 接口。
- `@mica-js/simulator/model`：共享 IR、Builder 与校验器。
- `@mica-js/simulator/ddl`：Langium DDL 编译工具；根入口不加载解析器。
- `@mica-js/simulator/sandbox`：预备仿真的默认 guest 与 worker 适配器。

```typescript
import { createDeviceLibrary, createBoard } from '@mica-js/simulator';
import { compileDDL } from '@mica-js/simulator/ddl';

const model = await compileDDL('device Timer { process start { await ticks(10); } }');
const library = createDeviceLibrary([
  {
    id: 'example/Timer',
    model,
    create() {
      return { sync() {}, dispose() {} };
    },
  },
]);
const board = createBoard(library, {
  instances: [{ id: 'timer', type: 'example/Timer' }],
  nets: [],
});
board.runUntil(100);
board.dispose();
```

`createBoard` 同步完成全板校验、创建期求值、资源建立和工厂初始化。首次 `runUntil` 才求解初始电气状态并启动模型。时间为整数皮秒；成功推进后通过每个器件的 `sync(batch)` 交付输出。故障后保留现场，恢复方式为销毁并重新创建板。

memory 使用独立字节区，输入和输出遵守快照、FIFO 与批次规则。执行器使用稳定事件队列；state、memory 与 sample 按资源版本记录实际读取依赖，只有脏观察源参与下一轮稳定比较。直接 state/sample 观察建立一次固定订阅，已发布 sample 复用不可变快照；快照对标量直接返回，state 中的 bytes 仍逐次捕获内容。derived 缓存和 waitUntil 谓词沿纯函数调用跟踪依赖，分支改变时只增删变化的订阅。所有观察基线仍先更新，全部反应捕获成功后才执行任何反应体。

首次推进建立板级传播计划：电气引脚直接绑定版本/订阅资源槽，静态观察读取器与反应入口绑定到稳定执行槽，反应代码按需编译后复用。来自不同器件的激活任务进入稀疏位集，按稳定实例/声明槽顺序取出，仅对活跃字排序，复用轮次缓冲；derived 的实际读取分支变化仍增删资源槽订阅。这是跨器件传播路径特化的第一步，减少通用查找、逐观察排序和临时集合分配；逐位时序、普通队列、电气求解和全板捕获屏障保持原合同。

板级传播计划的范围是第 3 轮实际实现的部分，集中在电气叶形状与发布寻址。derived 求值、观察比较与接收过程此后各自做了专用代码生成（第 4 轮的生成式观察链、第 5 轮的过程可恢复执行块），但它们与电气求解之间仍各自保有独立的调度边界，尚未合成一条完整的跨器件执行序列。具体地，意图写入只把板序引脚槽号放进脏集，发布把脏槽直接交给 `solveSlots`，返回的变更槽按槽号查已预绑定的 sample 资源槽并按下标发布，不再经过引脚对象映射，也不依赖脏集迭代顺序。网络侧把每个引脚已证明的单支路形状预计算成可复用计划（目标引脚、阻值、目标节点、支路对象），整批脏引脚命中已准入计划时直接复放：跳过 `requirePin`/`requireEndpoint` 查找、支路数组重建、形状判定、入射度数同步函数调用与比较器排序，只校验意图仍为同一条支路、引脚节点仍是未知叶、旧目标仍是固定参考、目标分量仍只有一个固定电位。任一条件不成立、引脚未被准入、或同一引脚出现第三种形状时整批回退通用求解，通用求解成功后按成功批次准入新形状（失败不推进缓存、不改统计）；叶批次仍先算出全部样本、整批写入后提交意图/支路/度数，再把块划分标记为陈旧，因此全板原子发布和失败语义不变。变更槽用就地插入保持升序（等价于旧的按引脚槽比较器排序结果），已发布样本按 `(voltage, level)` 复用同一份冻结对象，样本内容与不可变性不变，重复 `Object.freeze` 与临时分配消除。

引脚 intent 构造按引脚名与阻值两级缓存（最多 64 个名字 × 每名字 8 个阻值，超过上限整层清空，不做 LRU），热路径不再拼接键字符串，也不保证跨清空的同一 identity；样本观察在依赖集合成员未变化时跳过订阅增删，动态源求值不再为每次发布构造闭包与结果包装对象，正时长等待的唤醒续体按进程绑定一次复用（同一进程最多一个挂起的定时唤醒）。

引脚意图变化才触发边界电气求解。物理连通分量用于浮空判定、统计与故障归属；求解时以固定电位为边界，仅沿未知节点之间的电阻连接划分计算块。大型网络不会因共享理想电源或地而扩大矩阵，真实电阻桥仍合并未知节点计算块；参考电位相同的分量沿用常电位求解，最多 32 个未知节点且彼此无电阻连接的微型系统保留单个小矩阵，避免分块管理开销。仅电阻值变化时重新计算受影响块。精确拓扑的历史缓存最多占用 8 槽，首次出现只保留描述，第二次成功出现才准入图；命中时复用等值图，电阻变化只复制受影响块，失败不推进缓存准入或 LRU。独立未知节点的计算块使用对角分解与回代；冷拓扑划分按节点顺序建立块，避免中间分组集合与重复排序。

引脚只有一条支路、该支路在新旧两侧的另一端都是固定参考节点（引脚只在电源与地参考之间切换）、该网络入射支路总数为一条（同网络的其它引脚都不再贡献支路）、且目标分量的固定电位只有一个值时，切换不需要重建拓扑：未知节点集合与未知-未知连接不变，旧分量仍持有自己的固定节点、新分量仍持有自己的固定节点，分量数与浮空分量数都不变，节点电压就是该分量唯一的固定电位，与常电位分量的求解结果逐位相同。该路径只写入受影响的节点电压、样本、意图快照与入射度数，全部计算成功后才发布，然后把块划分标记为陈旧；下一次需要通用求解时，从当前支路重建划分、描述缓存与数值缓存。旧支路曾连到未知节点、目标分量含多个不同固定电位、任一入射支路连到未知节点、入射支路不是一条或参数非法时回退到通用求解；弱连接不会被当成开路，也不按电阻值推断。分量账本在首次本地更新前复制，已准入的拓扑快照始终保留自己的内容。该形状在成功求解后按引脚准入传播计划，后续同一形状的切换直接复放，见上节。

对于未知节点仅连接固定参考、每节点具有一至两条支路的小型区域，按方程形状生成专用 JS 组装程序，保留原补偿求和顺序，减少逐节点临时数组。相同形状在不同节点之间共享代码，复用前校验节点绑定及支路位置，避免独立分量数量超过缓存容量时反复编译。每网络最多保留 8 份程序，单份最多 32 个未知节点、128 条支路；形状变化时重新分析，一般耦合网络继续使用通用组装。现有分解、回代、有限性和必要系数检查共用。遵循电气规范，允许浮点舍入误差，运行期不再逐节点遍历原方程残差。

运行时记录片段内实际赋值的引脚，求解器据此更新缓存而非每边界扫描全板意图；独立求解调用省略提示时仍比较所有意图身份。意图数组及分支遵守不可变值合同。未变化块复用配置与分解，未变化采样复用已冻结对象；全部必要块求解成功后才原子发布全板新采样。一般耦合块的稠密后端对含 U 个未知节点的计算块使用 O(U²) 空间和 O(U³) 分解时间；大型单一计算块仍应通过基准评估。

引脚 intent 构造与写入复用不可变值：同一实例的同一 (pin, resistance) 在缓存命中时返回同一份已冻结 `resistor` 结果（两级缓存，最多 64 个引脚名、每个名字最多 8 个阻值，超过上限整层清空重建，不保证跨清空的同一 identity），重复赋同一个 intent 值不进入脏集，因此未变化的引脚不触发额外支路或样本重算。采样读取、state 写入和内存读写按名称缓存已解析的资源槽、字节区与视图，命中时只做一次名称查找，避免重复解析与多重查找；动态源观察在两条依赖缓冲之间交替使用，派生值复用其依赖缓冲，逐边界不再新建依赖表，订阅仍按本轮实际读取增删。等待与恢复路径以赋值代替删除属性，避免进程记录退化为字典模式；发布、观察批次与等待 JIT 扫描按索引遍历，空订阅的资源版本推进不再构造迭代器。

JIT 在翻译并校验整个块后，将各 PC 直接绑定到已编译的指令入口，保持稳定执行对象，避免逐次块内查找和临时属性增删。代码写入仍使入口缓存失效，已挂起的当前指令保留原恢复数据，完成后重新选择指令，不重放前缀。不存在等待订阅时跳过全体 JIT 等待检查；存在订阅时仍按注册顺序检查。

### MCU 执行模式

板默认使用 `execution: 'throughput'`，可切换 `execution: 'precise'`。`cpuQuantum` 为整数皮秒，范围 1 到 10,000,000，默认 10 μs；精确模式仍校验该值但不使用它。吞吐模式允许 CPU 观察、轮询退出和 IRQ 响应的额外延迟不超过该预算；固有的指令耗时、中断屏蔽和模型等待另计。外设、通信边沿、FIFO 和已锁存事件不按该预算合并。

吞吐模式将支持的缓存指令编译为紧凑 JS 执行循环，使用标量状态槽和原始 RAM 字节区，减少逐指令生成器、对象分配和通用派发。每段截止于下一普通事件或推进终点；资源屏障已排除中间可观察变化时，不因时间量子额外返回通用调度器。`cpuQuantum` 是额外可见性延迟的上界而非固定步长，当前实现保持精确事件期限，不故意引入延迟。直接执行目前只用于单 JIT 板上的标量运算、固定 RAM 区域（偏移可动态计算）、正固定耗时和分支；不支持的指令、观察者、中断条件依赖写入及代码写入形成逐指令屏障，其余指令继续直接执行。按守卫集合复用最多 8 份程序，代码失效时一起清除，避免 IRQ 分支切换导致重复编译。挂起后缀保留读取结果，实际写入用可复用脏位集提交；外部改码也不重放当前前缀。

直接执行守卫缓存资源的观察订阅版本：资源首次被观察或最后一个观察订阅移除时更新版本，动态观察分支切换和共享订阅遵守同一规则。订阅版本未变且中断条件没有新增实际读取依赖时，复用已有守卫集合，省去每次交接对全部状态与内存的扫描；普通资源值变化仍使用原有数据版本和通知机制。

批次交接跳过空输入队列的排空与清理，并在创建器件时预绑定输入清理、输出通道和输出通知的布局。完全空的输出复用该器件预建的冻结对象；首次出现消息或通知时才按原字段顺序复制布局并生成新快照，空输出通道复用冻结空数组。全部器件的批次仍在任何 `sync` 回调之前捕获，每个器件逐次收到新的冻结批次，所有输出字段、通知复位、非空消息快照与冻结合同保持不变；空输出对象及数组身份不保证逐批唯一。

`waitUntil` 保持按依赖唤醒的 WFI 等待。单 JIT 板上的无副作用自循环可自动证明并跳过重复执行，依赖变化后沿原循环相位恢复，不提前读到外部变化；多 JIT 保留原交错顺序。模型也可在 `attachJit` 声明 `polling: [{ pc, predicate }]`：吞吐模式在该 PC 开始前检查本实例无参 bool 纯函数，返回 false 时停在循环头等待实际依赖或中断条件变化，循环体不执行；返回 true 后正常执行。该声明是模型的等待语义承诺，精确模式忽略它并实际执行循环。参见[吞吐合同](../../docs/spec/jit/throughput.rst)。

旧 `Circuit`、`compileCircuit`、原理图宿主和 `/sandbox` 入口已移除；编辑器与 playground 的接入需迁移到新的库/板合同。

## 核心运行时内部结构

- `src/runtime.ts`：库与板装配、生命周期、话题、全板电气发布、观察轮与捕获屏障、普通过程续体和阶段调度。
- `src/runtime/instance.ts`：实例资源、执行 host、每实例惰性资源句柄、依赖跟踪、derived 缓存、批次及 JIT 绑定与代码失效。
- `src/runtime/jit.ts`：指令翻译、直接执行守卫、指令恢复与挂起；通过类型化板能力访问原有队列和边界，不另建调度器。
- `src/runtime/execution.ts`：共享编译缓存、过程帧及时间校验；`src/runtime/errors.ts`：同步钩子校验与诊断辅助；`src/runtime/state.ts`：内部状态类型。

这些模块均为内部实现，不增加公开入口。`electrical.ts`、`observations.ts`（观察代码生成）和 `queue.ts` 继续独立；全板发布与完整轮次捕获仍由板调度器集中控制。

## 编辑器预备运行时

`createSimulationRuntime()` 提供 `ISimulationRuntime`，接收调用方已准备的原理图、器件 JSON 元数据、自包含 JS 文本与按符号分组的资源字节。JS 使用 SDK 的 `model`、同步 `create` 具名导出；装载后通过 `createDeviceLibrary` / `createBoard` 建立运行实例。元数据用于符号、属性与端口校验，执行模型来自 SDK 编译后的共享器件模型。

- `load(input)` 在候选板准备成功后替换当前板；失败保留原运行状态。`reset()` 根据已加载输入重建初始状态。
- `deliver(message)` 将输入排到下一次 `tick(dt)`；整数皮秒步推进 Board，输出通过 `onDidPublish` 发布。省略端口 delivery 时沿用文档话题默认语义。
- 原理图属性覆盖元数据默认值，文件或内联资源引用由独立 `assets[symbolId][src]` 转为字节属性；运行时不读取文件或解析库。
- `onDidDiagnostic` 转发原生 Board 故障与端口诊断；故障板通过 `reset()` 或重新 `load()` 恢复。

浏览器由编辑器创建 `createSimulationRuntimeGuestSandbox({ container })`，再调用 `createSimulationRuntimeFromWorker(worker, { topicPort })`。适配器接管 worker 生命周期；只传递 MessagePort，复用 typed RPC 的 `simulation-runtime` 服务。器件模块仅在 guest 内求值，直连端口负责与 widget guest 双向通信。

## 验证

构建新模型、DDL、编译器和 simulator 包后，连接真实 adapter：

```powershell
$env:MICA_CONFORMANCE_ADAPTER = (Resolve-Path tests\conformance\adapter.mjs).Path
pnpm typecheck:implementation
pnpm test:conformance:strict
pnpm test:generated --require-adapter
pnpm test:generated:daily --require-adapter
```

`typecheck:implementation` 将已有 Builder/IR/host 类型场景的合同导入重定向到真实源码入口，不复制场景。运行时验收使用[符合性场景](../../tests/conformance/README.md)和[独立生成 oracle](../../tests/generated/README.md)。`pnpm --filter @mica-js/compiler test` 检查直接基本块后端；`pnpm --filter @mica-js/simulator test` 检查 MCU 基准、切片推进及其独立 oracle。编辑器预备运行时另通过 `pnpm --filter @mica-js/simulator test:runtime` 验证装载、资源、话题与 guest/RPC 生命周期。

## 基准

```powershell
pnpm --filter @mica-js/compiler bench
pnpm --filter @mica-js/simulator bench
pnpm --filter @mica-js/simulator bench:electrical
pnpm --filter @mica-js/simulator bench:propagation
```

运行时基准检查结果正确性，再报告两次预热、20 次采样的中位数及 P95/P99：跨最大时间范围的稀疏推进、100,000 个连续定时边界、1,000 个休眠实例、derived 与直接 state 的反应扇出及干净观察源、存储和通道快照。堆变化包含自动 GC，不代表峰值占用。

电气基准独立测量缓存复用、空脏引脚提示、参考变化、分量合并/拆分及共享电源下的支路隔离，并报告分解和缓存计数。额外的非计时 instrumentation 在 `cache_verification` 中记录拓扑、计算块、物理分组构建和拓扑恢复、对角分解次数，断言电阻更新不重建拓扑，以及参考切换恢复、32/33 节点路径切换、连接变化、失败重试和缓存发布的正确性；它不是公开 SDK 统计。`reference_assembly` 将专用组装与通用组装逐值对照，覆盖形状守卫、跨节点代码复用、8 槽上限、128 个独立区域及非有限结果/分解失败的原子重试。追加 `--verify-only` 可只运行这些断言，不采集性能。共享电源场景断言物理分量始终为 1，改变一条链时仅重新分解该链，另一条链命中缓存；分解与缓存计数以计算块为单位。测量不含 DDL、装配；方程程序按需生成，首次编译成本由首次运行或预热承担。编译器基准报告冷编译、稳态吞吐和生成代码大小。数值取决于 Node.js 版本、机器与工作负载，不作为通用性能保证。

### 跨器件传播基准

`bench:propagation` 使用真实 DDL/SDK，覆盖发送器、共享电气网络、多接收器及后续边界的中继传播；每组独立核对计数与校验和。使用 `--sizes=1,4,16,64 --samples=20 --warmup=2 --rounds=100` 可指定扇出、采样、预热及传播轮数。JSON 报告中位数、P95/P99 和聚合操作吞吐；它测量结构化传播路径，不代表整帧 UART 摘要或完整芯片速度。配合已有 UART 真实负载确认通用路径上的收益与回退。作为模块导入时不自动运行 CLI；导出的 `preparePropagation({ rounds, steps })` 返回准备好的工厂，`create(sdk, { size })` 为指定 SDK 创建独立场景，提供 `run()`、`verify()`、`dispose()`，可用于计时外准备、逐样本交替的双版本对照。

### MCU 连续执行基准

[MCU 基准](bench/mcu.mjs)通过真实公开 SDK/JIT 执行合成的 8 位累加器模型，不是 ARM/AVR 或其他具体芯片仿真器。三个持续负载分别为算术/分支循环、独立数据 RAM 读写，以及 GPIO 电气输出、模型定时器与中断服务程序；不使用 WAIT 或空闲跳时充当 CPU 性能。ADDI/XORI/LD/ST/OUT/IRET 各消耗两周期，JMP 一周期，中断入口额外两周期。默认每周期 10,000 ps，即模型标称 100 MHz，而非宣称能够实时仿真 100 MHz。

```powershell
pnpm --filter @mica-js/simulator bench:mcu
pnpm --filter @mica-js/simulator bench:mcu --workloads=alu-branch,ram,gpio-timer-irq --sizes=1,4,16 --samples=40 --warmup=5 --cycles-per-step=10000
node --test packages\simulator\bench\mcu.test.mjs
```

默认每组独立创建板，记录一次首次推进，再预热 3 批、测量 20 批，每批每颗 MCU 推进 10,000 周期。报告分开列出每颗 MCU 的等效实时 MHz、实时倍率、聚合周期吞吐、已开始指令吞吐和批次 P50/P95/P99。等效 MHz 使用单颗 MCU 的已流逝 CPU 周期与计时墙钟秒数计算，不把指令数当周期数，也不把多 MCU 的聚合吞吐当作单颗主频。末尾指令或中断入口尚未消耗的周期不计入进度；报告中的指令数是已开始数，不是完成数。MCU 在此模型中没有空闲间隙。

计时仅覆盖 `runUntil`，不包含建模、装配、预期计算、证据快照和事件循环让出。独立增量解释器在计时外核对 CPU/IRQ 状态、全部数据 RAM、定时器次数和 GPIO 采样，并核对已流逝周期等于已开始指令耗时加入口耗时、减去终点尚未消耗的部分。没有逐指令宿主计数、轨迹或状态观察反应。GPIO 验证是采样状态，不宣称覆盖全部边沿历史；多 MCU 使用同步起点和相同固件。预热不保证覆盖所有 JIT 路径，首次推进也不是新进程冷启动。

作为模块导入时不运行 CLI；`create(sdk, { workload, size, stepCycles, cyclePs, irqPeriodCycles })` 返回独立场景，提供 `step(cycles?)`、`verify()`、`progress`、`dispose()` 及共享的 `model`。相同模型/时钟/中断周期配置在不同 SDK 间复用同一 IR 对象，供 AB/BA 对照；`progress` 不推进板，`verify()` 触发同终点快照，在首次推进前调用会使冷启动观测失效。通过 `step` 推进，不直接调用场景内板的 `runUntil`。CLI 的总工作量包含首次推进、预热和测量；每板每颗 MCU 最多 500 万周期、整个矩阵聚合最多 5000 万周期，其余参数边界见 `--help`。短批次的百分位及 MHz 仍受宿主 GC、调度和 V8 状态影响，不作为真实芯片或稳定实时延迟保证。

### STM32G431 Thumb 固件基准

[STM32G431 基准](bench/stm32g431.mjs)使用原创裸机固件的真实 Thumb 字节，经取指、译码、Builder IR、公开 SDK/JIT 执行。模型包含 r0–r15、NZCV、IT、基本异常栈、PRIMASK、128 KiB Flash、32 KiB SRAM，以及 GPIOA、RCC GPIO 时钟、SysTick 和 SCB 中断控制。GPIO PA5 连接现有电气模型。覆盖的指令族与 MMIO 行为由相应译码器、总线测试固定，未知指令和地址产生诊断。该器件用于评估真实指令与外设交互的执行成本；DSP/FPU、完整芯片外设和硬件精确周期需要另行扩展。

```powershell
pnpm --filter @mica-js/simulator... build
pnpm --filter @mica-js/simulator test:mcu:stm32
pnpm --filter @mica-js/simulator bench:mcu:stm32 --smoke
pnpm --filter @mica-js/simulator bench:mcu:stm32 --workload=ram-copy --memory-access=wide
pnpm --filter @mica-js/simulator bench:mcu:stm32 --workload=mixed --execution=precise --cycles=10000 --samples=5
```

固件覆盖整数/条件分支、RAM 搬运、GPIO 翻转、SysTick 中断、混合执行和大循环压力；源码与已编译字节保存在 [firmware/](bench/stm32g431/firmware/)。运行基准使用仓库中的字节夹具，再生成固件使用 Clang/LLVM ARM 工具链。默认每周期 10,000 ps；简化周期表采用 ALU 1、访存 2、跳转成功 3、条件未成立 1、栈操作寄存器数加 1、异常进入与返回各 12 周期。由此得到的周期吞吐描述该模型的执行进度。

`stress` 固件的主循环展开 314 条不同 PC 的真实 Thumb 指令，单体生成时 `run` 达到十余万字节码偏移，适用于评估单函数体积、常量数组和 keyed access 的影响。direct 程序超过 128 条指令时，运行时会按 48 条一组生成 `stepShardN` 分片函数；小固件继续使用单体函数。真实 `stress` 中 `run` 现已进入 TurboFan，分片函数保持 Maglev；同机多次测量中位数约为 200ms → 175–190ms 量级（每轮 4 次 20k 周期采样，宿主调度仍有波动）。V8 层验证可单独运行：

```powershell
pnpm --filter @mica-js/simulator bench:mcu:stm32:v8 -- stress 200000
```

该工具以 `--trace-opt --trace-deopt` 在子进程中执行基准，按 `run`、`stepShardN`、`resumeShardN` 汇总进入的优化层、完成的编译和去优化原因及字节码偏移。基线（Node 24.18 / 随附 V8，20 万周期）显示 `run` 完成 TurboFan 编译，5 个 `stepShardN` 完成 Maglev；仍有 `Insufficient type feedback for generic keyed access` 和分片调用的反馈去优化，偏移随反馈时序变化。

每组报告单独列出装配、首次推进、预热后的稳态样本和固件 SHA-256。计时只覆盖 `runUntil`；独立 Thumb 参考机在计时外核对 CPU 状态、全部 SRAM、GPIO 输出写序列、PA5 电平、RCC/GPIO/SysTick/SCB 可见寄存器，并提供客体指令已开始数及异常进入次数。`guestMipsIssued` 使用样本内客体指令已开始数除以墙钟时间，硬件异常进入和模型服务过程不计为客体指令。译码时间采集发生在首次翻译回调中，属于推进耗时；参考机、快照和离线 IR 分析均在计时外。首次推进是新板冷启动，Node/V8 模块及共享模型可能已被前一组预热。

`profile` 报告已翻译 PC 的 IR 种类分布、每条指令的 direct 可编译性、生成函数字符数、局部槽、常量数组访问、布尔检查和 select 标签数；`excludedByKind`、`excludedTypes` 和 `excludedStateWrites` 汇总被排除指令包含的操作、类型和写屏障。该分析使用 IRQ hook 写屏障；静态可编译覆盖率与运行时回退率分别定义，报告中的覆盖率只表示前者。`bytes` 将宽访问生成逐字节 IR，`wide` 使用 canonical 宽访存 IR，供 #254 的后端支持对照；两种配置执行同一固件并检查相同结果。CLI 支持 `--workload`、`--execution`、`--memory-access`、`--samples`、`--cycles`、`--warmup`、`--cold-cycles`，每板累计最多 1,000 万周期。

### 典型 MCU 固件基准

`bench:mcu:typical` 使用单颗标称 100 MHz 的合成 MCU，覆盖 1%、10%、30% 有效计算和持续满载，分别采用 WFI 与显式轮询等待。定时 IRQ 为 1 kHz，GPIO 每 10 ms 切换；UART 保留真实 115200 baud 逐位电气传输、独立字节解码、16 字节 FIFO 和 IRQ 服务。

```powershell
pnpm --filter @mica-js/simulator bench:mcu:typical --duration-ms 31 --warmup-ms 11 --uart-period-ms 10
pnpm --filter @mica-js/simulator bench:mcu:typical --duration-ms 31 --warmup-ms 11 --uart-period-ms 1
pnpm --filter @mica-js/simulator bench:mcu:typical --duration-ms 11 --warmup-ms 1 --execution precise --waiting wfi --busy 10
```

默认每 1 ms 发送 11 字节，即约 11,000 B/s，接近线路饱和；`--uart-period-ms 10` 保持相同波特率，每 10 ms 发送同样的 11 字节，即约 1,100 B/s。两种线路负载分开报告，不把降低通信量当作运行时优化。宿主每 10 μs 交接 UART 接收结果，CPU 状态、全部工作 RAM、定时 IRQ、GPIO 与 UART 字节序列使用计时外的独立 oracle 核对，且每次交接单独检查 IRQ 响应上限。

此驱动包含固定 10 μs 宿主交接，即使外层 `step()` 推进 10–20 ms，内部也会调用多次 `runUntil`，因此只作为交接压力对照，不代表宿主每次直接推进 10–20 ms 的目标场景。两种接入方式的结果不可直接视为同一工作负载的运行时加速比。

主指标是 `realTimeFactor = 模拟秒数 / runUntil 墙钟秒数`；大于 1 表示该样本可实时推进。默认每组为 1 ms 首次推进加 9 ms 单次热样本，不输出伪百分位；上例前两条各测 20 ms 热样本。JSON Lines 保留首次推进、热样本、IRQ 响应、FIFO/丢字节证据，并把已发起有效计算周期、服务周期估计和剩余可等待周期区分开；后两者不是后端执行/跳过计数，终点可能有尚未完成的指令。不能将休眠期间的标称周期折算为实际计算 MHz，也不代表 ARM/AVR 的物理指令集性能。计时包含 SDK sync，排除装配、宿主交接与验证；需要应用端总耗时时应另计这些成本。通过 `create(sdk, options)` 注入 SDK，可复用同一模型做独立板对照。

### 并口摄像头与 DCMI/DMA 基准

[camera-mcu.mjs](bench/camera-mcu.mjs)推进一颗 44×64、8 位灰度、30 fps、1 MHz PCLK 的并口摄像头和一颗标称 100 MHz 的合成 MCU。摄像头通过 11 根真实电气引脚（VSYNC、HREF、PCLK、D0–D7）驱动总线：驱动电阻 25 Ω，采样阈值 0.8/2.0 V，每个像素由数据建立、PCLK 上升沿和下降沿组成。一帧包含 VSYNC 1 ms、64 行 × 505 μs（每行 44 μs 有效、461 μs 行消隐）和 13.333333 μs 场消隐，合计 33.333333333 ms（整数皮秒下为 30.0000000003 fps）。30 fps、44×64 和 1 MHz PCLK 只固定 33.333333333 ms 的帧周期与每帧 2.816 ms 的有效像素时间，剩余时间在行消隐和场消隐之间如何分配不受这三项约束。上述 1 ms VSYNC、505 μs 行周期（44 μs 有效 + 461 μs 行消隐）和 13.333333 μs 场消隐是选定的时序假设，不是唯一解；把更多时间移入场消隐等其他分配会改变空闲窗口与调度，因此本文性能结果只适用于该时序。

MCU 内建模 DCMI 采集与 DMA：普通模型过程在 PCLK 上升沿、HREF 有效且 VSYNC 无效时读取 8 位数据，等待固定 20 ns 后写入共享单缓冲 `raw` RAM；最后一像素完成后锁存帧 IRQ。JIT 固件逐像素读取 `raw`，把灰度 `< 100` 写为黑色 0、其余写为 1 到 `binary` RAM 并计数。采集、DMA 延迟、RAM 写入和二值化都不在宿主 JavaScript 中完成。

```powershell
pnpm --filter @mica-js/simulator bench:mcu:camera
pnpm --filter @mica-js/simulator bench:mcu:camera --samples 10 --warmup-frames 2
pnpm --filter @mica-js/simulator bench:mcu:camera --samples 5 --slice-ms 10
pnpm --filter @mica-js/simulator bench:mcu:camera --samples 5 --slice-ms 20
pnpm --filter @mica-js/simulator bench:mcu:camera --samples 1 --warmup-frames 0 --execution precise
node --test packages\simulator\bench\camera-mcu.test.mjs
```

默认依次计时 1 帧首次推进（包含惰性板/JIT/代码编译）、2 帧预热和 10 个连续整帧周期；每个热样本都是一个包含 VSYNC 与全部消隐的完整帧周期。`--slice-ms 10|20` 在每个帧周期内按宿主边界切分 `board.runUntil`（0 表示每帧一次），用于检查切片不改变结果。`--execution precise` 提供小样本对照；摄像头、DMA 和 RAM 时序在两种执行模式下相同。JSON 保留每个样本的墙钟时间、`realTimeFactor = 模拟秒 / runUntil 墙钟秒`、调用次数，以及首次、预热、热样本的统计和处理延迟。

每帧结束后、下一个 `runUntil` 之前，独立 oracle 在计时外核对全部 2816 个 `raw` 字节、全部 2816 个 `binary` 字节、黑色计数、最后一像素 DMA 时刻和固件结果发布时刻；oracle 使用与摄像头模型不同的像素分解。测试另行覆盖 99/100/101 阈值边界、整段与 10/20 ms 及不规则切片一致、`on` 过程在等待期间的边沿合并语义、20 ns DMA 前不可见、故意延长 DMA 等待导致丢像素并在下一个 VSYNC 故障、损坏 RAM 时 oracle 必然失败，以及 precise/throughput 结果一致。

[propagation-plan.test.mjs](bench/propagation-plan.test.mjs)直接驱动 `src/electrical.ts`（与电气基准相同的内存转译方式）与公开 SDK，锁定本轮的传播计划：单支路参考切换在成功求解后准入计划并被后续切换复放（`stats.leafPlans` / `leafPropagations` 增长），整批回退信号包括双支路耦合、未知节点目标与非法参数，耦合后发布的电压等于通用求解的分压结果；同一时刻的多个接收器共用一次捕获屏障（第二个捕获读到的仍是轮内旧值、前一体写入对后续体可见、普通 `on` 过程在闭包之后运行），一个反应捕获失败时本轮任何反应体都不执行，整段与切片推进的轨迹逐条相同。计划启用的证据是计数断言而不是耗时断言：把 `flushAdmissions` 改为空操作后“复放”用例立即失败；实际摄像头负载的计时外探针统计到每帧 5697 次求解全部由计划复放（0 次回退），该探针位于会话目录，不进入仓库与生产代码。

本轮传播计划的配对测量（同一进程内交替、两侧逐帧 oracle 校验、计时只用 `stepFrame().wallSeconds`）。所有比较都是同一进程内成对进行的基线（轮次开始时的 dist）对最终构建，但**不同行来自不同次运行、不同主机负载**，不能相加或混称同一次测量：

| 运行                               | 形态                         | 基线                  | 最终                  | 比值                              |
| ---------------------------------- | ---------------------------- | --------------------- | --------------------- | --------------------------------- |
| 逐帧配对，4 块 × 16 对（64 帧/侧） | 每对交换顺序，取逐对比值中位 | 50.45 ms              | 39.45 ms              | **1.267×**（P25 1.12 / P75 1.43） |
| 配对脚本 8 轮 × 8 帧，主机负载 17% | 每轮交换顺序                 | 35.51 ms（RTF 0.939） | 25.35 ms（RTF 1.315） | **1.400×**（逐轮 1.17–1.64）      |
| 配对脚本 8 轮 × 8 帧，主机负载 62% | 同上                         | 38.51 ms              | 32.73 ms              | 1.177×（逐轮 0.56–1.79）          |

三组测量的 `oracleMismatches` 与 `unverifiedFrames` 都是 0，逐帧 raw/binary 摘要、黑色计数、DMA/结果时刻与 `verify()` 摘要两侧完全一致。**测量机与其它 agent 共享**，负载 62% 的那一轮有明显争用（逐轮比值跨度 0.56–1.79），单次 RTF 不是稳定指标，逐对比值中位数在三种负载下都保持在 1.18 以上，因此以配对结果为准；本节的数值只适用于文中固定时序。

剖析（稳态 `runUntil`，抽样）：模型体约 15%、调度与等待恢复约 8%、观察与边界管线约 20%、电气求解与发布约 21%（其中计划复放 9%、批次校验 8%、计划匹配 2%、样本复用 2%）。收益集中在电气与发布路径；第 3 轮结束时观察源仍走通用路径：每次观察按名称解析资源、维护动态依赖集并检查 derived 缓存，观察比较与接收过程激活也按轮执行。第 4 轮把静态 derived 源改为生成式观察链，见下节。

主要简化与限制：`raw` 为单缓冲，DMA 写与 CPU 读不建模总线争用，依赖每帧 ISR 远短于帧周期（本负载标称约 169 μs）；模型在每帧第一像素、最后一像素和 VSYNC 断言不重叠，短帧在下一个 VSYNC 故障而不是计为成功。消隐期间不产生 PCLK（无 dummy clock），数据引脚保持上一像素值且不使用三态或双向总线。MCU 是固定代价像素 ISA，不是 ARM/Cortex-M，100 MHz 是模型标称周期而非硅片测量。计时只包含 `board.runUntil`（含 SDK sync 与电气求解）；装配、setup、逐帧 oracle 和最终零时快照不计时。独立 `on` 过程由 PCLK 两侧边沿触发，等待期间到达的新边沿只保留一次待运行标记。当前 20 ns DMA 等待小于 500 ns 的像素半周期，每个后续边沿到达前该过程都已结束，本时序下不会合并边沿；更长的等待会在边沿到来时仍在运行并被合并，一旦跨过多个像素上升沿就丢像素（测试以 3 μs 证明该语义）。因此“等待短于 1 μs”不是普适保证。

### 生成式观察链

[observations.ts](src/observations.ts) 把“一个静态 derived 源的全部接收者”编译成一份观察链。第 3 轮已有的通用 `compileComputation` 只产出求值函数；本轮为观察计划单独生成 reader 与 stable comparator，两者不共用语言 `==`：

- **专用 reader**：为每个源路径生成一个无参函数（`new Function` 只接收受信任模板与捕获数据）。资源在编译期解析为直接绑定：state 是预绑定的 `Map`、`pin.sample` 是预绑定引脚对象、memory 是预绑定的字节区与 `DataView`；derived 与无资源形参的 pure fn 递归内联为同一函数作用域内的嵌套函数，源路径末尾的字段投影也在此完成。因此稳态求值没有按名查找、`dependencyStack`、derived `Map` 缓存检查或逐轮依赖集差异维护——通用路径本来就把计算编译成 JS，这里省掉的是每轮的 host/资源名称解析、动态依赖跟踪与缓存检查。支持集合内的操作都会发射：常量、state/derived/sample/memory 读取（`memoryLength`、`load8/16le/16be/32le/32be`、`copyBytes`）、字段、索引、长度、bytes/record 构造、可空、算术/位运算、纯内置、`select`/`and`/`or`/`if`/`match`/`while`/`loop`/局部变量、`assert` 与值实参 pure fn 调用；短路与断言只在原路径执行，不跨分支预计算可能失败的子式。集合外（资源形参读取、非纯调用、`intent` 源、不可解析字段类型等）一律整份计划回退，不做部分支持。
- **专用 stable comparator**：按源静态类型生成。number 把 NaN 视为相同、正负零视为相同；bool/string/同一声明枚举按值；bytes 比较长度与内容；record 按声明的 `number`/`bool` 字段递归；sample 比较 `voltage`/`level`/`status`；可空先判 none。只有无法静态确认形状时才逐值退回通用 `same`，不以无差别 `same` 替代类型特化。
- **静态依赖槽**：编译期收集全部支路、内联 derived 与 pure fn、以及整块 memory/整个 sample 的资源槽。订阅按资源级保守覆盖，不随某次执行的分支缩小；依赖集合不变，因此没有逐轮 `Map` 合并。
- **激活与顺序**：每份观察链在既有 `ActivationQueue` 中占一个稳定槽位（同源后续接收者各占一个空槽位以保持无关观察的原始索引）。一次发布轮内链只求值一次，变化时把全部接收者按原声明顺序放入本轮变更表；变更表在全部读取完成后按注册顺序应用（普通过程入队、reaction 建立 previous/current 帧）。捕获屏障、全轮 capture 先于任何 body、body 失败保留前缀、捕获失败不执行任何 body 均沿用既有顺序。
- **derived 缓存**：链把本次原始值写回该 derived 的缓存项，并把静态依赖集的当前版本记入，使随后过程体内的 `readDerived` 命中缓存。写回只发生在根路径观察（`path` 长度为 1）；`pair.x` 这类字段投影只比较投影值，不写回根 derived 缓存。

准入与回退：只有根为 `derived` 的静态源路径参与；纯性、资源归属或依赖图无法静态确认时在执行前回退到原通用路径，包括资源形参（`pin`/`memory` 形参）、非纯调用、`now`/`random`/等待/发送、`intent` 源和不可解析的字段类型。回退不改变等待、错误或顺序，只保留原路径。观察链在首次推进建立基线时按已验证且不可变的 IR 一次性绑定，没有运行期再准入；运行期新增的接收者（当前 SDK 不提供该入口）仍各自使用通用观察，不会被漏掉。

诊断与证据：`board[Symbol.for('mica-js.simulator/observations')]()` 返回已生成链的路径、接收者数、槽位数、生成源码与比较器源码，以及回退原因；它是测试用诊断钩子，不是公开 SDK 契约。`observation-chains.test.mjs` 直接断言：number/record/bytes 三类真实 derived 都由生成 reader 与生成比较器驱动且输出序列正确；同一 derived 的两个接收者共用一条链，并与其它源保持声明顺序；**记录字段源（`pair.x`）严格投影后缀、发布标量 previous/current**，根记录与两个字段观察共存，未参与记录的 `z` 变化不触发，precise 与逐皮秒切片结果一致；`sampleValue.level` 与 `number?` 源使用各自的比较类型；`load8`（动态索引）、`load16le`/`load16be`（端序）与 `copyBytes` 由生成 reader 执行，越界读取保留 `Memory range is out of bounds` 的模型错误；`pure fn` 内的 `while` 循环与 `match` 分支同样由生成 reader 执行；资源形参源回退后事件序列与等价生成源逐条相同且回退原因是显式支持判定；生成 reader 内的 `assert` 失败按 `MODEL_EXECUTION_FAILED` 报出且此前 body 的公开 memory 标记保留；初始基线失败发生在启动过程之前。`runtime-observations.test.mjs` 另断言分支切换用例运行在一条接收者 2、静态槽位 3（两个分支）的生成链上。摄像头负载的两条真实链（`pclkHigh`、`vsyncHigh`）各 1 个接收者、1 个 sample 槽位，已由同一探针核对；`camera-mcu.test.mjs` 的逐帧 raw/binary/count/time oracle 在启用后仍然全通过。

限制：只覆盖 derived 根路径；state 根路径仍使用既有静态读取闭包，pin 通知与 input notification 不参与；生成函数只在本轮首次推进时建立，链本身不做运行期再编译或版本守卫；`intent` 不可作为变化源。

本轮的配对测量（同一进程内两版 SDK 逐帧交替、每对交换顺序，计时只用 `stepFrame().wallSeconds`，逐帧 oracle 在计时外）：

| 运行                                         | 形态                     | 旧构建                 | 新构建                 | 逐对比值中位（P25 / P75）   |
| -------------------------------------------- | ------------------------ | ---------------------- | ---------------------- | --------------------------- |
| 第 3 轮最终 dist → 本轮（96 对，4 块）       | 每块 3 预热 + 24 对      | 31.05 ms（RTF ≈ 1.07） | 27.51 ms（RTF ≈ 1.21） | **1.137×**（1.006 / 1.238） |
| 第 3 轮最终 dist → 本轮（128 对，4 块）      | 每块 3 预热 + 32 对      | 40.58 ms               | 33.46 ms               | **1.17×**（1.05 / 1.347）   |
| 闭环对照：本轮构建禁用观察链 → 本轮（64 对） | 同一构建只把准入强制回退 | 34.16 ms               | 30.11 ms               | **1.153×**（0.977 / 1.33）  |
| 同上，前一次 64 对                           | 同上                     | 39.79 ms               | 34.84 ms               | **1.208×**（1.086 / 1.289） |
| 投影修复后：第 3 轮最终 dist → 最终（96 对） | 每块 3 预热 + 24 对      | 43.43 ms               | 38.71 ms               | **1.109×**（1.005 / 1.291） |
| 投影修复后：闭环对照（64 对）                | 同一最终构建强制回退     | 32.19 ms               | 26.80 ms               | **1.206×**（1.103 / 1.327） |

所有运行的 `oracleMismatches` 与未逐帧校验帧数均为 0，逐帧 raw/binary 摘要、黑色计数、DMA/结果时刻与 `verify()` 摘要两侧完全一致。摄像头链都是根路径（`path` 长度 1），字段投影修复不改变摄像头的生成代码与行为，因此修复前后的测量可以并列。主机与其它 agent 共享：同一配置的逐对比值中位在 1.08–1.21 之间波动，单次 RTF 不是稳定指标；“禁用观察链”的闭环对照把收益限定在代码生成本身，而不是无关的构建差异。收益与剖析一致：摄像头每帧 5634 次观察求值（`pclkHigh`、`vsyncHigh`）从通用 derived 求值改为一次生成 reader 调用，逐轮依赖 `Map` 维护和 derived 缓存检查消失；每帧仍保留约 5634 次 `ActivationQueue` 出队与过程体执行。

剖析口径（稳态 `runUntil`，会话内临时计数插桩，只改会话副本、不进仓库）：旧构建的插桩把边界管线中约 19.6 ms/帧归到通用源读取（每帧 5634 次），另约 0.6 ms 在 `same`；同一相机负载的新构建只统计到约 1.6 ms/帧的生成链求值（含 derived 缓存写回）和约 0.4 ms 的入队。两次插桩的探针数不同且主机负载不同，绝对毫秒不可跨轮相减；两者一致的结论是每轮观察求值从“按名称解析资源 + 维护动态依赖 `Map` + 检查 derived 缓存 + 调用通用编译计算”变为一次绑定后的生成函数调用。

### 普通过程的可恢复执行块

[`@mica-js/compiler`](../compiler/README.md) 的 `compileResumableBody` 把**整个过程体**编译成一个普通函数：显式 `pc` + 复用的本地帧，替代原先“每次过程激活一个生成器、每次挂起 `yield { kind, duration }`、每次恢复分配迭代结果对象”的协议。准入发生在装配期：`Instance` 为每个 `start`/`on` 过程声明在构造过程表时就对该 `declaration.body` 调用一次 `resumable(...)` 并缓存结果（按 body 区域缓存，失败返回 `undefined`），`drive` 只读这个结果；命中的过程走 `driveResumable`，其余过程整体保留生成器路径。

- **准入是整份 body 的**：`if`/`match`/`while`/`loop`/`break`/`continue`/`return`/`returnValue` 与全部纯值操作都下沉为显式块转移；`wait`/`receive` 结束一个块并把 `pc`、活动槽与 `duration`/`channel` 写进帧。含 `call`/`callValue`（生成器委派）、`elapse`、`waitUntil`、`redirect`、`stop`、语句级 `yield`，或任一值区域含挂起的 body 一律返回 `undefined`，该过程**整体**留在生成器路径；不存在“先按块跑一段、再回通用路径”。
- **跨挂起语义不变**：只有分析给出的恢复点活跃槽在挂起时写入帧、恢复时读回，因此跨 `await ticks` 的局部变量保持旧值，而挂起后的 `read` 看到 current；`ticks(0)` 仍在片段末结束、由边界重新排队；`busy`/单 `pending` 非重入、同一时刻按声明顺序、片段末全板 sample 与 capture 先于任何 body、body 失败保留前缀并停后缀，都沿用 `boundary` 原顺序（本轮未改 `boundary`）。接收仍是非空不挂起、空才挂起，已接收局部跨批次保留。
- **诊断**：`board[Symbol.for('mica-js.simulator/processes')]()` 只读返回 `resumable` 与 `generic` 两份过程清单。摄像头负载实测 `camera/start`、`mcu/frameSync`、`mcu/dma`、`mcu/captureSnapshot` 四个过程全部准入，`generic` 为空；同一份 body 在会话内探针里以真实宿主桩驱动 6000 次挂起（69006 次 host 调用，含行边界）与生成器**逐操作一致**。
- **回归**：`process-resumable.test.mjs`（公开 SDK + DDL）覆盖准入与整份回退（含 `call` 的 body 仍在 `generic` 且输出不变）、跨挂起局部旧值/新读取、嵌套 `while`+`continue`+`match`+`break`、`ticks(0)` 同刻排队顺序、过程自我重触发只置 `pending`、空/非空 `receive` 与跨批次局部、断言失败保留公开 memory 前缀、`runUntil` 端点重复与到期；切片与 `precise` 输出逐条相同。另有一条参数化组合回归：6 个 `seed`/等待（0/1/2 ps）变体把嵌套循环 + `continue`、跨挂起的 bytes 与 number 局部、另一过程修改共享 state、reaction capture 组合起来，与“只多加一个无副作用 `noOp()` 调用、整份 body 回退”的同构模型逐条对照消息、仿真时间与 public RAM，并断言两者的准入清单。变异实验把恢复点活跃槽里的 `local:` 去掉后，其中 4 个用例立即失败。
- **收益（逐帧配对，计时只用 `stepFrame().wallSeconds`，逐帧 raw/binary/count/time oracle 在计时外）**：同一构建内把准入强制回退做闭环对照，五次独立运行分别为 **1.145×**（P25 1.029 / P75 1.357，40.53 → 31.24 ms，`ab-r5-resumable-ablation-final.json`）、**1.179×**（1.032 / 1.259，33.99 → 30.47 ms）、**1.108×**（1.044 / 1.174，27.36 → 23.69 ms）、**1.133×**（1.029 / 1.25，31.53 → 28.02 ms）与 **1.108×**（1.013 / 1.206，36.13 → 32.46 ms）；第 4 轮最终 dist → 本轮 4 块 × 16 对为 **1.185×**（P25 1.093 / P75 1.25，23.13 → 20.00 ms）与 **1.157×**（1.049 / 1.25，23.68 → 21.23 ms，`ab-r5-baseline-vs-final.json`），主机争用更强的另一次同配置为 1.063×（0.943 / 1.223）。闭环对照把收益限定在挂起协议本身，而不是无关构建差异。所有运行的逐帧 raw/binary 摘要、黑色计数、DMA/结果时刻与 `verify()` 摘要两侧完全一致。
- **限制**：只覆盖**过程**；reaction、`compileComputation`、JIT 指令路径仍用原协议。挂起次数、每次挂起的 `boundary`（电气发布 + 观察批次）与调度开销不变，因此这是**过程执行块**的收益，不是完整的跨器件融合——没有把电气求解、观察求值或跨器件序列并入同一次生成调用。

### 按实例资源绑定与电气发布快速路径

第 5 轮把过程体变成显式 `pc` 的普通函数后，过程体内的每个资源操作仍按“名字 → Map → 槽位”解析；电气发布也仍要先收集脏槽、再由通用求解器重新匹配叶计划。本轮做两件互不依赖的事：把固定资源名预绑定为**每实例句柄**，以及给已准入的叶批次一条**发布快速路径**并预绑定每个叶形状的提交载荷。

- **每实例资源绑定**：`compileResumableBody` 新增 `bindResources` 选项，`Instance` 实现 `ExecutionHost.bind(specs)`；生成的过程体在帧上第一次执行时调用一次 `host.bind([...])`，之后每个操作直接调用句柄方法（`state.read/write`、`pin.sample/intent/resistor`、`memory.load8/16le/16be/32le/32be`、`store*`、`length`、`copy`）。句柄缓存挂在 `Instance` 上，绑定表挂在每个过程的帧上，因此**同一份共享程序文本对每个实例各自绑定**，不会把一个实例的 RAM/pin/state 带进另一个实例。
- **语义逐条等价**：句柄方法就是通用 host 操作的复刻，名字解析保持惰性（非法名仍在同一操作处报错）；state 读取仍记录依赖槽与版本、写入仍先校验再 `snapshot` 再 `invalidate`；`pin.sample()` 每次返回**当前**已发布样本，绝不缓存一次样本快照；`intent` 仍对同一不可变 intent 直接返回、只把改变过的槽标脏；`resistor` 仍做 [0.001, 1e9] 校验并复用同一 intent 缓存；`store*` 仍做整数校验、边界检查与端序写入，并仍走 `memoryChangedSlot`——代码内存写入照旧 `cache.clear()`、递增 `revision`、清空 `directPrograms` 并作废 direct 程序。资源实参（`pin`/`memory` 形参）不绑定，仍走通用 `host.load/store/sample`。
- **预绑定叶计划载荷**：叶形状被通用路径证明并准入时，同时绑定该引脚的节点、节点上的引脚列表与每个引脚在该目标电压下的不可变样本；复放一次切换只比较当前样本对象身份（另加原有守卫：单支路、目标仍单参考、引脚节点仍是未知叶、`nodeUniform === 1`），不再逐次重算电压/电平/规范样本。
- **`solveSlots` 发布快速路径**：脏集合本身已去重，发布时直接匹配叶计划并原子提交，省掉收集数组与通用求解器的簿记；任何未命中（含双支路、耦合、目标非统一参考、非法参数）都整体回到原求解器，由它重新匹配并校验，守卫没有放宽。入参仍是 `Iterable<number>`：只有已知可重复迭代的输入（`Set`、数组、类型化数组）可以“先探测再回放”；其它 `Iterable`（例如一次性 generator）**只消费一次**并物化为数组，探测与回退都读这份数组，因此不会因探测而丢掉剩余脏槽或跳过非法 intent。
- **发布仍走原有 invalidate 语义**：电气求解提交样本后，每个变化的 sample 槽照旧 `version++` 并按订阅集合把接收者放入 `ActivationQueue`；没有绕过槽失效、直接唤醒观察的另一条路径。未订阅该槽的 derived 缓存和 JIT 依赖守卫都靠这个版本递增重新校验。
- **诊断**：`board[Symbol.for('mica-js.simulator/processes')]()` 增加 `bindings`，按实例报告句柄数与每个过程帧绑定的句柄数；`board[Symbol.for('mica-js.simulator/observations')]()` 仍只报告已生成链与回退原因。两者都是只读探针，不改变行为，也没有生产开关。
- **证据**：摄像头负载的过程探针显示 `camera`、`mcu` 各 16 个句柄，`mcu/dma` 帧绑定 15 个、`mcu/frameSync` 4 个、`camera/start` 16 个，`generic` 过程为空；两条 `pclkHigh`/`vsyncHigh` 生成链仍在。逐帧 raw/binary 摘要、黑色计数、DMA/结果时刻与 `verify()` 两侧一致。
- **回归**：[resource-bindings.test.mjs](bench/resource-bindings.test.mjs)（公开 SDK + DDL）用**逐条发布时刻 + 值**的 `events`（不是终点 `board.time`）断言：同一 body 双实例各自绑定、逐次读取看到新样本；两块板互不影响；绑定内存句柄的 8/16/32 位与大小端、动态索引、`copyBytes` 长度；越界写入仍以 `Memory range is out of bounds` 故障、故障前的公开 memory 前缀保留、时间停在失败步；**未被订阅但已有缓存的 derived** 在电气边沿后读到新样本（`(0,0)→(0,1)→(1,33)`）；动态非空订阅（编译链常在、通用观察按 `phase` 加入/离开同一样本槽）与全通用孪生模型逐条 `{time,value}` 相同；**绑定 `store8` 改写 JIT 代码内存后，下一次执行翻译并运行新 opcode**（指令缓存确实被清空）。[propagation-plan.test.mjs](bench/propagation-plan.test.mjs) 另加一次性 generator 的混合命中/未命中与非法批次原子性回归，并对照“把一次性输入当成可重复输入”的旧行为验证这两条回归会失败。
- **配对测量**（A/B 两侧各自带自己的 compiler dist 副本，避免共享工作区的 compiler 联接把新编译器同时用于两侧；`ab-pairs.mjs` 逐帧交替、每对交换顺序，计时只用 `stepFrame().wallSeconds`，逐帧 raw/binary oracle 在计时外；高优先级 + 绑定单个 CPU 运行）：

| 对比                                 | 对数 | 旧（ms/帧） | 新（ms/帧） | 逐对比值中位（P25 / P75）  |
| ------------------------------------ | ---- | ----------- | ----------- | -------------------------- |
| 同一构建自比（噪声基线）             | 30   | 32.97       | 34.39       | 0.961（0.889 / 1.043）     |
| 第 5 轮最终 → 收尾终版，第一次       | 100  | 36.95       | 31.32       | **1.134（1.086 / 1.221）** |
| 第 5 轮最终 → 收尾终版，第二次       | 100  | 22.66       | 20.51       | **1.102（1.025 / 1.218）** |
| 单机制消融：终版关掉资源绑定         | 120  | 22.59       | 21.80       | 1.029（0.936 / 1.126）     |
| 单机制消融：终版把发布退回通用求解器 | 120  | 25.99       | 23.53       | **1.098（1.003 / 1.203）** |

所有运行的逐帧 raw/binary 摘要、黑色计数、DMA/结果时刻与 `verify()` 摘要两侧一致。两条单机制消融各自只改一个准入开关（`compileResumableBody` 不带 `bindResources`、`solveSlots` 直接转 `runSolve(gatherSlots(...))`），因此不会把两项收益混在一起：可复现的最大单项是**发布快速路径（约 1.10×）**，其次是资源绑定（约 1.03×）。主机与其它 agent 共享且明显超订，只报告多对相邻交替的中位与四分位，不挑最好一次、不承诺稳定 30 fps。

- **已尝试并移除：电气发布 → 观察队列融合**。本轮还实现过“发布时不进 `ActivationQueue`、按预绑定唤醒表直接求值观察链”的路径，单机制闭环消融只有 1.01×（P25 0.94 / P75 1.08），落在此环境的噪声分辨率内，没有可证明的净收益；更重要的是它绕过了 `slot.version++`，导致**未订阅但已有缓存**的 derived 与 JIT 依赖守卫读到旧值（公开回归 `(0,0)→(0,1)→(1,0)`，应为 `(1,33)`）。该路径连同其成员版本守卫、混合回退与专属探针已全部删除，没有保留禁用开关；`sampleSlotsBySlot` 直接寻址、`solveSlots` 快速路径、预绑定叶载荷与资源绑定保留。
- **限制**：绑定只覆盖可恢复过程体；reaction、`compileComputation`、JIT 指令路径与资源形参仍走通用路径。挂起次数、每次挂起的 `boundary`、反应体与过程体的执行次数都没有改变，本轮不包含跨器件函数融合，也不包含电气→观察队列融合。

### 板内 UART 与 10–20 ms 宿主步进

[board-mcu.mjs](bench/board-mcu.mjs) 面向宿主每次直接推进 10–20 ms 的场景，导出同样的 `create(sdk, options)` 工厂和 `step`、`verify`、`progress`、`dispose`。每次 `step(count)` 恰好调用一次正时间 `runUntil`，没有内部 10 μs 宿主交接循环。默认每 10 ms 发送 11 字节，总周期预算默认为 2,000,000，即 20 ms；宿主步长和有效计算占比等参数仍须显式选择。

CPU 与接收 UART 通过校验后的共享 IR 组合，保留原逐位收发与电气采样；自主发送模型在精确时刻生成突发，接收完成时在模型内同步写入 CPU FIFO 并产生 IRQ，不依赖 `sync` 搬运。硬件收发 FIFO 仍分别为 16 字节；诊断通道容量明确扩大为 16,384 条，以容纳最长 1 s 预算内的批次轨迹，不代表硬件 FIFO 扩容。

在本包目录中，例如：

```javascript
import * as sdk from './dist/index.js';
import { create } from './bench/board-mcu.mjs';

const bench = create(sdk, {
  execution: 'throughput',
  waiting: 'poll',
  busyPercent: 10,
  uartPeriodMs: 10,
  cycles: 10_000_000,
});
try {
  for (let index = 0; index < 5; index++) {
    const step = bench.step(2_000_000);
    const evidence = bench.verify();
    console.log({ step, state: evidence.state, uart: evidence.uart });
  }
} finally {
  bench.dispose();
}
```

`verify()` 的同终点快照调用单独列为 oracle 调用，不计入步进耗时；独立检查全部 RAM、工作结果、字节和时间戳、FIFO、IRQ 和 GPIO。板内接入与旧宿主交接驱动的模型边界不同，二者的实时倍率不能相除后称为运行时加速；运行时优化应在同一板内模型上做配对对照，并报告实际 `runUntil` 调用次数。

### 真实负载基准

[workloads.mjs](bench/workloads.mjs)使用已验收的真实器件源码和公开 SDK，持续推进同一块板。运行前构建上述依赖包；基准引用仓库中的器件 fixtures，只用于源码仓库，不随 npm 包发布。

```powershell
pnpm --filter @mica-js/simulator bench:workloads
pnpm --filter @mica-js/simulator bench:workloads --workloads=uart,cpu-irq --sizes=1,4 --samples=100 --warmup=5
pnpm --filter @mica-js/simulator bench:workloads --workloads=sram --sizes=1 --samples=20 --allocations
pnpm --filter @mica-js/simulator bench:workloads --workloads=uart,sram --sizes=1,16 --samples=20 --cpu-profile-dir=C:\temp\mica-profiles
```

| 负载                     | size 含义                | 吞吐单位与验证                                                     |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `uart`                   | 独立双 UART 电气连线对数 | 帧；逐帧核对字节、顺序、标志、时刻与零丢弃                         |
| `cpu-irq`                | 处理器数                 | 已处理中断；真实 WAIT/ADDI/IRET/JMP 路径，检查累加器回绕与返回等待 |
| `sram`                   | SRAM 数                  | 写入/读回对；真实地址、控制与八位数据总线，校验所有读回值          |
| `pwm`                    | PWM 计数器数             | 计数 tick；检查缓冲占空比、寄存器、电平与 wrap 通知                |
| `electrical-chain`       | 未知节点数除以 8         | 节点更新；相连电阻链切换末端电阻，逐节点核对闭式电压               |
| `electrical-independent` | 未知节点数除以 8         | 节点更新；独立分压器切换电阻，与相连网络对照                       |

默认规模为 1、4、16，每组预热 5 批、测量 100 批。CPU、SRAM 和 PWM 包含公开证据存储或引脚观察器的成本；SRAM 包含宿主总线刺激，UART 包含适配器收集。输出单位不同，不能把各项吞吐直接横向比较，也不能当作完整芯片性能承诺。

JSON 写到 stdout，进度写到 stderr。报告记录 Node/V8、CPU、系统、Git 提交与工作区状态，并区分：

- DDL 前端、器件库建立、其余准备、装配、首次推进，以及预热后的稳态批次。前端使用唯一 URI 避开结果缓存，但仍复用同进程 parser/V8；不宣称进程冷启动。准备和启动各记录一次，不构造伪启动百分位。
- 惰性 JS 编译和初始求解包含在首次推进或预热中；完整后端编译成本没有被虚构为独立计时。
- 批次 median/P95/P99、操作吞吐与总运行墙钟吞吐。正确性断言、堆采样和事件循环让出位于批次计时之外，墙钟吞吐包含这些开销。100 个样本的经验尾部分辨率为 1%，不表示稳定的 P99 服务承诺。
- 堆净变化、观测到的最大堆、external/ArrayBuffer 净变化，以及批次内和整个测量区间的 GC 次数/停顿；堆净变化不是分配总量，观测最大值也不是峰值。
- `--allocations` 通过 Node 内置 HeapProfiler 采样分配，包含已被 GC 回收的对象，提供估计字节数和主要调用位置。它也包含基准验证代码的分配，并会扰动耗时；性能比较应使用相同模式，通常单独运行分配分析。
- `--cpu-profile-dir=PATH` 为每个负载/规模写入独立 `.cpuprofile`，从预热结束后开始，排除导入、编译、装配和预热。采样包括整个测量区间的驱动、内核、验证与事件循环间隙，便于区分成本；可在 VS Code 打开。微小负载的有效样本少，Inspector 控制帧可能主导 profile，不据此推断稳定热点占比。文件使用唯一名称，不覆盖已有 profile。优化收益使用关闭 profiler 的相同负载复测。

每次预热和测量批次都验证独立预期；任意不匹配立即失败，不输出成功基线。固定输入不使用宿主随机源，不保留无界输出历史。CLI 对规模、样本与稠密工作量设有显式上限；这些是测量工具限制，不扩充 SDK 的运行预算。

回归对照应保持同一驱动、参数与 Node/V8，分别加载优化前后的运行时，并串行交错执行 before/after/after/before。保留各进程原始报告及运行时摘要，检查改善是否跨重复测量成立；类型检查、生成测试和其他基准不与计时运行并发。单次跨进程差异或堆净变化不能证明稳定吞吐提升或分配下降。
