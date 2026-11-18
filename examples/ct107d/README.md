# CT107D 整板示例（v2 文档 + 融合器件 + 工作台宿主）

CT107D 竞赛板的 Mica 示例工程。正式运行模型是 `device/` 下的统一融合器件：一个
`DeviceIR`、一个实例、一个 8051 JIT。历史 54 个器件加 J5 独立/矩阵选择器（共 55 个实例）
和 111 条网络折叠为器件内部槽，外部只保留 `VCC`/`GND`。

正式入口是仓库内的 v2 文档 [`ct107d.sch`](ct107d.sch) 和浏览器宿主
[`workbench/`](workbench/)；旧 `.sch v1`、`.cnv v1` 与板面 widget 移到
`legacy/source`/`src/widgets`，只承担生成输入、回归 oracle 和显式 legacy 命令。

本文件明确区分已验证内容与边界：自动化测试覆盖文档、宿主纯逻辑和无头运行时；浏览器
交互与视觉验收需要手动执行，未写入自动测试。

## 快速开始

需要 Node.js 24。工作区依赖的商品包（`@mica-js/editor` 的 `dist/view-environment`、
`@mica-js/sdk` 的 CLI、`examples/devices` 的器件构建）先构建一次：

```bash
pnpm --filter @mica-js/editor build
pnpm --filter @mica-js/example-devices build   # oracle、MCU 与课程固件联调需要
pnpm --filter @mica-js/example-ct107d build    # 模型 + 展示 + 文档校验 + 宿主构建
pnpm --filter @mica-js/example-ct107d workbench:dev
```

`workbench:dev` 在 `http://127.0.0.1:5180/` 启动宿主；HTML View 使用
`http://<view-id>.localhost:5180/environment/` 的独立 origin。生产构建后：

```bash
pnpm --filter @mica-js/example-ct107d build:workbench
pnpm --filter @mica-js/example-ct107d workbench:preview
```

预览地址是 `http://127.0.0.1:5181/`。两种模式都需要 `packages/editor/dist/view-environment`
中的五个环境文件；`scripts/workbench.mjs` 会把它们复制到 `workbench/public/environment`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `build` | `build:fused` → `check:document` → `build:workbench`；默认交付模型、View2D/几何、v2 文档和宿主 |
| `build:fused` | 构建 MCU、生成融合模型并 `mica build --root device`，输出 `device/dist` |
| `build:workbench` | 复制锁定的器件包/文档/View 环境并 Vite 构建宿主到 `workbench/dist` |
| `workbench:dev` | 先 `build:fused`，再启动 Vite 开发服务器（5180） |
| `workbench:preview` | 重新准备静态产物并启动 Vite preview（5181） |
| `workbench:prepare` | 只生成 `workbench/public/{device,environment,ct107d.sch,catalog.json}` |
| `check:document` | 校验正式 v2 文档的锁、实例、电源参考和固件资源；不写文件 |
| `document:init` | 显式创建正式文档；已存在时拒绝覆盖 |
| `document:lock` | 只刷新 `dependencies`，保留其它用户编辑（原子写） |
| `test` | 构建器件与融合模型后运行全部 vitest |
| `test:workbench` | 构建后只运行文档、宿主逻辑和 `createHeadlessRuntime` 用例 |
| `typecheck` | `mica prepare` 后检查 device、legacy、宿主与测试 |
| `bench` | 融合整板性能基准；需要先构建器件 |
| `build:devices` | 构建 `examples/devices` 全部统一器件包（离散 oracle 与 MCU 源） |
| `build:mcu` | 只构建 `examples/devices/iap15f2k61s2` 并写入内容身份 |
| `prepare:fused` / `check:fused` | 生成 device 类型环境 / 校验 MCU 与生成的 DDL 产物 |
| `build:legacy` | 显式构建 legacy widget、v1 原理图与画布（写入 `legacy/source`） |
| `build:widgets` | 只构建 legacy 板面 widget 到 `dist/widgets` |
| `check:legacy` | 校验 legacy v1 原理图/画布；需先完成 legacy 构建 |
| `schematic` / `canvas` | 单独校验 legacy 原理图/画布（会先构建器件与 widget） |
| `firmware` | 从 `firmware/demo.asm` 同源写出根 `assets/*.bin` 与 `device/src/assets/*.{bin,hex}` |
| `firmware:check` | 只比较三份固件资源，缺失或 stale 时退出 1；不写文件 |
| `check:fused` | 先 `firmware:check`，再校验 MCU 内容身份与生成的 DDL 产物 |
| `firmware:sim -- <hex>` | 把外部 HEX/BIN 装进 legacy 分立板联调 |
| `firmware:suite -- --list` | 可选的课程固件套件，不进入日常测试 |

