# CT107D 全固件测试套件

这是**opt-in**工具，不进入日常 `vitest`，因为输入是未跟踪的
`dist/蓝桥杯单片机程序` 课程资料。工具只引用外部 HEX/源码，不复制它们；HEX 由
`scripts/firmware-hex.mjs` 的严格解析器读取。

## 前置

```bash
pnpm --filter @mica-js/example-ct107d build:fused
```

`build:fused` 会构建 `examples/devices/dist/iap15f2k61s2`、重新生成
`device/src/{model.ddl,nets.ts,channels.ts}` 并产出正式
`device/dist/{package.json,model.js}`。套件通过 `bench/fused.ts` 装载它，断言图中恰好
1 个实例、1 个 JIT。

需要 Node.js 24（原生 TypeScript type stripping 用于直接导入 `bench/fused.ts`）。

## 运行

```bash
# 列出清单/覆盖情况（不运行）
node scripts/test-firmware-suite.mjs --list
node scripts/test-firmware-suite.mjs --dry-run

# 最小代表
node scripts/test-firmware-suite.mjs --only ct107s-ds18b20,ct107s-uart,ct107s-btn

# 全 26 项目，串行隔离进程
node scripts/test-firmware-suite.mjs

# 有界并行（默认 1，最大 8）
node scripts/test-firmware-suite.mjs --jobs 4

# 指定输入/输出
node scripts/test-firmware-suite.mjs \
  --root /path/to/蓝桥杯单片机程序 \
  --out /tmp/opencode/ct107d-suite-run
```

默认输入是仓库内 `dist/蓝桥杯单片机程序`；默认输出是
`/tmp/opencode/ct107d-firmware-suite/<UTC 时间戳>-<pid>/`，不会写入 tracked 源码。

退出码：`0` 全部 `behavior-pass`；`1` 有 behavior/error fail；`2` 有 blocked；`3`
清单/工具/输出目录错误；`4` 只有 `behavior-partial`（部分行为已证实，但仍有
limited/notCovered，不是完成通过）。

`behavior-pass` 必须同时满足：结构 guard（ready、无 fault、1 instance、1 JIT、时钟）
通过，且至少一个真实功能断言通过、没有非 limited 的功能断言失败、没有
limited/notCovered。`behavior-partial` 表示有功能通过但仍有未覆盖/不可表达分支；
**任何实际执行过且期望不符的普通功能断言都是 `behavior-fail`**，不因已知模型限制降级。
已确认但可归因的失败在报告中带 detail/notes，状态仍是 fail。

## 产物

```
summary.json          运行级汇总、覆盖计数、artifact/manifest 哈希、耗时
manifest.snapshot.json 本次运行冻结的 manifest（子进程统一读取此快照）
results.jsonl         每个项目一行完整结果
report.md             可读报告：逐项状态、场景、断言、观察量、失败/限制
projects/<id>.json    完整单项目结果（含 timeline、checkpoint、EEPROM/信号/UART 观察）
```

每个结果记录（`summary`/`projects/*.json`）：

- 固件来源：相对路径、原文件 SHA-256、规范化 image SHA-256、数据字节/记录数/地址范围；
- 源程序身份：`mainSource`、全部 `.c/.h` 聚合 SHA-256、逐文件哈希；
- uvproj：大小、SHA-256、`<Cpu>...CLOCK(n)` 原值（不作为时钟依据）；空 uvproj 也记录；
- clock：采用值 + 源码证据字符串；
- uartBaud：实际配置值 + 来源（`scenario.props` 或 property default；旧 artifact 不支持声明时直接失败）；
- 场景：props、event 时间线（含实际仿真注入时间）、断言、notes、limitations；
- simTime、CPU/wall 分段、JIT 工作量、话题/信号/bytes/UART/显示更新观察量；
- 结构 guard：`board-ready`、`no-faults`、`single-instance`、`single-jit`、
  `clock-frequency`，单独计数，不能由功能断言替代；
- 功能 assertion 与 guard 分开计数；逐断言 expected/actual/detail、limited 标记；
- `notCovered` 分支列表；
- 全部观察状态：最终显示段码/文本、锁存器、温度、PCF8591、RTC、UART、EEPROM、
  时间检查点。

