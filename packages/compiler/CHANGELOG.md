# @mica-js/compiler

## 0.12.0

### Minor Changes

- 0573e1b: 支持可观察的 JIT 停驻与可中断的外设合批。JIT 按原指令时刻发布停驻前缀，依赖失效后从实际 PC 恢复并保留剩余耗时。合批支持 16 位填充和搬运、关联状态和带时间戳的逐项输出，并允许外设在 CPU 等待期间使用经调度验证的时间窗。SDK 器件入口导出停驻检查点类型。

## 0.11.1

### Patch Changes

- 4cb01cb: Support proven Direct JIT service tails in fixed-duration span prefixes and self-jump loops. The compiler checks that the bound blocking guard remains stable and applies each prefix's elapsed update before the terminal instruction. Byte-counter folding also recognizes equivalent decrements masked again by the byte store.
- cf712aa: Fix Direct JIT loop folding so completed rounds update the service accumulator according to the verified instruction tail, including when the accumulator starts at zero or no service deadline is active. Preserve the accumulator for empty tails and execute unproven tails one instruction at a time.

## 0.11.0

### Minor Changes

- 794f541: Add opt-in scheduler-bounded batch execution for device processes and JIT loops.

  - `@mica-js/compiler`: prove process and JIT loop batch plans from validated IR, including the process loop-to-resume-block mapping consumed by the simulator.
  - `@mica-js/simulator`: add `BoardOptions.batchExecution` (default `false`), `DeviceContext.registerProcessBatch` with `ProcessBatchRegistration`, and `JitTranslateInput.markBatchLoop` with `JitBatchMark`. Prepared simulation loads validate the scalar switch, forward it to the board and keep it across reset.
  - `@mica-js/sdk`: re-export the batch declaration types from the device entry and accept the forwarded `batchExecution` switch in `HeadlessRuntimeOptions`. Fused `ModelBinding` forwards `registerProcessBatch` to the simulator context, and a rejected option keeps preparation and the active session untouched.
  - `@mica-js/editor`: carry `batchExecution` through the canvas simulation configuration and the fused runtime load request so the typed RPC guest creates and rebuilds boards with the captured switch.

## 0.10.0

### Minor Changes

- 37fb24a: Add Direct JIT timing admission and cross-instance artifact reuse.

  - `@mica-js/simulator`: add opt-in `directTiming` with `service`/`blocked` declarations and translation markers `markDirectSpan`/`markDirectLoop`; expose Direct span/loop execution metrics and rejection statistics. Marked spans fuse a proven pure prefix before an ordinary terminal write, and marked loops fold complete rounds before a normal boundary round.
  - `@mica-js/compiler`: add `compileDirectJit.createArtifactCache()`, `createSession(binding, cache?, artifactCache?)`, `clearArtifactCache()`, and `artifactCacheStats()`. The bounded artifact cache shares instruction templates, constants, resistor slots, and shard source/factory LRU entries across sessions; stats report hits, compiles, entries, source units, and evictions.
  - `@mica-js/device-model`: reuse structurally equal JIT function tables and cheap-shape-gated validated bound blocks. Object identity remains the fast path; structural digests only filter candidates before full IR confirmation.
  - Add opt-in `shareDirectArtifacts` (default `false`), `translationIdentity` with dependency-range validation, and `directTier.promoteAfter` for per-PC generic-to-Direct promotion. Omitting `directTier` keeps the existing immediate-Direct behavior.
  - Compile generic instruction bodies lazily on first generic execution, so Direct-resident code does not pay for unused generic compilation.

### Patch Changes

- Updated dependencies [37fb24a]
  - @mica-js/device-model@0.7.2

## 0.9.0

### Minor Changes

- 7fb9015: Add incremental Direct JIT sessions with a fixed dispatcher, per-batch route installation and resident shard reuse. The simulator now translates and dispatches Direct code on demand instead of rebuilding a whole program, reports route/shard/dispatch diagnostics, and can opt into validated cross-window instruction-body sharing through `shareDirectBodies` and `markDirectBodyShareable`.

## 0.8.0

### Minor Changes

- 8710632: Direct JIT 在指令边界按调用点动态发布观察写入：写屏障拆分为入口拦截与运行期发布，支持 immediate 块原地检查点，条件跳转与尾部延时共享续跑出口，减少可观察写入的重复发布。

  新增 opt-in 边界归因诊断：`boundary()` 记录调用点来源（`jitSignal`/`polling`/`process`/`checkpointPublish`/`checkpointFinish` 等），通过 `Symbol.for('mica-js.simulator/checkpoints')` 读取只读计数器，默认关闭、不影响正式运行。

## 0.7.1

### Patch Changes

- Updated dependencies [ee48660]
  - @mica-js/device-model@0.7.1

## 0.7.0

### Minor Changes

