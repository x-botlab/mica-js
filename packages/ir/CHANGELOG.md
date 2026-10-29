# @mica-js/ir

## 0.4.0

### Minor Changes

- 9ed7675: - `@mica-js/canvas-editor`：导出 `CanvasEditor` 类与文档装载 API，由 host provider 创建并持有 WidgetHost；同步编辑/仿真模式，并打通 widget 与 device guest 的直连通道。保留 `createCanvasEditor` 工厂；旧 `host` 选项迁移到 `hostProvider`。
  - `@mica-js/core`：增加 RPC、logging、lifecycle 公开子路径，统一 `Event<T>` / `Emitter` 与资源释放接口，并提供 `level` / `message` 话题投递及画布端口声明。
  - `@mica-js/device`：支持话题投递声明、步首输入与步末输出钩子、诊断，以及 FIFO 和字节存储。
  - `@mica-js/ir`：增加数值与浮点位模式转换工具；JIT 新增短循环展开和热门区域间直接调用优化。
  - `@mica-js/sandbox`：通过 `?sandbox-worker` / `?sandbox-worker-code` 在内存中构建自包含 guest，不再需要发布独立 guest 脚本。
  - `@mica-js/schematic-editor`：公开 `SchematicEditor` 和 `DocumentModel` 的内容、撤销及变更事件 API，并修复导线 T 型吸附忽略网格的问题；旧编辑器 API 需要迁移。
  - `@mica-js/simulator`：新增统一 IR 编译器、`Circuit` 运行时、通用器件描述与访问器，以及原理图、电路和 sandbox 版本的 `DeviceSimulationHost`。不再导出内置器件模型，调用方需提供器件描述；旧调度器 API 继续支持但已弃用。sandbox guest 在构建时内联。
  - `@mica-js/widget`：新增画布实例事件与绑定校验、HostFs 文档读取、话题投递与器件 guest 直连，以及音频 API。guest 和 AudioWorklet 在构建时内联；移除旧 runtime 和独立脚本入口。`onDidXxx` 订阅统一返回 `Event<T>` 的 Disposable。

## 0.3.0

### Minor Changes

- 1cc2a2b: 新增 JIT Provider 派发内联缓存、checkpoint 快路径与热链区域编译（#154）：

  - `jit/dispatch-ic.ts`：每个 dispatch 站点维护 1–4 项单态/多态 IC，守卫为规范化 key 相等 + storage 依赖纪元 + provider 缓存纪元；未命中依次查询每 Provider 4096 项直接映射跳转缓存（单 u32 key 用 `(k ^ (k >>> 12)) & 4095`，其余 FNV-1a），最后才走 `materialize`。float key 以 `Object.is` 比较，`NaN` 命中、`±0` 区分，与 `normalizeKey` 的位串身份一致。
  - checkpoint 快路径：产物状态记录 `validatedEpoch`，纪元未变时跳过依赖 WeakMap 遍历；IC 命中与 `materialize` 返回后都会刷新该纪元。
  - `jit/region.ts` + 区域代码生成：某产物进入次数达到 500 后，沿 IC 转移计数最高的后继做 DFS 收集至多 32 个同 Provider 成员，编入同一个 JS 状态机；成员间派发变为 `cur = j; continue`（单 u32 key 生成 `switch`），客体自环变为普通 JS 循环，未命中仍走通用 `materialize` 并在结果恰为成员时留在区域内。区域只占一帧，指令位置、`functionIndex`、步数与错误调用栈保持参考语义。
  - `IRJITTuning.optimizations` 新增 `dispatchIC`、`checkpointFast`、`regions`（别名 `region-compile`）开关；默认全部开启，可逐项关闭并用现有 pass matrix 对拍。
  - `dispatch-ic.test.ts` 与 `region.test.ts` 覆盖 key 身份、跳转缓存冲突、IC 轮转与纪元失效、区域形成/自环/重新生成与步预算边界。

