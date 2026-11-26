# CT107D Direct JIT 时间准入与跨实例缓存：实现与验收记录

对应计划：[ct107d-jit-timing-and-cache-plan.md](./ct107d-jit-timing-and-cache-plan.md)（基线 `6c76ee3`）。本记录覆盖本仓库 `6512a79..8756a6d` 的 #309/#310 实现；板侧 `mica-devices` 的接入与固件测量不在本仓库范围。

## #309 Direct 时间准入

### 宿主合同、标记与校验

- `JitOptions.directTiming` 增加 `service?: { elapsed; deadline }` 与 `blocked?: string`。`service` 两项必须指向已声明的 number 状态；`blocked` 必须指向已声明、无参、返回 `bool` 的 `pure fn`，且仅在同时声明 `service` 时有效。未知名称、类别或签名不符按 `INVALID_BINDING` 拒绝；运行期定时状态不是非负安全整数时，候选回到普通路径。
- 仅在提供 `directTiming` 时，`translate` 输入才提供 `markDirectSpan(pc, instructionCount)` 与 `markDirectLoop(pc, candidate)`。标记只在本次同步翻译回调内生效，不进入返回的 `BlockIR`，也不保存本次推进时限；每次翻译（包括板级缓存命中）都应重新提交。
- 运行时校验并分类标记。span 记录 `invalid`、`unknownPc`、`duplicate`、`discontinuous`、`notAdmitted`、`conflict`；loop 记录 `invalid`、`unknownPc`、`duplicate`、`notAdmitted`、`delayConflict`、`conflict`、`address`。非法、重复、冲突或无法证明的标记只取消该优化，翻译和普通指令仍成功。

### 编译证明与执行

- span 为 `2–8` 条连续指令：编译器从绑定后的规范 IR 证明前缀各条 `nextPc` 连续、耗时为正整数常量、无控制转向/异常/可观察中间发布，内存读写有界，并排除采样、引脚、消息、随机数、时钟、动态 SFR/`MOVX`、代码写入和不透明调用。前缀写入不得命中入口/观察者掩码或定时状态；代码内存写入一律拒绝。
- 终结成员必须是普通写：非 `isolated`、非 `stop`、无静态 guard，且至少写入一个非 PC 状态或一个 memory。终结写保留其普通 Direct 路由、原起始时刻、`publishCheckpoint`、电气求解、捕获顺序与异常冲刷；前缀按原耗时顺序累加，不产生单独发布点。
- 严格视界：在边界检查完成、首条前缀写入前取当前时间 `t`。宿主上限为 `min(runUntil 终点, 下一模型事件, 当前执行段终点)`；`service.deadline > 0` 时再加入 `t + max(0, deadline - elapsed)` 并夹到宿主上限，最终最小值为 `H`。span 仅当 `t + ΣdurationPs < H` 时执行；目标落在前缀内或恰在终结写开始时，不产生终结写。
- loop 支持 `spin` 与 `decrement8`。编译器证明固定轮时长、真实自跳、仅由计数器决定的出口、读写全集及可归纳尾部；`maskedByte` 地址按 `(selectorByte & mask) | bits` 合成，绑定期穷举选择字节并确认目标在计数内存内。每轮尾部只允许更新 `directTiming.service.elapsed`，其他写入拒绝。
- 折叠预算为 `Ktime = floor((H - t - 1) / d)`，`decrement8` 另取 `Kdata = (r === 0 ? 256 : r) - 1`，实际折叠 `k = min(Ktime, Kdata)`；`spin` 取 `Ktime`。折叠使用标准脏位提交计数器、保持 PC 在环头、精确推进 `k * d`，并在服务活跃且未到期时累加 `elapsed`。IRQ 保护、挂起中断、UART 唤醒、T0 边沿、IAP 待处理、计数写观察者或保护窗口中的轮次交给原指令。
- 折叠后由同一环头的普通单轮入口处理边界轮，包括到期服务和最后一次递减；`runUntil` 落在该轮中间时按原指令写入计数器/PC、捕获 `resume`，到期后只执行一次尾部。函数内不会递归进入同一折叠分支。
- `JitDelay.pending` 的 paced 预算单独修正为 `remaining > 0 ? floor((remaining - 1) / cycles) : 0`，再与计数器、推进目标、下一事件和执行段终点取最小值，保留真实服务边界轮。

### 运行时绑定、掩码与统计

