# @mica-js/playground

Mica 各包的可交互示例站点：React + Vite + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com/)，哈希路由单入口，页面直接引用 workspace 包源码。

## 页面

| 路由                   | 页面       | 演示内容                                                                                         |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `#/`                   | 概览       | 页面导航与命令速查                                                                               |
| `#/canvas`             | 画布       | `createCanvasEditor`：demo + lab widget 包、组件 / 图层列表、拖动实例、运行模式、属性 / 绑定面板 |
| `#/schematic`          | 原理图     | `@mica-js/schematic-editor`：6 个示例图纸、器件库、属性面板（全部属性类型）、显示开关            |
| `#/schematic?readonly` | 只读查看器 | 同一页以 `readOnly: true` 挂载：选择与缩放可用，编辑全部被拒                                     |
| `#/sandbox`            | 沙箱       | `@mica-js/sandbox`：页面加载即启动 guest，代码编辑、重新运行 / 终止、调用与日志                  |

新增页面：在 `src/components/app-shell.tsx` 的 `PAGES` 里加一项（`id` 同时是路由），在 `src/App.tsx` 里渲染对应组件。

## 运行

```bash
pnpm --filter @mica-js/playground dev            # http://localhost:5173
pnpm --filter @mica-js/playground run build
pnpm --filter @mica-js/playground run typecheck
pnpm --filter @mica-js/playground run test       # vitest：纯逻辑（画布面板模型、器件包、widget 包）
pnpm --filter @mica-js/playground run test:e2e   # Playwright 冒烟，自带 4174 端口的 dev server
pnpm --filter @mica-js/playground run build:devices  # 改 demo.sch 布局后重算导线端点与网表
```

`playwright.config.ts` 会自己起 4174 端口的 dev server，e2e 不需要先手动启动。

## 目录

```text
e2e/                          Playwright 端到端用例
src/canvas/                   画布页纯逻辑：面板模型、组件列表、图层顺序、草稿保存
src/components/               app-shell、画布属性面板、原理图属性面板、shadcn/ui 组件
src/lib/                      哈希路由与 cn()
src/pages/                    四个页面组件
src/schematic/                示例图纸（sheets/*.sch → 文档）、器件注册表与代码片段
src/devices/                  Playground 专用器件（ADC / DAC / 电位器 / EEPROM / 矩阵 / 595 / 电源 / 串口）
src/widgets/                  Playground 专用 widget 包 `lab`（电位器 / 电源开关 / 文本 / 图像 / 动画）
public/assets/                示例资源（画布底图、image / binary 属性）
public/widgets/               demo widget 包与示例 demo.cnv
public/devices/               demo 器件包（push-button / counter-4bit / hex-display）与 demo.sch
scripts/build-device-demo.mjs 重算 demo.sch 的符号坐标与导线端点
```

## 画布页

```mermaid
flowchart LR
  pkg["public/widgets<br/>demo 包"] --> provider["WidgetProvider"]
  lab["src/widgets<br/>lab 包"] --> provider
  provider --> host["WidgetHost"]
  cnv["demo.cnv"] --> host
  sch["devices/demo.sch"] --> sim["DeviceSimExecutor"]
  dev["public/devices<br/>器件包"] --> sim
  host --> scene["CanvasEditor"]
  sim -->|"simulation"| host
  scene --> ui["组件列表 / 图层列表 / 属性面板"]
  ui -->|"applyCommand"| host
```

- **左侧栏**是组件列表与图层列表。组件条目来自 `public/widgets/package.json` 与 `src/widgets/manifest.json`（demo 包 + lab 包），点击即发一条 `add-instance`，新实例按对角偏移级联摆放并置顶；运行模式下列表禁用。图层列表按绘制顺序自上而下排列，点一行选中它，拖动一行落到另一行即发一条 `set-z`。
- **右侧栏**是宿主 UI：属性控件按 `provider.resolve(ref).definition.properties` 渲染，绑定下拉按 `definition.ports` 渲染，值一律通过 `host.applyCommand` 提交，被拒时把诊断 message 显示在对应控件下方。
- 可选端点来自**正在运行的仿真**（`getTopics()`），面板只按方向互补 + 载荷类型相等过滤候选；下拉标签用位号（`U2.value`），提交的值仍是符号 id。
- **仿真**跑在页面同一条 JS 线程上：执行器作为 `simulation` 传给 `createWidgetHost`，器件发布按 `bindings` 直接投到 widget，widget 发布按绑定直接投给器件，页面里没有转发代码。运行模式用 100 ms 的定时器每次 `advance` 0.1 s 虚拟时间。
- **保存**：每次提交把 `serializeCanvas(document)` 与上一次成功的文本比较，不同才在 300 ms 去抖后写入 `localStorage`；`保存` 按钮与 `Ctrl/Cmd+S` 跳过去抖立即写，`导出` 下载当前文档，`重置草稿` 恢复示例。