- 1cc2a2b: feat(ir): 内联与 Tier-2 分层重编译

  - 新增 `inline` 优化 pass：按被调函数大小、调用点热度（Tier-1 剖析）与静态循环深度选择内联；递归 SCC 与含 `dispatch` / 失效 `checkpoint` 的被调函数不内联。
  - MIR 位置表新增虚拟内联帧（`locs.parent` 与 `locs.inlineFrames`）。内联后的错误 `location` 与 `callStack` 沿父链逐层展开，与参考解释器逐帧一致；步段仍按调用者计算 `stepsAfter`，步数与未内联时相同。
  - 新增 `jit.tierUpThreshold`（非负安全整数，默认 1000；`0` 表示首次编译直接产出 Tier-2）。Tier-1 函数序言与堆帧层都会计数，达到阈值后同步重编译为带内联和偏置布局的 Tier-2；当前激活继续在 Tier-1 中执行，之后的调用进入 Tier-2。
  - `jit.artifactWarmup` 现在真正生效：Provider 产物先在堆帧层执行 K 次，随后编译（`0` 表示首次派发即编译）。产物同样保存 Tier-1/Tier-2 两层编译结果。
  - `jit.optimizations.inline` 可关闭内联；pass matrix 与 parity fuzz 新增 Tier-2、`tierUpThreshold: 0/1` 及关闭内联的配置。
  - 已知限制：没有 OSR。只运行一次的长循环函数不会在运行中升级；DBT 负载的产物会被反复执行，不受影响。

- 214a324: 新增 JIT 基线代码生成（#146）：把 MIR 编译为可用 `new Function` 构造的 JavaScript 源码。

  - `jit/codegen/compile.ts`：`compileFunction(mfn, env)` / `compileFunctionWithSource`，按函数与环境缓存生成源码；宿主禁止动态代码时抛出 `JitCodegenUnavailable`，供后续层级回落。
  - `jit/codegen/structure.ts`：支配树 + 后支配树 Stackifier（Ramsey 思路），生成 `if/else`、带标签 `for(;;)`、`continue`/`break`；不可归约或无法结构化的 CFG 自动回落到 `switch (pc)` 派发。
  - `jit/codegen/segments.ts`：按宿主边界（`call`、executor、event、bridge、`checkpoint`）与终结符划分步段，计算 `stepsAfter` 并分配精确副本的独立 `LocId`。
  - `jit/codegen/ops.ts`：完整操作表。整数运算以 `W(T, x)` 回绕、浮点按 D/U 表示生成原生运算、存储走 J3 typed array 快路径（大端宿主回退 DataView）、宿主调用经 `beforeHost`/`afterHost`。
  - `jit/codegen/emit.ts`：生成函数外壳（局部变量、`L`、`try/catch`、`sourceURL`），所有字面量经 `k[i]` 常量表引用，绝不把用户字符串拼进源码。
  - `jit/runtime-core.ts`：`JitRuntime` 计步状态机（`none`/`observer`/`budget`、`limitReached`、`flush`、`beforeHost`/`afterHost`）、`TAIL` 尾转移哨兵、`JitUnwind` 帧收集与 `createJitHelpers`。
  - `jit/testing/compile-module.ts`：仅测试用的最小装配，编译整模块并驱动 `TAIL` 链；测试与参考解释器逐值、逐步数、逐错误对比。

  以上模块仅供内部 JIT 使用，不从包入口导出。