- `DirectJitBinding` 增加惰性绑定字段 `memoryLengths` 与 `codeMemories`，供编译器做静态地址和代码写证明；不在翻译前预编译通用体。
- 运行时生成观察者与入口屏障掩码：`blockedStates`/`blockedMemories`、`entryBlockedStates`/`entryBlockedMemories`。观察者掩码原位刷新，不因订阅变化重建会话；入口屏障变化才使会话失效。span 前缀共用一组写集合屏障，终结成员保留自身 guard/barrier。
- `DirectJitFrame.directMetrics` 提供 `spanRuns` 与 `loopRounds`，由运行时聚合到 `directSpans`、`directSpanRuns`、`directSpanRejected`、`directLoops`、`directLoopRounds`、`directLoopRejected`，以及回调/候选/分类拒绝计数。
- 失效或动态失配只执行该逻辑 PC 的原指令：普通 Direct 可用时优先使用它，否则使用通用体。已执行前缀/轮次不重放，不设置 `directSkip`，也不把入口加入永久拒绝集；同一 PC 的 span 与 loop 标记互斥，后续翻译替换时撤销旧计划。

## #310 跨实例模板与两级执行

### device-model 结构复用

- `buildJitFunctions` 对同一规范器件的结构相等函数表返回同一个冻结数组，供下游按数组身份缓存绑定；每个器件最多保留 8 种结构变体，空表保持原行为。结构比较使用 `Object.is` 数字语义，失败闭锁而不放宽校验。
- `validateBoundBlockIR` 保留对象身份快路径；身份未命中时先用 O(1) 廉价形状键筛选，只有重复形状才计算结构摘要，再以完整结构相等确认。每个器件设有有界形状桶/块与摘要桶/块并淘汰最旧项。命中只复用已成功校验并绑定的规范块；失败仍走原校验器，不跨实例携带诊断。

### 惰性通用体与函数表

- 翻译期不再预编译通用 `body()`。`JitInstruction.execute` 在首次实际选择通用后端时编译并缓存；仅使用 Direct 的路径不承担通用体编译。通用体统计单独记录编译与复用次数，避免把 Direct 驻留误报为通用执行。

### 编译工件缓存

- `compileDirectJit` 新增 `createArtifactCache()`、`createSession(binding, cache?, artifactCache?)`、`clearArtifactCache(cache)` 与 `artifactCacheStats(cache)`。工件缓存保存不可变指令模板、共享常量池、稳定电阻槽，以及按完整入口源码排序的分片源/未绑定工厂 LRU。
- 指令模板键包含规范 IR、逻辑 `pc`/`nextPc`、延时、代码依赖及规范化绑定描述（状态/内存/引脚表排序、辅助函数、`directTiming`、`memoryLengths`/`codeMemories`、split/分片策略）。常量池只追加，达到 `64 Ki` 值或 `4 Mi` 字符上限时整体重置并推进 generation；分片源缓存随 generation 失效。
- 限制沿用并明确：指令模板 `256` 项/`4 Mi` 源码字符，分片源/工厂 `128` 项/`4 Mi` 字符、单项 `64 Ki` 字符。活动会话与续体在淘汰后仍持有已编译函数。
- 统计覆盖 `compiledInstructions`、`reusedInstructions`、`reusedShardSources`、`createdFactories`、`reusedFactories`、`evictions`、`clears`、当前指令/分片条目数与源码字符数。运行时会话还暴露 `directArtifactInstructionHits`、`directArtifactInstructionMisses`、`directArtifactShardSourceHits`、`directArtifactFactoryCompiles`、`directArtifactFactoryReuses`、`directArtifactEntries`。
- `JitOptions.shareDirectArtifacts` 仅在显式 `true` 时让同进程注册共享模块级工件缓存；省略或 `false` 时每个注册创建独立缓存，只在本注册内复用，保持原生产默认。

### 两级执行与晋升

- `JitOptions.directTier?: { promoteAfter: number }` 仅在 `throughput` 和既有 Direct 准入条件内生效；`promoteAfter` 必须为正安全整数。省略时保持即时 Direct。
- 每个本地 PC 记录 `generic`/`promoted` 状态，只统计成功完成的真实通用指令；暂停或失效后缀、元数据刷新、轮询以及折叠跳过的轮次不计数。达到阈值后在下一次边界优先复用已存在的 Direct 工件；尚未晋升的 PC 继续走共享通用体。
- 字节写入清空晋升记录；重叠翻译按 `body` 身份、`nextPc` 与 `codeVersion` 对账，不一致时撤销旧路由。统计包括 `directPromotionGenericRuns`、`directPromotions`、`directTierFallbacks`、`directPromotedRoutes`、`directPromotionResets`。

