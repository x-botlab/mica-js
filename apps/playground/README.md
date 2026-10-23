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

| 路由                   | 页面         | 演示内容                                                                                   |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `#/`                   | 概览         | 页面导航、workspace 命令速查                                                               |
| `#/canvas`             | 画布         | `createCanvasScene`：demo widget 包、拖动实例、运行模式与发布日志、宿主属性/绑定面板       |
| `#/schematic`          | 原理图编辑器 | `@mica-js/schematic-editor`：器件库、宿主属性面板（#7 全部属性类型）、显示开关、回调事件流 |
| `#/schematic?readonly` | 只读查看器   | 同一页以 `readOnly: true` 挂载：选择与缩放可用，编辑全部被拒                               |
| `#/sandbox`            | 沙箱         | `@mica-js/sandbox`：guest 代码编辑、启动/终止、调用与日志                                  |

新增页面：在 `src/components/app-shell.tsx` 的 `PAGES` 里加一项（`id` 同时是路由），在 `src/App.tsx` 里渲染对应组件即可。

## 目录

```text
e2e/canvas.spec.ts             Playwright 冒烟：三实例渲染、拖动提交命令、运行模式发布与浏览、属性面板
e2e/editor.spec.ts             Playwright 冒烟：渲染、网标拖动折线、导线 T 接入、只读守卫
playwright.config.ts           e2e 配置（webServer 跑 127.0.0.1:4174 的 dev server）
src/canvas/panel-model.ts      纯逻辑：候选端点过滤、属性初值/「已覆盖」、绑定选项、错误消息
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
src/schematic/sample.ts        器件注册表（含 designatorPrefix 与 #7 属性描述）、示例 .sch
src/schematic/snippets.ts      编辑器页「用法」面板里的代码片段
public/assets/                 示例资源：ct107d-board.webp（画布底图）、panel.png（image）与 firmware/m4-demo.bin（binary）
public/widgets/                demo widget 包（package.json + image/segment/button）与示例 demo.cnv
src/index.css                  Tailwind + shadcn 主题 token（:root / .dark）
```

画布页的右侧栏是**宿主 UI**：属性控件按 `provider.resolve(ref).definition.properties` 渲染，绑定下拉按 `definition.ports` 渲染，值一律通过 `host.applyCommand` 提交，被拒时把 `SchematicError.diagnostics` 的 message 显示在对应控件下方。可选端点来自 `src/canvas/panel-model.ts` 的 `DEMO_TARGETS`（示例没有真实原理图，`createWidgetHost` 不传 `catalog` 时跳过引用校验）。

示例 `demo.cnv` 用真实的 CT107D 开发板照片（`public/assets/ct107d-board.webp`，1068 × 768）当底图，坐标就是照片像素：两颗 4 位数码管组件各盖住照片里的一个 LED 窗口，分别绑到 `demo-mcu.display` / `demo-mcu.display2`；按键组件盖住 S7 那颗独立按键并绑到 `demo-mcu.key`。

`demo:segment` 的属性是位数、颜色、笔画粗细（占字高比例）与位间距（数位格子留白比例），每一位都画自己的小数点，点占数位右侧单独一列，`value` 里的 `.` 只点亮前一位的点。`demo:button` 支持文本（可留空）、圆角、背景颜色（普通/按下，接受 `#RRGGBBAA`，可全透明）与背景图片（普通/按下，图片优先于颜色，按 cover 裁切）；示例里把颜色设成全透明，于是按下时只透出一层半透明白。

画布页的「编辑 / 运行」按钮 `await scene.setMode(...)`：**切换模式会重置全部 widget**（实例按当前文档重建，guest 不重新求值模块），因此按钮在重置期间禁用并显示「重置中…」，运行模式的定时投递也会在切换前先停下，避免向正在销毁的实例投递。

## 主题

`index.css` 用 shadcn 的 oklch token；顶栏切换 `.dark` 类。原理图页同时把 `@mica-js/schematic-editor` 的主题（`DARK_SCHEMATIC_THEME` / `LIGHT_SCHEMATIC_THEME`）传给编辑器，使 Canvas 与页面 chrome 一起切换。

## 别名

`vite.config.ts` 与 `tsconfig.json` 各自声明了同一组别名：

- `@/*` → `src/*`（shadcn 约定）
- `@mica-js/core/canvas`、`@mica-js/core/schematic`、`@mica-js/canvas-editor`、`@mica-js/widget`、`@mica-js/schematic-editor`、`@mica-js/sandbox` → 对应包的 `src`，所以改包源码后刷新即生效，无需先构建。