- 214a324: 新增 JIT 浮点运行时 `packages/ir/src/jit/float-runtime.ts`。

  文件定义 JIT 统一的浮点值表示：D（JS `number`，仅覆盖位串全小写、NaN 为规范 NaN 的值）与 U（`number | FloatBits`，D 无法表示的大写位串、NaN 载荷以冻结 `FloatBits` 保留），并提供以下辅助：

  - 边界转换 `fromBoundary` / `toBoundary` / `toNum`，输出与解释器 `fromNumber` / `toNumber` 逐字符一致；
  - 位模式搬运 `fromRaw32` / `fromRaw64` / `raw32` / `raw64`，NaN 载荷不依赖宿主引擎的位模式策略；
  - 正确舍入的融合乘加 `fma32`（TwoSum + round-to-odd）与 `fma64`（Boldo–Melquiond 快路径，阈值外回退到 `float-ieee.ts` 的 BigInt 精确实现）；
  - 运算表中 `add/sub/mul/div`、`cmp`、`isNaN/isFinite`、`convert.*` 的 JIT 侧参考实现。

  该文件仅供 JIT 内部使用，不从 `index.ts` 导出。

- 2ed90cd: 新增 `createIRJIT` JIT 执行引擎（#147）：与参考解释器共享创建契约、`storage` 与 `execute` 接口，并在 `values`、`steps` 与 `IRExecutionError` 上逐项等价。

  - 模型函数首次调用时降级并编译，编译后的函数替换 `H.fns` 槽；Provider 产物在首次 `dispatch` 或 checkpoint 恢复时编译，按产物身份缓存。
  - `dispatch` 与失效 checkpoint 通过 `TAIL` 哨兵和 `runTail()` 蹦床执行，派发链不增长 JS 栈；产物以 `artifact.index` / `artifact.name` 降级，错误位置与调用栈与参考一致。
  - 每次派发校验产物依赖，并递归检查整条 Provider 调用链；深层依赖失效时重新生成并重编译。
  - `maxSteps`、`stepObserver`、`stepBudget` 保持参考语义；执行结束时提交已开始的步骤。
  - `IRJITTuning` 支持 `tier`、`codegen`、`warmup`、`artifactWarmup`、`maxCompiledDepth`、`optimizations` 与 `debug.verify`；非法值报 `invalid-options`。
  - `new Function` 不可用时 `codegen: 'auto'` 静默回落到共享同一 `storage` 的参考解释器；`codegen: 'require'` 在创建期以 `invalid-options` 拒绝。

- 1cc2a2b: 新增 JIT 内存优化 passes（#152），在保持 C5 的前提下消除 DBT 风格 IR 的存储访问瓶颈：

  - `jit/passes/load-elim.ts`：基于资源身份别名分析的前向数据流。冗余加载改写为 `forward`（保留原 `node`/`loc`/步数），存储转发仅在 `D` 浮点值上启用；`U` 浮点、`bytes` 宽度/字节序不一致、宿主指令与 `call`/`checkpoint` 屏障都会按规格失效。
  - `jit/passes/scalar-promotion.ts`：把循环内热点的 `state` 资源与常量下标 `array` 元素提升为局部变量（`ps<n>` + 脏标记）。入口与每个屏障后重载；宿主指令、`call`、`checkpoint`、`return`、`dispatch` 前写回，之后失效重载；`catch` 中先写回所有脏值再重抛。`state.store`/`array.store` 的原位置保留挂起检查，经公开存储方法抛出原错误。
  - `jit/passes/bounds-elim.ts`：复用 #151 的区间分析做静态越界检查消除；对基本归纳变量的循环生成 `bounds.guard` 并在前置块用分支选择「无检查的克隆循环 / 原循环」。守卫不计步、不可抛，慢路径保持原指令，越界仍在原位置报错。
  - `jit/passes/memory-model.ts`：三个 pass 共用的位置、别名与屏障模型。
  - `jit/passes/index.ts`：`runMemoryPasses`（`loadElim → scalarPromotion → boundsElim`）与 `runJitOptimizationPipeline`（#151 标量流水线之后接入内存 passes）。
  - MIR/代码生成：新增 `forward`、`promote.load`、`promote.store`、`promote.reload`、`bounds.guard` 与 `MFunction.promotions`、`MInst.uncheckedBounds`；`check` 支持 `none`/`divzero`/`f2i`/`bounds` 四种形式。
  - 测试：`passes/*.test.ts` 覆盖加载消除、标量提升、越界外提、16×u32 DBT 寄存器文件、故障/预算/宿主回调时的存储一致性，并注册到 pass matrix。

