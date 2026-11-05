# @mica-js/simulator

基于[器件仿真规范](../../docs/spec/index.rst)的同步运行时。DDL、TypeScript Builder 和动态生成块使用共享 IR 与 JS 编译后端；运行位置由接入者决定，包不创建 Worker 或沙箱。

## 入口

- `@mica-js/simulator`：`createDeviceLibrary`、`createBoard`、`SimulationError` 和宿主类型。
- `@mica-js/simulator/device`：器件工厂、context、通道、批次、字节视图和 JIT 接口。
- `@mica-js/simulator/model`：共享 IR、Builder 与校验器。
- `@mica-js/simulator/ddl`：Langium DDL 编译工具；根入口不加载解析器。

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

引脚意图变化才触发边界电气求解。物理连通分量用于浮空判定、统计与故障归属；求解时以固定电位为边界，仅沿未知节点之间的电阻连接划分计算块。大型网络不会因共享理想电源或地而扩大矩阵，真实电阻桥仍合并未知节点计算块；参考电位相同的分量沿用常电位求解，最多 32 个未知节点且彼此无电阻连接的微型系统保留单个小矩阵，避免分块管理开销。仅电阻值变化时重新计算受影响块。精确拓扑的历史缓存最多占用 8 槽，首次出现只保留描述，第二次成功出现才准入图；命中时复用等值图，电阻变化只复制受影响块，失败不推进缓存准入或 LRU。独立未知节点的计算块使用对角分解与回代；冷拓扑划分按节点顺序建立块，避免中间分组集合与重复排序。

对于未知节点仅连接固定参考、每节点具有一至两条支路的小型区域，按方程形状生成专用 JS 组装程序，保留原补偿求和顺序，减少逐节点临时数组。相同形状在不同节点之间共享代码，复用前校验节点绑定及支路位置，避免独立分量数量超过缓存容量时反复编译。每网络最多保留 8 份程序，单份最多 32 个未知节点、128 条支路；形状变化时重新分析，一般耦合网络继续使用通用组装。现有分解、回代、有限性和必要系数检查共用。遵循电气规范，允许浮点舍入误差，运行期不再逐节点遍历原方程残差。

运行时记录片段内实际赋值的引脚，求解器据此更新缓存而非每边界扫描全板意图；独立求解调用省略提示时仍比较所有意图身份。意图数组及分支遵守不可变值合同。未变化块复用配置与分解，未变化采样复用已冻结对象；全部必要块求解成功后才原子发布全板新采样。一般耦合块的稠密后端对含 U 个未知节点的计算块使用 O(U²) 空间和 O(U³) 分解时间；大型单一计算块仍应通过基准评估。

JIT 在翻译并校验整个块后，将各 PC 直接绑定到已编译的指令入口；热路径不再逐次查找块内指令或读取编译缓存。执行状态保持稳定对象形状，避免每条指令增删临时属性。代码写入仍使入口缓存失效，已挂起的当前指令保留原恢复数据，完成后重新选择指令，不重放前缀。不存在 `waitUntil` 订阅时跳过全体 JIT 等待检查；存在订阅时仍按注册顺序检查。每条指令的钩子、耗时、发布边界和推进终点规则不变。

旧 `Circuit`、`compileCircuit`、原理图宿主和 `/sandbox` 入口已移除；编辑器与 playground 的接入需迁移到新的库/板合同。

## 验证

构建新模型、DDL、编译器和 simulator 包后，连接真实 adapter：

```powershell
$env:MICA_CONFORMANCE_ADAPTER = (Resolve-Path tests\conformance\adapter.mjs).Path
pnpm typecheck:implementation
pnpm test:conformance:strict
pnpm test:generated --require-adapter
pnpm test:generated:daily --require-adapter
```

`typecheck:implementation` 将已有 Builder/IR/host 类型场景的合同导入重定向到真实源码入口，不复制场景。运行时未新增单元测试，验收使用既有[符合性场景](../../tests/conformance/README.md)和[独立生成 oracle](../../tests/generated/README.md)。

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
