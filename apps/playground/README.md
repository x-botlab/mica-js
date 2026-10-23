# @mica-js/playground

Mica 各包的可交互示例站点：React + Vite + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com/)，哈希路由单入口，页面直接引用 workspace 包源码。

```bash
pnpm --filter @mica-js/playground dev        # http://localhost:5173
pnpm --filter @mica-js/playground run test   # vitest：纯逻辑（画布属性/绑定面板模型）
pnpm --filter @mica-js/playground run typecheck
pnpm --filter @mica-js/playground run build
pnpm --filter @mica-js/playground run test:e2e   # Playwright 冒烟，自带 4174 端口的 dev server
```

## 页面

| 路由                   | 页面         | 演示内容                                                                                                 |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `#/`                   | 概览         | 页面导航、workspace 命令速查                                                                             |
| `#/canvas`             | 画布         | `createCanvasScene`：demo widget 包、组件列表、拖动实例、运行模式与发布日志、宿主属性/绑定面板、草稿保存 |
| `#/schematic`          | 原理图编辑器 | `@mica-js/schematic-editor`：器件库、宿主属性面板（#7 全部属性类型）、显示开关、回调事件流               |
| `#/schematic?readonly` | 只读查看器   | 同一页以 `readOnly: true` 挂载：选择与缩放可用，编辑全部被拒                                             |
| `#/sandbox`            | 沙箱         | `@mica-js/sandbox`：guest 代码编辑、启动/终止、调用与日志                                                |
| `#/simulator`          | 仿真         | `@mica-js/simulator`：按钮 / 继电器 / 教学 MCU 三场景、启动/暂停/步进/复位、事件轨迹、电气观测与诊断     |

新增页面：在 `src/components/app-shell.tsx` 的 `PAGES` 里加一项（`id` 同时是路由），在 `src/App.tsx` 里渲染对应组件即可。

## 目录

```text
e2e/canvas.spec.ts             Playwright 冒烟：实例渲染、拖动提交命令、运行模式发布与浏览、属性面板、组件列表与草稿
e2e/editor.spec.ts             Playwright 冒烟：渲染、网标拖动折线、导线 T 接入、只读守卫
e2e/simulator.spec.ts          Playwright 冒烟：sandbox 按钮驱动触点、能力/拒绝、确定性回放、暂停/复位、换场景无残留、窄屏
playwright.config.ts           e2e 配置（webServer 跑 127.0.0.1:4174 的 dev server）
src/canvas/panel-model.ts      纯逻辑：候选端点过滤、属性初值/「已覆盖」、绑定选项、错误消息
src/canvas/palette.ts          组件列表：从 widget 包生成条目、新实例的默认尺寸与级联位置
src/canvas/layers.ts           图层列表：文档数组 ↔ 自上而下的显示顺序、拖动落点换算出 `set-z`
src/canvas/persist.ts          草稿保存：序列化去重、去抖写入、失败重试
src/canvas/panel-model.test.ts vitest（node）覆盖上述纯逻辑
src/components/app-shell.tsx   侧边导航 + 顶栏 + 主题切换
src/components/canvas-inspector.tsx  画布的宿主属性/绑定面板（按 widget 定义渲染控件）
src/components/property-panel.tsx  原理图页的属性面板（state.inspector → controller）
src/components/ui/             shadcn/ui 组件（button / card / badge / input / textarea / separator）
src/lib/router.ts              哈希路由（useHashRoute / navigate）
src/lib/utils.ts               cn()
src/pages/canvas.tsx           画布页：demo widget 包 + .cnv + WidgetHost → CanvasScene + 面板
src/pages/home.tsx             概览
src/pages/schematic.tsx        原理图编辑器页：挂载编辑器并把宿主 UI 接上
src/pages/sandbox.tsx          沙箱页：createSandbox + 调用 + 日志
src/pages/simulator.tsx        仿真页：三场景、工具栏、事件轨迹、电气观测、能力与诊断
src/sim/devices.ts             器件 provider：按 ?raw 读取 packages/device/examples 的已提交 JSON/JS 配对
src/sim/symbols.ts             场景符号（UUID v4 + 位号 S1/K1/U1）
src/sim/board.ts               宿主侧电路：拓扑、电源域与引脚意图
src/sim/scenarios.ts           三场景：原理图 + 板级接线 + 探针 + 输入 + 限制 + 回放脚本
src/sim/session.ts             无 DOM 的会话层：执行器、宿主接线、探针采样、轨迹、诊断、确定性回放
src/sim/trace.ts               轨迹条目、载荷描述、虚拟时间格式化与轨迹摘要
src/sim/session.test.ts        vitest（node）覆盖加载、能力、拒绝、暂停语义与重复加载一致性
src/schematic/sample.ts        器件注册表（含 designatorPrefix 与 #7 属性描述）、示例 .sch
src/schematic/snippets.ts      编辑器页「用法」面板里的代码片段
public/assets/                 示例资源：ct107d-board.webp（画布底图）、panel.png（image）与 firmware/m4-demo.bin（binary）
public/widgets/                demo widget 包（package.json + image/segment/button）与示例 demo.cnv
public/devices/                demo 器件包：demo.sch（原理图）、demo-mcu.json（描述）与 demo-mcu.js（IR 实现）
src/index.css                  Tailwind + shadcn 主题 token（:root / .dark）
```