## HEX 严格性

`firmware-hex.mjs` 按 `examples/ct117e-m4/test/firmware.ts` 的严格等级实现 8051 60 KiB
通用版本：记录长度、checksum、EOF、EOF 后记录、记录类型 00/01/02/03/04/05、地址范围、
数据重叠（含同值重复）、reset vector、空数据、最小向量长度。任何异常直接抛错并把项目记为
`error`，不会 skip、截断或 last-writer-wins。

`--dry-run`/正式运行都会扫描 root 下全部 `.uvproj`/`.hex`，要求 manifest 100% 覆盖；
存在未声明 HEX 时退出 3，防止漏项。

## 场景约定

- 时钟逐项由源码注释/重装载值推导。`uvproj` 里多数是 `CLOCK(35000000)` 模板值，3 个
  项目 uvproj 为 0 字节，均不能盲用。
- 独立按键/矩阵按键按源码扫描方式选择 J5：矩阵源在 0 ms 发送
  `setJumper({designator:'J5',closed:false})`（1-2 matrix，S4–S7 common 接 P44）；
  独立源保持默认 `closed:true`（2-3 independent，common 接 GND），不要给独立源加 J5 事件。
  矩阵行是 P30–P33，列是 P44(S4–S7)、P42(S8–S11)、P35(S12–S15)、P34(S16–S19)。
  矩阵场景同时在 0 ms `J3=false`，避免 NE555 强驱动 P34；频率场景按源码再接回 J3
  （national-7 150 ms、practice 200 ms），随后按源断开。
- J13 保持默认 `true`（2-3 IO，只把 74HC02 的 WR 侧接地，**不得拉低 P42**）；
  `J13=false` 是 WR→P42 的 memory 选择，本套件不要切换。不为了过测拔其他跳线。
- 普通按键 hold 60–80 ms，断言放在释放后至少一个扫描/消抖周期；practice S12 的
  `key_down_tt` 只在 Timer2 的 1 ms `smg_tt` 块内累加，`>=500` 是 500 ms。长按取
  700–900 ms（manifest 用 800 ms），必须 <1000 ms 以避免第二次触发；释放消抖后再发下
  一条命令。80 ms 短按在释放分支清掉未处理的 `key_long` 是源码正常合同，不是 UART
  首字符问题。
- 频率断言按源码 gate 状态计时，不按全局整数秒或 NE555 组件频率反推：practice 的
  `fre_tt` 只在 `display_mode==1` 累加且 `TR0` 初值为 0，约 1.0 s 首门只启动计数、
  约 2.0 s 才是首个完整 1 s 窗；national-7 的 S5 释放才从 main loop 启动 `TR0`，
  Timer2 全局 1 ms tick 已经在跑，首窗约 999.55 ms（±50 us）只是异步 warmup，会在
  2100/2800 ms 显示 4808；2900 ms 断言的是第二个完整 1000 ms 稳态窗，仍严格
  `4809/4810`。J3 在 3000 ms 断开；2827–3827 ms 是混合窗，第一次完整零窗在
  3827–4827 ms，因此 `0000` 断言放 5100 ms、runMs 5200 ms。warmup 非 1 s 不是放宽
  期望，绝不能把 4808 加入允许值。
- 整板 UART probe baud 由 `scenario.props.uartBaud` 设置，manifest 必须声明实际使用值：
  `ct107s-uart` 9600、`practice`/`national-5` 1200、`national-10` 4800。值的类型/范围以
  `device/dist/package.json` 的 `uartBaud` property 声明为准；缺省时用该 property 的
  default。旧 artifact 没有 `uartBaud` property 而 manifest 已声明时必须直接报错，
  **不能静默回退 9600**。9600 是整板缺省值；`ct107s-uart` 源码实际约 9585 baud，
  9600 probe 可接受，note 记录实际 baud 而不改名义 12 MHz clock。