## 构建产物与责任

| 路径 | 责任 |
| --- | --- |
| `device/package.json`、`device/src/**` | 统一器件清单、DDL/工厂、`geometry.json`、`body.png`、`view2d`、HTML 面板与固件资源；由器件/展示代理维护 |
| `ct107d.sch` | 正式 v2 文档，跟踪在仓库；只由 `document:init` 创建、由 `document:lock` 刷新依赖锁 |
| `workbench/index.html`、`workbench/src/**`、`workbench/vite.config.ts` | 宿主源码，跟踪在仓库 |
| `scripts/document.mjs`、`scripts/workbench.mjs` | 文档锁生成与宿主准备，不手拼摘要 |
| `device/dist/**` | 统一器件构建产物，已忽略；干净重建可复现 |
| `workbench/public/**` | 宿主准备产物（器件包、文档副本、环境、catalog），已忽略 |
| `workbench/dist/**` | 宿主生产构建，已忽略 |
| `legacy/source/{ct107d.sch,ct107d.cnv,ct107d.netlist.json}` | legacy v1 生成输入与 oracle；不是正式入口 |

`scripts/document.mjs` 的签名模式：

- `--check`：默认；验证当前 `ct107d.sch` 与 `device/dist/release.json` 一致，并推导拓扑。
- `--write`：生成新文档；目标已存在时拒绝，必须显式 `--force` 才会覆盖。
- `--refresh-lock`：只替换 `dependencies`，保留实例摆放、`viewLayout`、属性等用户编辑。

浏览器中的“保存”只写 `localStorage`（键 `mica-ct107d-workbench-document-v1`），“恢复演示”
重新读取仓库内 `ct107d.sch` 的构建副本；两者都不会覆盖跟踪文档。

## 正式 v2 文档

`ct107d.sch` 的结构：

- `version: 2`，恰好一个实例；
- 实例 UUID 固定为 `7d9e3a1c-5b2f-4c8d-9e01-2a3b4c5d6e7f`，器件为
  `example:ct107d-board`；
- `dependencies` 由 `@mica-js/sdk/fused/node` 的 `readDirectoryPackage` 读取
  `device/dist/release.json` 生成真实版本与 `sha256:...` 发布摘要，不手写摘要；
- `VCC` 接 5 V `power` 参考、`GND` 接 0 V `ground` 参考；
- 实例 `properties.firmware = { mode: "package", src: "assets/ct107d-demo.hex" }`；
  默认时钟显式设为 12 MHz，与演示固件一致；
- 不包含额外 nodes/wires/labels，正式板只通过两个外部电源引脚连接。

`document:init` 生成的文档只包含一个稳定实例；后续器件包发布变化后运行
`document:lock`，不要重新生成整个文档，以免覆盖用户在编辑器里调整的摆放或视图布局。
`readDirectoryPackage` 与 `openDevicePackage` 会先验证清单、文件摘要、发布身份和宿主 API
范围，再读取固件字节。

## 工作台宿主

`workbench/src/main.ts` 使用 `@mica-js/editor/fused` 的 `createWorkbench`，沿用了
`examples/fused-workbench` 与 `apps/playground/src/workbench-demo.ts` 的宿主模式：