`demo.sch` 是一条真电路：`S1`（按钮）的 A 端接 `U1`（4 位计数器）的 `CLK`，B 端接地；`U1` 的 `Q0..Q3` 接到 `U2`（数码管驱动）的 `D0..D3`；两颗芯片的 `VCC` / `GND` 接到图纸上的 5 V 与 GND 符号。按钮闭合把 `CLK` 拉到地产生下降沿，计数加一；`U2` 采样后把半字节发布成 `value` / `bits`。

## 原理图页

`#/schematic` 把 `src/schematic/sheets/*.sch` 里的示例直接挂进 `@mica-js/schematic-editor`：左侧「示例」列表切换图纸，`?demo=<id>` 可直接打开某个示例，`?readonly` 以只读查看器挂载。

| 示例        | 内容                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| 综合器件    | 内置图纸：string / number / binary / image / enum / color / boolean 属性、标签与电源符号 |
| 模拟电压    | `pin.writeAnalog` / `pin.sampleAnalog` + 电压环回                                        |
| I²C EEPROM  | SCL / SDA 开漏 + 弱上拉，ACK 拉低 SDA                                                    |
| 并行总线    | `pinGroup` 批量读写 Q0–Q7 / ROW / DATA                                                   |
| 电源域      | `powerDomains` 门控驱动与采样                                                            |
| Widget 高级 | 串口端点 + textInput / assets.loadImage / tick                                           |

- **器件注册表**：`src/schematic/demos.ts` 把内置样例、`packages/device/examples` 的 `mica:` 描述与 `src/devices` 的 `lab:` 包描述注册成一个 registry；编辑器只按引用查符号，页面不重复写引脚。
- **图纸来源**：示例用 `?raw` 读取 `.sch`，`parseSchematic` 后 `mountSchematicEditor`；改图纸不用改页面。
- **Playground 专用器件**（`src/devices/`）：每个 `lab:` 器件同时导出包描述（引脚、引脚组、端口）和统一 IR 描述（真实电气行为），因此不会与公共包产生耦合。`devices.test.ts` 直接用 `Circuit` 编译并运行每个器件，其中 `power domains` 用例覆盖 `Circuit.turnOn` / `turnOff`。
- **Playground 专用 widget**（`src/widgets/`）：`lab` 包以 `?raw` 打包成 `PackageFiles`，和 `public/widgets` 的 `demo` 包一起交给 `createPackageWidgetProvider`，画布页的组件列表同时来自两个清单。`widgets.test.ts` 会解析清单、加载每个模块并动态 `import` 一次实现源码。
- **画布资源**：`createWidgetHost` 带 `assets` provider，`file` 引用按 base URL 抓取、`inline` 引用在本侧 base64 解码，沙箱里只调 `api.assets.loadImage`。

## 主题与别名

`index.css` 用 shadcn 的 oklch token，顶栏切换 `.dark` 类；原理图页同时把编辑器的深 / 浅主题传给画布，使 Canvas 与页面 chrome 一起切换。

`vite.config.ts` 与 `tsconfig.json` 各自声明同一组别名：

- `@/*` → `src/*`（shadcn 约定）
- `@mica-js/*` → 对应包的 `src`，改包源码后刷新即生效，无需先构建。Vite 的别名按前缀匹配，`@mica-js/core` 必须排在 `@mica-js/core/canvas` / `@mica-js/core/schematic` **之后**，否则会把它们一起吞掉。
