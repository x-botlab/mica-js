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

引脚意图变化才触发边界电气求解。物理连通分量用于浮空判定、统计与故障归属；求解时以固定电位为边界，仅沿未知节点之间的电阻连接划分计算块。大型网络不会因共享理想电源或地而扩大矩阵，真实电阻桥仍合并未知节点计算块；参考电位相同的分量沿用常电位求解，最多 32 个未知节点且彼此无电阻连接的微型系统保留单个小矩阵，避免分块管理开销。仅电阻值变化时重新计算受影响块。精确拓扑的历史缓存最多占用 8 槽，首次出现只保留描述，第二次成功出现才准入图；命中时复用等值图，电阻变化只复制受影响块，失败不推进缓存准入或 LRU。独立未知节点的计算块使用对角分解与回代；冷拓扑划分按节点顺序建立块，避免中间分组集合与重复排序。

对于未知节点仅连接固定参考、每节点具有一至两条支路的小型区域，按方程形状生成专用 JS 组装程序，保留原补偿求和顺序，减少逐节点临时数组。相同形状在不同节点之间共享代码，复用前校验节点绑定及支路位置，避免独立分量数量超过缓存容量时反复编译。每网络最多保留 8 份程序，单份最多 32 个未知节点、128 条支路；形状变化时重新分析，一般耦合网络继续使用通用组装。现有分解、回代、有限性和必要系数检查共用。遵循电气规范，允许浮点舍入误差，运行期不再逐节点遍历原方程残差。

运行时记录片段内实际赋值的引脚，求解器据此更新缓存而非每边界扫描全板意图；独立求解调用省略提示时仍比较所有意图身份。意图数组及分支遵守不可变值合同。未变化块复用配置与分解，未变化采样复用已冻结对象；全部必要块求解成功后才原子发布全板新采样。一般耦合块的稠密后端对含 U 个未知节点的计算块使用 O(U²) 空间和 O(U³) 分解时间；大型单一计算块仍应通过基准评估。

JIT 在翻译并校验整个块后，将各 PC 直接绑定到已编译的指令入口，保持稳定执行对象，避免逐次块内查找和临时属性增删。代码写入仍使入口缓存失效，已挂起的当前指令保留原恢复数据，完成后重新选择指令，不重放前缀。不存在等待订阅时跳过全体 JIT 等待检查；存在订阅时仍按注册顺序检查。

### MCU 执行模式

板默认使用 `execution: 'throughput'`，可切换 `execution: 'precise'`。`cpuQuantum` 为整数皮秒，范围 1 到 10,000,000，默认 10 μs；精确模式仍校验该值但不使用它。吞吐模式允许 CPU 观察、轮询退出和 IRQ 响应的额外延迟不超过该预算；固有的指令耗时、中断屏蔽和模型等待另计。外设、通信边沿、FIFO 和已锁存事件不按该预算合并。

吞吐模式将支持的缓存指令编译为紧凑 JS 执行循环，使用标量状态槽和原始 RAM 字节区，减少逐指令生成器、对象分配和通用派发。每段截止于下一普通事件或推进终点；资源屏障已排除中间可观察变化时，不因时间量子额外返回通用调度器。`cpuQuantum` 是额外可见性延迟的上界而非固定步长，当前实现保持精确事件期限，不故意引入延迟。直接执行目前只用于单 JIT 板上的标量运算、固定 RAM 区域（偏移可动态计算）、正固定耗时和分支；不支持的指令、观察者、中断条件依赖写入及代码写入形成逐指令屏障，其余指令继续直接执行。按守卫集合复用最多 8 份程序，代码失效时一起清除，避免 IRQ 分支切换导致重复编译。挂起后缀保留读取结果，实际写入用可复用脏位集提交；外部改码也不重放当前前缀。

直接执行守卫缓存资源的观察订阅版本：资源首次被观察或最后一个观察订阅移除时更新版本，动态观察分支切换和共享订阅遵守同一规则。订阅版本未变且中断条件没有新增实际读取依赖时，复用已有守卫集合，省去每次交接对全部状态与内存的扫描；普通资源值变化仍使用原有数据版本和通知机制。

批次交接跳过空输入队列的排空与清理，并在创建器件时预绑定输入清理、输出通道和输出通知的布局。完全空的输出复用该器件预建的冻结对象；首次出现消息或通知时才按原字段顺序复制布局并生成新快照，空输出通道复用冻结空数组。全部器件的批次仍在任何 `sync` 回调之前捕获，每个器件逐次收到新的冻结批次，所有输出字段、通知复位、非空消息快照与冻结合同保持不变；空输出对象及数组身份不保证逐批唯一。

`waitUntil` 保持按依赖唤醒的 WFI 等待。单 JIT 板上的无副作用自循环可自动证明并跳过重复执行，依赖变化后沿原循环相位恢复，不提前读到外部变化；多 JIT 保留原交错顺序。模型也可在 `attachJit` 声明 `polling: [{ pc, predicate }]`：吞吐模式在该 PC 开始前检查本实例无参 bool 纯函数，返回 false 时停在循环头等待实际依赖或中断条件变化，循环体不执行；返回 true 后正常执行。该声明是模型的等待语义承诺，精确模式忽略它并实际执行循环。参见[吞吐合同](../../docs/spec/jit/throughput.rst)。

旧 `Circuit`、`compileCircuit`、原理图宿主和 `/sandbox` 入口已移除；编辑器与 playground 的接入需迁移到新的库/板合同。

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