- 宿主构建 `DeviceRegistry`，从 `catalog.json` 找到与文档锁定完全一致的发布，再按包路径
  fetch 字节；编辑器自己执行摘要与清单校验；
- 独立 origin 的 HTML View 环境由 `workbench/public/environment` 提供；
- 主题为深石墨 + 青绿强调，薄工具栏只放保存、重开、恢复演示，不覆盖工作台自身工具条；
- 运行/编辑、侧栏和浮动视图仍由工作台自己的 UI 管理；
- 显式传入固定 `step: toTimePs(16, 'ms')`。编辑器默认的 10 µs 步长在宿主每次让出后只推进
  极少虚拟时间，无法呈现可见的动态扫描；16 ms 与预览基准的 16/64 ms 共同检查点一致，控制
  响应也可接受。这是宿主选择，不修改 `packages/**` 的默认值。

生命周期与并发（`workbench/src/session-controller.ts`）：

- 打开、重开、保存都进入同一个串行队列；在 replace 已排队时，保存不会落在旧模型上；
- 最新的打开请求胜出；较早请求在创建完成后立即 dispose，不产生第二个会话；
- `reopen` 先验证/读取草稿，成功后才推进 session token；没有草稿或 draft 损坏时旧会话
  仍然可保存，不会被新 token 误判为过期；
- 释放失败会 latch `host/dispose-failed`，停止创建新会话并保留错误可见性，不把半释放
  状态报告为成功；
- `pagehide` 捕获当前/进行中的文档并释放；bfcache 的 `pageshow` 会恢复同一文档，而不是
  留下一个 inert 页面；
- 错误显示在宿主顶部错误条，同时工作台诊断事件也进入同一错误条。

宿主只提供包内固件资源，不实现资产库或程序项目 Provider；需要这些来源时应补宿主
Provider，而不是在模型或文档里绕过校验。视图布局、保存/重开属于宿主能力；HTML View 的
容器、面板和 View2D 的交互分别由器件展示代码与编辑器负责。

浏览器验收边界：当前自动化测试不启动浏览器，也不断言截图、缩放/旋转、bfcache 实际行为、
多指按键或面板视觉效果；这些需要人工打开 dev/preview 验证。已验证的是文档/包校验、宿主
session 状态机（mock create）、无头运行时与 legacy oracle。

## 无头运行时

`test/workbench-runtime.test.ts` 直接读取正式 `device/dist`，通过
`createDirectoryRegistry` 和 `createHeadlessRuntime` 验证：

- 准备阶段：真实发布锁定、包摘要、文档拓扑；缺包/锁不符/文件摘要不符可见失败；
- 启动与首帧：创建后暂停在 0 ps，查询 `getSnapshot`；首次 `step` 后产生模型事件；
- 固定步进：以 1 ms 步长推进到 64 ms，与 `bench/board.ts` 的 55 器件离散 oracle 比较
  **聚焦子集**：DS1/DS2 段码、U6–U9 锁存、D1–D8 亮度与电压；该断言不声称所有模型信号
  等价，完整行为基线仍由 `test/fused-*` 负责；
- BIN 与 HEX：同一包内两种格式产生相同信号轨迹；
- reset：重建会话、回零、旧客户端失效；
- resume/pause/step 状态约束。

“一个实例、一个 JIT”由 `bench/` 的正式 dist 夹具断言，不在无头运行时里重复读取私有
实现。`test/document-official.test.ts` 验证正式文档与真实发布锁；`test/workbench-host.test.ts`
覆盖 catalog 校验、浏览器草稿序列化和串行队列；`test/workbench-session.test.ts` 用 fake
create 覆盖 reopen 失败保留旧会话、旧 session 保存拒绝、stale open 清理、保存排队、
suspend/resume、释放失败 latch 与关闭顺序。

## 器件与模型

`device/` 是统一器件包：

- 清单：`publisher: example`、`name: ct107d-board`、`engines.mica: ^1.0.0`；
- 属性：`firmware`（`program`，memory loader，`bin`/`hex`，`code` 地址空间
  `[0, 61440)`、默认装载地址 0、可空）、`clockFrequency`、`ultrasonicDistanceCm`、
  `uartBaud`；