- 7640ca1: 缩短高频总线场景的仿真耗时：电气脏集、时间事件堆与观测派发改为零分配形式，无挂起点的进程体控制流不再拆成机器块，停泊 JIT 只在其依赖实际变化时重扫。并口摄像头负载的稳态帧耗时约降到原来的 45%（`camera-mcu`，RTF 1.8x → 3.7x）。

  `ResumableProgram` 新增只读 `blocks`，报告该 body 编译出的机器块数；过程探针新增 `programs: [{ key, blocks }]`，既有字段名不变。

## 0.6.0

### Minor Changes

- 42ac451: 缩短 direct JIT 的编译与执行时间：在有界 LRU 中复用未绑定的驻留分片工厂，保留每个实例独立的绑定；支持同帧调用同步函数、直编引脚采样和意图写入，以及在发布边界安全续跑。不能直编的操作仍走原回退路径。

  `DirectJitFrame` 的 `stateDirty` 和 `memoryDirty` 现在也可用 `Int32Array`，自定义宿主应按索引访问这些位图。

### Patch Changes

- Updated dependencies [42ac451]
  - @mica-js/device-model@0.7.0

## 0.5.1

### Patch Changes

- 0ce5a52: 发布 `compileSynchronousBody` 导出，供 simulator 使用。

## 0.5.0

### Minor Changes

- 5dbada1: 降低 direct JIT 的执行与代码规模开销，并把忙等环交给运行时折叠。

  - 直编发射器按活跃区间复用局部槽：一条指令体的上千个临时值现在共享十几个槽。外设写块的生成源码从 93 KB 降到 35 KB、声明寄存器从 1441 降到 15，单次执行 1.1 μs → 0.1 μs；带 16 脚 intent 树的服务块 1.9 μs → 0.6 μs。
  - 分片预算改用生成的源码字符数（单片 36 KB、单体上限 48 KB）。V8 的可优化规模取决于函数体积而不是槽数，槽数压缩后按旧阈值会把整份程序退化成单体大函数。
  - 条件检查（`if`/`select`/`and`/`or`/`assert`）内联 `typeof` 判断，非布尔值才调用 `H.checkBoolean`。
  - `elapse` 接受运算得到的时长：动态时长保留槽位，在操作所在位置经 `H.checkDuration` 校验后使用，与 generator 后端一致。
  - `JitOptions.delays` 声明寄存器递减型忙等环（`subs`/`bne`）。运行时在环头按剩余推进窗口取整折叠轮次，越过窗口时仍逐轮执行，不越过推进目标与下一事件。
  - 器件侧：32/16 位访存改用 `load32le`/`store32le` 一类的宽操作（一次按宽度校验，而不是每字节一次）；GPIO 配置寄存器（MODER/OTYPER/PUPDR/AFR）在 state 里维护影子，引脚意图只读 state，写寄存器时写穿到寄存器映像。

## 0.4.0

### Minor Changes

- 8439e45: 对全部可发布包统一推进一个 minor 版本，用一次发布会话走完 `release.yml` 的 OIDC 信任发布流程。

  - 每个包各发布一个新版本，使 npm trusted publishing 在 11 个包上逐一完成校验；此前 `@mica-js/scene-3d` 因包名在 registry 中不存在而无法走 OIDC，首次版本由人工发布补位。
  - `@mica-js/simulator` 的 2.1.1 在改动前未进入 registry，本次随 minor 推进覆盖该版本。
  - 本 changeset 只做版本推进，不包含源码或行为变更。

### Patch Changes

- Updated dependencies [8439e45]
  - @mica-js/device-model@0.6.0

## 0.3.0

### Minor Changes

- a935edb: 修复 direct JIT 的常量发射、select 展开和 IR 覆盖缺口。

  - 安全整数、布尔和 JSON 编码字符串直接生成源码字面量；`pc`、`nextPc` 和时长同样内联，减少常量数组 keyed access。
  - 纯值 `select` 生成三元表达式；含副作用或额外 `yield` 的分支保留标签块。
  - 支持 `load16le/be`、`load32le/be`、`store16le/be`、`store32le/be`、短路 `and`/`or` 和 `match`，并保持宿主相同的地址、取值校验顺序。
  - direct 程序可通过运行时 host 执行 `send`、`readSample`、`writeIntent`、`resistor`、`combineIntents`、`assert` 等操作；宿主调用前的片段时间会同步到板时。
  - 零时长 `elapse`/`redirect` 不再被拒绝：不推进时间，也不需要续点，服务块这类以 `elapse(0)` 结尾的指令因此能进入直接后端。
  - 超过 8 条指令的 direct 程序按「局部槽预算」生成分片函数（默认 1536 槽、最多 8 条一组），超大指令体单独成片；总槽量不超过 2048 的程序仍用单体函数。派发器进入 TurboFan。
  - STM32G431 基准新增真实 Thumb 固件、独立参考机、IR 覆盖统计和 V8 跟踪工具。

## 0.2.0

### Minor Changes

- New architecture for mica simulator and refactoring of editor package

### Patch Changes

- Updated dependencies
  - @mica-js/device-model@0.5.0