### 翻译身份与当前限制

- `translationIdentity` 要求 `abi` 与 `configuration` 均为非空字符串；`markTranslationDependencies` 报告影响结果的借用字节区间，运行时校验偏移/长度为非负安全整数且落在本次视图内，空区间有效，并记录 `invalidRange`/`outsideView`。
- 当前只完成身份与依赖范围的校验和诊断，尚未将依赖字节内容匹配到编译工件或模拟器翻译缓存。因此跨实例复用目前覆盖编译器指令模板与分片工厂，不覆盖按内容匹配的整块翻译结果。

## 验证

在 Node `v24.20.0` 下执行并通过：

```bash
pnpm --filter @mica-js/compiler typecheck
pnpm --filter @mica-js/compiler test
pnpm --filter @mica-js/device-model typecheck
pnpm --filter @mica-js/device-model test
pnpm --filter @mica-js/simulator typecheck
pnpm --filter @mica-js/simulator test:runtime
pnpm --filter @mica-js/simulator test
pnpm typecheck
pnpm typecheck:conformance
pnpm typecheck:implementation
pnpm test:generated:unit
pnpm --filter @mica-js/simulator build
```

- 编译器：typecheck 通过，`148/148` 项测试通过。
- 器件模型：typecheck 通过，`43/43` 项测试通过。
- 模拟器：typecheck 通过；运行时 vitest `128/128` 项通过；完整 `test`（含 V8 基准解析）`243/243` 项通过。
- 工作区：`pnpm typecheck` 全部包通过；`typecheck:conformance` 与 `typecheck:implementation` 通过；生成用例 `30/30` 项通过。
- 模拟器构建成功。

## V8 基准

环境：同一机器、Node `v24.20.0`；基线 `6c76ee3` 与候选分别构建，交错运行 `A/B`，`taskset` 绑定奇数核，每轮一个独立工作负载进程，共 3 轮。测量期间有其他无关 vitest 作业运行，因此只把结果视为区间。每个样本通过 `pnpm --filter @mica-js/simulator bench:v8-optimize --workload <stress|gpio-blink> --quiet` 采集。

| 工作负载     |                  基线墙钟 |                  候选墙钟 |
| ------------ | ------------------------: | ------------------------: |
| `stress`     | 1791–1833 ms（中位 1806） | 1749–1842 ms（中位 1831） |
| `gpio-blink` | 1189–1200 ms（中位 1194） | 1184–1194 ms（中位 1189） |

分片形状未退化：`stress` 仍为 116 个分片函数（58 step + 58 resume），最大函数 47,333 字符，最大字节码 27,869 B，`tooBigToBeOptimized=false`；`gpio-blink` 仍为 16 个分片函数，最大函数 21,974 字符，最大字节码 13,155 B。两组差异落在该主机的噪声范围内，本次不主张速度收益。

独立板仓库 `mica-devices` 不在本工作区，未取得 CT107D 的 A/B 数据；因此没有真实固件的时间、命中率或首段墙钟结论。

## 限制与集成注意事项

- 板侧 `mica-devices` 变更独立发布。CT107D 必须用 `service`/`blocked` 声明 `directTiming`，按测量结果选择 `shareDirectArtifacts` 与 `directTier`，并在每次翻译（含板级缓存命中）重新提交 span/loop 标记。
- span 终结成员限定为非 `isolated`、非 `stop`、无 guard 的普通写；loop 尾部只允许 `directTiming` 的 `elapsed` 更新。
- 分片内顺序落入 loop 环头的路径可能按普通轮次执行，不再进入折叠包装器；结果正确，但该路径不加速。
- `markTranslationDependencies` 目前只做范围校验，不与工件做内容匹配。
- 工件常量池达到上限时整体重置，既有会话继续使用已编译函数，但相关模板/分片源需要重新发射。
- `shareDirectArtifacts` 默认关闭；`directTier` 省略时仍是即时 Direct。

## 建议后续

在 `mica-devices` 中用 `provincial-11-first-half`、`national-5-event-recorder`、`national-3-access` 做交错 A/B，先核对完整轨迹、状态与发布时刻一致，再分别比较“只开时间合块/循环”“只开工件复用/晋升”和组合；根据真实命中率与首段/热段墙钟决定生产默认值。