- 引脚只有 `VCC`/`GND`，与 `geometry.json`、`model.ddl` 完全一致；
- 构建：`device/scripts/generate.mjs` 从 `legacy/source/ct107d.sch` 与
  `legacy/source/ct107d.netlist.json` 生成 `src/{model.ddl,nets.ts,channels.ts}`，
  `mica build --root device` 输出自包含 `device/dist`；
- 执行：复用 `examples/devices/iap15f2k61s2` 的 8051 translator，整板只有一个 JIT；
- 展示：`View2D` 在照片上绘制数码管、LED、按键/跳线反馈；HTML 面板提供传感器、装配、
  串口与状态查询。

统一接口：

- 事件：`onDidSignal`（`{designator, port, value}`）、`onDidBytes`
  （`{designator, port, data}`）、`onDidAmplifier`（`{position, gain, outputVoltage}`）
  以及 MCU 的 `onDidUart1Tx`/`onDidUart1Rx`；
- 方法：`setSwitch`、`setJumper`、`setHallField`、`setWiper`、`setAmplifierInputs`、
  `setIrCarrier`、`setTemperature`、`setAnalogInput`、`sendUart`、`getSnapshot`、
  `getAmplifier`、`getEeprom`、`getRtc`、`readSerial`、`getSerialStatus`。

边界：

- J13/J5 是三针选择器。`setJumper({closed:true})` 为默认 2-3 位置：J13 `WR` 接地
  （IO），J5 S4–S7 独立接地；`false` 为 1-2，分别让 `WR` 跟随 P42、让 S4–S7 接 P44
  矩阵。切换立即重算当前按住的键。
- J2 的 VS1838/CX20106A 选择、`setIrCarrier` 的 `LD1`/`U11`/`U20` 显式目标保持
  独立；不会隐式同时驱动三个源。
- PCF8591 AIN2 仍是独立输入，不隐式绑定 LM324 输出；LM324 的滑臂/增益/输出按
  `RB4` 公式计算并钳到 0–5 V。
- UART 探针默认 9600 baud，观察队列容量为 4096 条单字节消息；单批溢出显式
  `CHANNEL_OVERFLOW`，跨批历史仍按 cursor/`droppedTotal` 裁剪。
- 板内网络是理想数字融合，不模拟任意外部模拟接线、电气竞争、电源电流或电磁兼容。
  `VCC`/`GND` 是唯一外接引脚。

## Legacy 边界与 oracle

`legacy/source/ct107d.sch`、`legacy/source/ct107d.netlist.json` 与
`legacy/source/ct107d.cnv` 仍是 **v1** 文档，不是 RFC 0024/0025 的融合文档：

- `build-schematic.mjs` 用统一器件包清单合成 v1 符号，输出 `.sch` 与网表；
- `build-canvas.mjs` 用照片像素坐标生成背景图、17 个按键、2 片数码管、8 个 LED、
  蜂鸣器、继电器与 J13/J2 热区；
- `verify-schematic.mjs` 通过 `legacy/device-package.mjs` 把统一工厂接到旧 simulator；
- `verify-canvas.mjs` 校验绑定、对位、widget 绘制和按键网络；
- `bench/board.ts` 是 55 器件 correctness oracle，不进入性能计时；
- `src/widgets` 是旧板面 widget，仅由显式 `build:widgets`/`build:legacy` 构建。

默认 `build`/`test` 不构建 legacy widget；需要旧画布/host 校验时：

```bash
pnpm --filter @mica-js/example-ct107d build:legacy
pnpm --filter @mica-js/example-ct107d check:legacy
```

`verify-firmware.mjs` 仍可把外部 HEX/BIN 装进 55 器件 oracle 做联调；它不替代正式
`ct107d.sch` 的无头运行验证。

## 验证

