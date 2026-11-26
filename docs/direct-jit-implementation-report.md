# Direct JIT 增量编译与代码地址别名复用：实现与验收记录

对应计划：[direct-jit-implementation-plan.md](./direct-jit-implementation-plan.md)（基线 `81aad0c`）。

## 实现摘要

### #277 按需编译与增量派发

- `@mica-js/compiler` 新增 `compileDirectJit.createSession(binding, cache?)`。
  - 每个会话只生成一次固定派发器；派发器通过可变的 `Map<pc, step>`、`Map<resume, resumeFn>`、拒绝集合和隔离集合工作。
  - `add` 按翻译批次原子提交入口；`remove`、`clear`、`updateDelays` 分别处理撤销、清空和延时描述变化。
  - 已封存分片原样复用；开放尾片吸收新入口。入口重编译分配新的续跑 ID，旧挂起帧继续使用旧函数。
  - 会话统计覆盖批次、路由安装/删除、分片发射/复用、指令体发射/复用、派发器/分片/辅助函数源码字节和 `emitStats`。
- `@mica-js/simulator` 运行时改为每个 JIT 一个固定会话：
  - 首次 Direct 从当前翻译缓存装入；此后每次翻译批次增量 `add`。
  - Direct 返回 `untranslated` 时，在当前尚未开始指令的边界翻译并重试一次；已结算前缀交给调度器，避免跳过 reaction/钩子/轮询。
  - 代码写入、metadata 刷新、入口屏障代际变化走 stale：无挂起立即释放，有挂起只完成旧后缀一次。
  - 钩子改写 PC 后按最终 PC 重新确认 metadata/codeVersion。
  - `directCompiles` 只在固定派发器安装时增长；新增 `directSessions`、`directRoutes`、`directShardCompiles`、`directRouteInstalls/Removals`、`directDispatchMisses`、`directGenericInstructions` 与四类源码字节统计。
- CT107D/CT117E-M4/ILI9325/STM32G431 探针迁移到新结构，并保留对已发布 `@mica-js/simulator@2.8.0` 的兼容读取。

### #308 代码地址别名复用

- 宿主合同新增 `JitTranslateInput.markDirectBodyShareable?` 与 `JitOptions.shareDirectBodies?`（默认关闭）。
- CT117E-M4 将 `0x08000000` 声明为同一 Flash 的附加 `codeRegions` 窗口；取指、literal、IT 上下文、HAL 轮询和忙等延时按 region-local 偏移计算，服务 PC 保持主 `code` 回退。
- 编译器新增 `DirectJitInstruction.share`：
  - 按 `storage + codeVersion + offset + byteLength` 归组；
  - 结构比较校验后的 IR（`Object.is` 数字语义、嵌套区域、资源名、源码位置）和 delay 指纹；`nextPc` 作为路由参数；
  - 等价入口使用同一个共享 step/resume 闭包，各自保留逻辑 PC、`nextPc` 与续跑归属；
  - `isolated`、IR/delay/上下文不一致均拒绝并分类。
- 运行时校验标记（未知 PC、重复、长度、region/view、service、Direct 准入），非法标记只取消共享资格；统计候选、组、共享体、共享路由和拒绝分类。
- CT117E-M4 增加默认关闭的 `directBodySharing` 属性；关闭时不向旧模拟器写出未知字段。

## 正确性验证

```bash
pnpm --filter @mica-js/compiler typecheck
pnpm --filter @mica-js/compiler test
pnpm --filter @mica-js/simulator typecheck
pnpm --filter @mica-js/simulator test:runtime
pnpm --filter @mica-js/simulator test
pnpm typecheck:conformance
```

- 编译器：128 项通过。
- 模拟器运行时：98 项通过；完整模拟器测试（含 V8 基准解析）243 项通过。
- 符合性类型检查通过。

## 性能 A/B

环境：Node `v24.20.0`，同一机器。A/B 为独立工作树构建，基线 `81aad0c`，候选为本次增量会话实现。

### 模拟器 V8 基准

`pnpm --filter @mica-js/simulator bench:v8-optimize --workload <workload> --cycles 2000000 --quiet`