画布页的左侧栏是**组件列表 + 图层列表**：组件条目来自 `public/widgets/package.json`（`loadWidgetPackage` 读出来的 `displayName` + 宿主给的默认尺寸），点击即发一条 `add-instance`，新实例按对角偏移级联摆放并置顶，运行模式下列表禁用。图层列表按**绘制顺序自上而下**列出当前文档的实例（`src/canvas/layers.ts` 负责把文档数组反过来），点一行调 `scene.setSelection` 选中它，拖动一行落到另一行即发一条 `set-z`（目标 `z` 是 `count - 1 - 显示下标`）。

画布页的右侧栏是**宿主 UI**：属性控件按 `provider.resolve(ref).definition.properties` 渲染，绑定下拉按 `definition.ports` 渲染，值一律通过 `host.applyCommand` 提交，被拒时把 `SchematicError.diagnostics` 的 message 显示在对应控件下方。可选端点来自**正在运行的仿真**（`DeviceSimExecutor.getTopics()`），`src/canvas/panel-model.ts` 只负责按方向互补 + 载荷类型相等过滤候选；下拉的**标签用位号**（`U1.display`），提交的值仍是符号 id（`0000000d-…:display`），因为绑定存的是 id。

**仿真**跑在页面同一条 JS 线程上：`src/pages/canvas.tsx` 用 `createDeviceSimExecutor({ devices })` 建执行器（器件来自 `public/devices/`，`demo:<name>` → `<name>.json` + `<name>.js`），再把它作为 `simulation` 传给 `createWidgetHost`，于是器件发布按 `bindings` 直接投到 widget、widget 发布按绑定直接投给器件，页面里没有一行转发代码。画布文档通过 `schematic: "devices/demo.sch"` 声明它模拟的原理图，页面启动时读这个 `.sch`、`parseSchematic` 后交给 `loadSchematic`；运行模式用 100 ms 的定时器每次 `advance(0.1 s 虚拟时间)`，切换模式时 `executor.reset()` 让器件与 widget 一起回到 t=0。

**保存**走 `src/canvas/persist.ts`：每次提交 `serializeCanvas(document)` 与上一次成功的文本比较，不同才在 300 ms 去抖后写入 `localStorage`（键 `mica-playground:canvas-draft`）；`保存` 按钮与 `Ctrl/Cmd+S` 跳过去抖立即写，`导出` 把当前文档下载成 `demo.cnv`，`重置草稿` 清掉草稿并 `host.loadDocument` 回示例。重新打开页面时优先读草稿，控件旁的徽章显示 `已保存` / `未保存` / `保存失败`。

示例 `demo.cnv` 用真实的 CT107D 开发板照片（`public/assets/ct107d-board.webp`，1068 × 768）当底图，坐标就是照片像素：两颗 4 位数码管组件各盖住照片里的一个 LED 窗口，分别绑到 `demo.sch` 里那颗 MCU 符号（位号 `U1`）的 `display` / `display2`；按键组件盖住 S7 那颗独立按键并绑到它的 `key`。按键是全透明的，所以编辑模式下编辑器给每个实例画的一圈半透明边框（`theme.outline`）就是它唯一的位置线索。`public/devices/demo-mcu.js` 是示例器件：IR 每 0.1 s 走一个 `tick`，把计数经 output 交给 JS 侧 `api.publish` 成两串显示值；按下 `key` 时它把计数清零，于是按键到器件的方向也能在数码管上看到。

`demo:segment` 的属性是位数、颜色、笔画粗细（占字高比例）与位间距（数位格子留白比例）；小数点的大小与它和数字的距离各有一个属性（`pointSize` / `pointGap`，都按字高比例，`pointSize` 为 0 时不画）。点画在数字右侧，不占数字本身的宽度，`value` 里的 `.` 只点亮前一位的点。`demo:button` 支持文本（可留空）、圆角、背景颜色（普通/按下，接受 `#RRGGBBAA`，可全透明）与背景图片（普通/按下，图片优先于颜色，按 cover 裁切）；示例里把颜色设成全透明，于是按下时只透出一层半透明白。