- 214a324: 新增 JIT 中间表示（MIR）与分析框架：IR → MIR 降级、静态引用解析、指令效应表与函数摘要、表示分析（D/U）、CFG/支配树/自然循环、活跃性分析，以及检查 SSA、类型、边、步数与位置一致性的 `verifyMIR`。这些模块仅供内部 JIT 使用，不从包入口导出。
- 1cc2a2b: 新增 JIT 标量优化 pass（#151）：`sccp`（稀疏条件常量传播、分支折叠与不可达块删除）、`gvn`（支配树作用域上的全局值编号/CSE，含纯但可抛指令）、`range`（整数区间分析、循环头加宽与分支细化）、`licm`（循环不变量外提）与 `dce`（死代码消除，可抛操作降级为 `Check`）。

  - 每个 pass 都是 `MFunction → MFunction` 的纯函数；`packages/ir/src/jit/passes/{sccp,gvn,range,licm,dce}.ts` 可单独开关。
  - 步数不变量保持不变：被删除或移动的指令在原位置留下 `step = 1` 的 `Check`，外提指令使用 `step = 0`。
  - `IRJITOptimization` 新增 `sccp`、`gvn`、`range`、`licm`、`dce` 开关，默认全部开启；`pass-matrix` 为每个 pass 增加单独关闭的行。

- 214a324: 新增可选的 `stepBudget` 批量计步协议：`IRInterpreterOptions.stepBudget` 接受 `{ remaining(ctx), consume(ctx, n) }`，引擎可以把多步合并为一次 `consume` 调用。参考解释器每步调用 `consume(ctx, 1)` 且从不调用 `remaining`；`stepBudget` 与 `stepObserver` 互斥，同时提供时以 `invalid-options` 拒绝。
- 214a324: 新增内部存储与 Provider 运行时快路径：`storageInternals` 符号暴露记录级 typed view / `DataView`、存储 `epoch` 与写挂起计数、`advanceScalar`，`ProviderRuntime` 增加 `cacheEpoch`。这些接口仅供 JIT 直接访问底层字节并做 O(1) 缓存校验，不从包入口导出，公开行为保持不变。

### Patch Changes

- 214a324: `bridge.send` 与 `bridge.send_bytes` 的宿主返回值现在经 `captureArgument('bool')` 捕获。宿主返回非 boolean 时（例如 `1`、`undefined`、`'true'`）以 `evaluation-failed` 失败，`steps` 与 `location` 指向该 bridge 指令，解释器随即 faulted。
- 214a324: `const.bits` 现在返回冻结的 `FloatBits` 对象。SSA 中的浮点值一律冻结，宿主经 executor operands 或函数返回值拿到该对象时不能再就地修改；位串仍保持字面量原样。
- 1cc2a2b: 新增 M3 类 DBT 吞吐基准 `bench/m3.bench.ts`（#150）：16 个预生成的客体基本块组成尾派发环，模型包含 16×u32 寄存器、NZCV 标志位与 256 KiB 字节内存，按周期预算批量调用 `event.at`；基准输出客体 M inst/s、相对参考解释器的倍率以及 ≥72 MHz 目标的达成比例。`bench/` 不进入构建产物。

## 0.2.0

### Minor Changes