| 指标 | 基线 stress | 候选 stress | 基线 gpio-blink | 候选 gpio-blink |
| --- | ---: | ---: | ---: | ---: |
| wallMs | 2,685 | 2,699 | 1,825 | 1,403 |
| generated programs | 24 | 59 | 16 | 9 |
| stepShards（累计发射） | 15 | 58 | 7 | 8 |
| totalCharacters（累计） | 478,794 | 1,589,202 | 134,176 | 149,396 |
| 最大分片函数字符 | 47,333 | 47,333 | 21,974 | 21,974 |
| 最大字节码 | 27,869 | 27,869 | 13,155 | 13,155 |
| `tooBigToBeOptimized` | false | false | false | false |
| 固定派发器字符 | 7 个（823–4,854） | 940 | 7 个 | 940 |

候选的常驻分片数与派发器字节码符合预期：`stress` 常驻 8 个分片、`directCompiles=1`、`directRoutes=233`。累计生成字符上升来自开放尾片在每个翻译批次重建；这是增量装片的已知成本，不改变常驻分片数、最大函数体积或 V8 可优化性。

### CT107D 冷启动（首个 200 µs）

使用 `boards/ct107d/dist/model.js` 与本地构建的 simulator；同一进程 5 轮，含首轮冷态。历史探针口径可能不同，数值仅作回归参考。

| 固件 | 基线装配 ms | 候选装配 ms | 基线首个推进 ms | 候选首个推进 ms |
| --- | ---: | ---: | ---: | ---: |
| `ct107d-demo.bin`（70 B） | 123.0 | 131.1 | 20.3 | 14.3 |
| `digital-display-dynamic.bin`（2,421 B） | 123.4 | 119.7 | 77.1 | 85.0 |

候选在 2,421 B 固件上：`directCompiles=1`（基线 18）、`directFallbacks=0`（基线 106）、`directShardCompiles=84`、`directRouteInstalls=686`、`directGenericInstructions=0`、固定派发器 965 字符。首个 200 µs 的真实 `fallbackRate` 为 0；装配中位数约 120 ms，低于计划中的 150 ms 目标。首个推进墙钟与基线处于同一量级，未观察到显著冷启动收益，因为发布版 2.8.0 已包含常驻分片和重建步长；收益体现在固定派发器只安装一次、回退归零与增量路由。

### CT117E-M4 别名共享 A/B

使用 `sheng_12_parking.hex`、`createHarness` 和本地新运行时，属性 `directBodySharing` 关闭/开启。7 轮从冷态推进 1 ms（编译器在 `dff2c70` 后只重算受影响物理键）：

| 指标 | 共享关闭 | 共享开启 |
| --- | ---: | ---: |
| 建板中位 ms | 36.3 | 38.3 |
| 首个 1 ms 推进中位 ms | 878.8 | 815.9 |
| 首轮冷态推进 ms | 21,950 | 1,168 |
| `directShareCandidates` | 0 | 712 |
| `directSharedBodies` | 0 | 10 |
| `directSharedBytes` | 0 | 80,396 |
| 工作负载（LCD/GRAM） | 一致 | 一致 |

共享热窗口（预热 2 ms 后测 2 ms）中位：关闭 546 ms，开启 469 ms。共享开启后冷态与热态都没有退化；但当前实现先为两个逻辑入口各发射一份普通指令体，再迁移到共享体，因此 `directBodyBytes` 不降反升（新增约 80 KB 共享体源码），不满足计划中“累计生成字节下降”的启用条件。按计划“收益不足时交付诊断数据和结论，共享保持关闭”，CT117E-M4 的 `directBodySharing` 默认保持 `false`；共享实现和开关保留，后续可通过让首个候选直接使用可共享单体来消除重复发射。

## 已知限制

- 共享实现会先发射两个独立普通体，再发射一份共享体；重复路由数从 20 降到 10，但累计源码字节增加约 80 KB。当前默认关闭，不影响生产路径；后续应让首个候选直接使用可共享单体，避免重复发射。
- 开放尾片在每个 `add` 批次重新发射，累计源码字符随批次增长；常驻分片数和最大函数体积未变，V8 未出现超预算或拒绝优化。
- CT107D 历史整板夹具的完整固件与旧探针口径未复现；本文使用当前发布版板和本地 simulator 的等价入口测量。
- `sheng_12_parking.hex` 会执行到声明 region 之外的异常 PC；CT117E-M4 已恢复 legacy `pc & 0x1ffff` 翻译回退，避免空块 `JIT_FAILED`，该行为由回归测试固定。