画布页的「编辑 / 运行」按钮 `await scene.setMode(...)`：**切换模式会重置全部 widget**（实例按当前文档重建，guest 不重新求值模块），因此按钮在重置期间禁用并显示「重置中…」，运行模式的定时投递也会在切换前先停下，避免向正在销毁的实例投递。模式切换完成后 `executor.reset()` 把仿真也拉回 t=0，widget 与器件始终描述同一次运行。

## 仿真页

`#/simulator` 是 `@mica-js/simulator` 的交互调试台：用 `?raw` 读取 `packages/device/examples` 里已提交的 JSON/JS 配对，经 `parseDeviceDescription` + `loadDeviceModule` 加载，页面里不重写调度器或芯片算法。

| 场景          | 内容                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 理想按钮      | 触点 A–B 接在 VCC 与下拉的 `board.SENSE` 之间；画布上的 `demo:button` 在 `@mica-js/sandbox` 里发布 `press`，经 `WidgetHost` 投递到 `S1.pressed` |
| 按钮 → 继电器 | 按钮触点把 VCC 送到 `K1.IN`/`board.COIL`，继电器在同一个 patch 内切换 COM–NO / COM–NC；触点侧由独立 `LOAD` 供电                                 |
| 教学 MCU      | 合成 ISA 只在块边界写 `GPIO`，经板级 `SENSE` 读出；`updateResources: ['firmware']` 授权 `firmwarePatch` 的 8 B 单元更新                         |

**宿主接线。** 执行器只透传 `pinHost` / `topology`（`DeviceSimExecutorOptions.host`），电路归本页所有：

- `src/sim/board.ts` 给出三块板的 `TopologyDefinition`、`PowerDefinition` 与引脚意图；
- 每次 `loadSchematic` / `reset()` 都用该运行时自己的调度器建 `createPowerRuntime`，实例销毁后再 `power.destroy()`；
- 探针（`connectionState` / `sampleDigital`）在轨迹里标为「电气观测」，并写明「宿主直读」——这些值不是器件发布。

**工具栏。** `启动` / `暂停` 按 16 ms 墙钟节拍推进固定 10 ns 虚拟时间片；`单步` 只推进一片；`复位` 调 `executor.reset()`（按当前原理图重建实例、时钟归零），**不是**器件 reset 生命周期；`销毁` 释放执行器与 widget 宿主；`确定性回放 ×2` 用固定脚本各加载一次新会话并比较轨迹摘要。

**能力与拒绝。** 能力面板按器件描述列出引脚/连接/端口，并在一次性调度器上探测模型自己的 `reset`：`ideal-button` 接受，`ideal-relay` / `teaching-mcu` 以 `device/lifecycle-unsupported` 拒绝。所以「复位」按钮永远只是重建实例，模型不支持的复位、没有的端口都直接显示为「不支持 / 无话题端口」，不会用空实现冒充。

**错误语义。** 器件层拒绝载荷时 `advance` 抛出但执行器仍是 `ready`（时钟不推进）——页面记成 `bench/delivery-rejected` 诊断；只有调度器故障才会置 `faulted`、暂停运行循环并禁用推进。MCU 页的「发送非法载荷（应被拒绝）」就是这条路径的现场演示。

### 本地运行

```bash
pnpm --filter @mica-js/playground dev     # http://localhost:5173/#/simulator
pnpm --filter @mica-js/playground test    # vitest：src/sim/session.test.ts
pnpm --filter @mica-js/playground run test:e2e   # 含 e2e/simulator.spec.ts
```

`playwright.config.ts` 会自己起 4174 端口的 dev server，e2e 不需要先手动启动。

## 主题

`index.css` 用 shadcn 的 oklch token；顶栏切换 `.dark` 类。原理图页同时把 `@mica-js/schematic-editor` 的主题（`DARK_SCHEMATIC_THEME` / `LIGHT_SCHEMATIC_THEME`）传给编辑器，使 Canvas 与页面 chrome 一起切换。

## 别名

`vite.config.ts` 与 `tsconfig.json` 各自声明了同一组别名：

- `@/*` → `src/*`（shadcn 约定）
- `@mica-js/core`、`@mica-js/core/canvas`、`@mica-js/core/schematic`、`@mica-js/ir`、`@mica-js/device`、`@mica-js/simulator`、`@mica-js/canvas-editor`、`@mica-js/widget`、`@mica-js/schematic-editor`、`@mica-js/sandbox` → 对应包的 `src`，所以改包源码后刷新即生效，无需先构建。Vite 的别名按前缀匹配，`@mica-js/core` 必须排在 `@mica-js/core/canvas` / `@mica-js/core/schematic` **之后**，否则会把它们一起吞掉。