```bash
pnpm --filter @mica-js/example-ct107d typecheck
pnpm --filter @mica-js/example-ct107d test:workbench
pnpm --filter @mica-js/example-ct107d test
pnpm --filter @mica-js/example-ct107d bench
```

`test/fused-preview.test.ts`、`test/fused-firmware.test.ts`、`test/fused-inputs.test.ts`、
`test/fused-startup.test.ts`、`test/fused-resistance.test.ts`、`test/seg4-preview.test.ts`
继续用离散 oracle 覆盖融合模型行为；`test/widgets.test.ts` 覆盖 legacy widget 源码。
`test/view2d.test.ts` 与 `test/panel.test.ts` 由展示代理维护。

## 基准

`bench/` 只对正式 `device/dist` 计时，`bench/board.ts` 只做 correctness 对照：

```bash
pnpm --filter @mica-js/example-ct107d bench
```

口径为装配 → `runUntil(0)` → 预热 → 固定测量窗口，读取进程 CPU 时间；断言
`instances === 1`、`jits === 1`、`devices === 1`、`nets === 2`，并保留
`topicDigest`/检查点稳定性作为行为不变锚点。融合后没有板内电气网络，`solves` 与
`electricalPublishes` 为 0 是设计结果；工作量由 JIT、边界、事件、直接调用与检查点共同
约束。绝对读数以每次 `PERF` 输出为准，不在 README 中固化。

## 目录

```text
examples/ct107d/
  ct107d.sch                    正式 v2 单一实例文档（跟踪）
  device/                       统一融合器件工程
    package.json                清单：program firmware、时钟、串口、View2D、HTML view
    mica.config.ts              统一器件构建：manifest + model
    src/model.ddl               生成的单 DeviceIR
    src/model.ts / index.ts     模型入口与工厂
    src/geometry.json           flexible 1068×768 几何与 VCC/GND 锚点
    src/body.png                板面照片（PNG）
    src/view2d.ts               板面叠层与交互
    src/panel/                  HTML 控制面板
    src/assets/                 ct107d-demo.{hex,bin}
    dist/                       构建产物（忽略）
  workbench/                    浏览器宿主
    index.html
    vite.config.ts              sandbox/widget worker 插件
    src/main.ts                 串行 open/save/reopen、错误与清理
    src/catalog.ts              catalog 解析与包文件 URL
    src/document-store.ts       localStorage 草稿
    src/serial-queue.ts         宿主操作串行化
    src/session-controller.ts   open/save/reopen 与 pagehide/pageshow 状态机
    src/host.css                实验仪表风格
    public/                     生成产物（忽略）
    dist/                       Vite 构建（忽略）
  scripts/document.mjs          正式文档生成/锁刷新/校验
  scripts/workbench.mjs         宿主准备、dev、build、preview
  legacy/source/ct107d.sch      legacy v1 原理图（生成输入/oracle）
  legacy/source/ct107d.netlist.json
  legacy/source/ct107d.cnv      legacy v1 画布
  src/widgets/                  legacy 板面 widget
  bench/board.ts                55 器件离散 oracle
  bench/fused.ts                正式 dist 融合夹具（1 实例/1 JIT）
  test/workbench-runtime.test.ts 真实 dist 无头运行时
  test/document-official.test.ts 正式文档与锁
  test/workbench-host.test.ts   catalog/草稿/串行队列
  test/workbench-session.test.ts 宿主 open/save/reopen 状态机（fake create）
```

## 与基准原理图的差距

- J3/J7 排针未完整建模；`hall`/`lm324` 的板外端口仍以网标表示。
- `ultrasonic` 实例位号沿用 `U22`，与基准中数码管扩展排针的位号存在冲突。
- LED 位号沿用生成器的 `D1`–`D8`，基准丝印为 `L1`–`L8`。
- 复位电路的 CR1/R3、74HC138 的 Y0–Y3、NE555 RC 脚等按 NC/理想化处理。
- 照片上的多指同时按键不在单条 View2D 输入合同内；需要多键组合时使用 HTML 面板的
  保持状态。