- UART assertion 可用 `equalsChannel` 对两个通道做整段字节相等比较；它不做前缀或长度
  近似，用于证明 MCU 日志与 probe 解码是同一字节流。actual 会记录对端的
  `referenceHex`/`referenceLength`，报告可独立审计完整字节，而不仅看 `equal`。
  用于证明通信成功时，必须在相同 `atMs` 另有一条 source-derived、非空的
  `ascii`/`length` 断言；纯空流相等仍可用于专门的无输出测试，但不作为通信成功证据。
- practice 长 S12 在 6500 ms 的完整报告必须同时满足：`uart1Tx` length=49、
  包含 `08:59:` 前缀与完整第二行，且 `probeTx.equalsChannel = uart1Tx`。49 是 source
  长度，不因当前 actual 截断或 `%2x` 空格 padding 而调整。
- PCF8591 查询 `pcf8591.output` 是归一化 DAC 0..1（源码原码需 ÷255）；ADC 输入在
  `pcf8591.analog[]`。
- 显示段码是**点亮段掩码**（bit0=a…bit7=dp），不是源码 common-anode TAB 原码。
- DS18B20 源程序若先发 Convert T 后立即读，750 ms 前的旧值单独断言；转换完成后的值单独
  断言，不把旧值当模型 bug。
- `scenario.limitations` 记录**当前确实不可表达/无法刺激**的路径（例如 1200/4800 baud
  探针不兼容）；这类 assertion 才标 `limited: true`，实际值仍记录，但不冒充 pass。
  P3/P4 端口、J5 键盘列或 J13 已建模后，不得再以“模型没有该端口”为 limitation。
- `scenario.notCovered` 记录**未测试**的分支；不写 assertion，不能算通过。
- 任何可表达路径实际执行后与源码期望不符，就是普通 fail；不能改成 limited/optional。
- 断言 schema 在运行前 fail-fast：所有断言 id 唯一、时间安全整数、display 恰为 4 个
  字符/4 个 0..255 mask、uart channel/hex 格式合法、rtc/uart 不得空 checker、
  比较子不得为空；`compareValue` 无比较子直接失败。

## 维护

- 新增/删除课程项目：更新 `firmware-suite.manifest.json` 并跑 `--dry-run`；覆盖扫描会
  拒绝漏项。
- 时钟证据：保留 `clockEvidence` 与 `sourceEvidence` 行号；遇到源码/HEX 行为明显不一致
  （例如 `provincial-11-first-half` 的 HEX 发 `0x2A` 并显示 1234/5678，而 main.c 是电压/
  计数），用 `overrideStatus: {status:"blocked", reason}` 标记 source/HEX mismatch，保留
  运行证据，不把责任推给模型。
- `overrideStatus` 只允许 `blocked`，必须绑定已知错误 HEX 的
  `expectedHexSha256` 与源聚合 `expectedSourceAggregateSha256`；运行时 hash 不匹配、
  基础状态不是 `behavior-fail`、或 guard 失败/run error 时不应用 override，不会吞掉
  新错误，也不会把换成正确 HEX 的工程永久 blocked。
- 输出目录必须为空；父进程用 random run token 校验每个 child 结果，拒绝旧结果文件；
  child timeout/crash/无 JSON 时生成该项目的 error 结果并继续其余项目。stdout/stderr
  只保留最后 64 KiB。
- RTC 只写时分秒的源码用时间后缀断言，不强行要求日期 2026；EEPROM 的 BCD 字段用
  `bcd: true` 解码后比较（`0x57` 解码为 57，不是 87）。
- 源码把浮点写入 `unsigned char` DAC 时按截断后的原码比较：例如 provincial-12 的
  30 ℃ 线性值 `127.5` 写入 127，期望 `127/255 ≈ 0.498039`，不能用 0.5±0.03 的粗容差把
  128/255 收进来。源码显示 bug（如 25.02/24.02/30.03）按原样断言，不纠正。
- `scenario.notes` 会进入报告；实现推导和按键时序写在 notes，状态只由 assertion/
  limitation/notCovered 决定。
- 工具自测（不需要外部课程资料）：

```bash
pnpm --filter @mica-js/example-ct107d firmware:suite:tool
```