- f6c9dac: 实现连接作者接口与 IR 接入（#57）：器件描述解析 #14 连接声明；`api.ir.connection(id)` 与 `b.connection.apply([{ connection, closed }])` 把建图时固定的对象列表降低为 `static-list` 连接引用与等长 bool SSA 列表；通过 `DeviceInstanceOptions.connections.topology` 绑定 core topology，在合法控制阶段以一份原子 patch 提交，支持普通/生命周期/嵌套块、SSA 按值捕获、稳定同刻顺序、未知/跨实例/非法 patch 诊断，以及冲突后不回滚已提交拓扑。IR 增加通用领域指令列表操作数与可信同步 `IRInstructionExecutor`，core `createIRSchedulerInstance` 可传入执行器。
- d699e7f: 实现话题与 IR 消息桥接（#54）：`api.subscribe/publish/post/postBytes/onOutput/updateBytes` 接入真实 `validateIR` → 参考解释器 → scheduler → device 生命周期链；新增 IR `output` / `outputBytes`、`bridge.send` / `bridge.send_bytes` 与宿主 `IRBridgeHost`，device 侧提供有界输出/输入/发布/更新队列、inbox 预留与释放、初始化暂存与激活顺序、`onTopic` 宿主回调及 `deliver`，并以 `BackpressureError` 和新增 `DeviceErrorCode` 报告背压与非法载荷/句柄/范围。Scheduler 增加不推进时间、不分配事件 ID 的普通消息入口与 `messageId`；`IRStorage` 增加宿主 inbox 写入与原子版本化字节更新。`TopicPayloadType` 随 `DevicePortDescriptor` 一起从包入口导出，宿主可以给端口类型命名。
- dbf7d60: 实现引脚声明接入与数字 I/O 指令（#55）：解析 `pins` / `pinGroups`，新增 `api.ir.pin`、`b.pin.configure/writeDigital/sampleDigital` 与 `pin.configure/write_digital/sample_digital` 显式指令；链接期校验引脚类别、配置编码与宿主授权，经 `DeviceInstanceOptions.pinHost` 消费 #51 的持有意图、门控采样与恢复能力；初始状态提交、控制阶段可见性与销毁恢复均按已批准合同执行。IR 增加通用 `builderExtensions` 建图扩展，领域指令执行复用已合并的 `executors`；不实现观察、消息、电压/查询指令或组 I/O。
- a5d8ce5: 实现产物 checkpoint 与运行中失效恢复（#61）：生成函数构建器新增 `checkpoint(provider, key, args)`，在产物内标记合法恢复边界并检查当前产物的完整依赖；有效时继续，失效时丢弃旧产物剩余步骤并以当前 key/args 尾派发恢复目标，保留已提交存储/事件/输出/时间效果、当前入口预算与虚拟时间。恢复目标可为自身或 `imports` 中的 provider，结果布局必须一致；产物写入其生成读取的资源时，必须在该写入之后提供 checkpoint，否则仍以 `unsupported-provider` 拒绝。新增 `invalid-checkpoint` 诊断与 `recovery-failed` 运行期错误码；checkpoint 不固化生成产物，恢复按当前资源版本重新生成。只支持内存内实例恢复，不提供持久化快照、跨进程/跨实例迁移或 JIT/重放。
- 645e731: 实现 Provider 生成、依赖跟踪与缓存（#60）：`ir.provider` 声明固定 key/参数/结果布局、生成期受追踪读取与产物可引用引用；`gen.readBytes`/`readState`/`readArray` 登记实际覆盖的版本单元（state/array 使用整资源单元），产物经既有 `validateIR`、imports 白名单与解释器执行。`dispatch` 作为终结指令按规范化 key 复用或按需重生成产物，每次派发校验全部依赖，缓存按实例隔离。新增 `IRProviderError` 与可区分的声明/读取/生成/产物/依赖错误码；生成产物写入自身读依赖时明确拒绝（运行中恢复属于 #61）。device 的 `api.ir.provider` 与 core 的调度接入同步可用。

## 0.1.0

### Minor Changes

- 503b44b: 首个公开版本：领域无关的 IR 模型与同步类型化建图器、静态校验与链接诊断、整数/布尔/浮点逐指令求值、实例存储、参考解释器与版本化资源更新。
