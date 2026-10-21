# @mica-js/playground

Mica 各包的可交互示例站点：React + Vite + Tailwind v4 + [shadcn/ui](https://ui.shadcn.com/)，哈希路由单入口，页面直接引用 workspace 包源码。

```bash
pnpm --filter @mica-js/playground dev        # http://localhost:5173
pnpm --filter @mica-js/playground run typecheck
pnpm --filter @mica-js/playground run build
pnpm --filter @mica-js/playground run test:e2e   # Playwright 冒烟，自带 4174 端口的 dev server
```

## 页面

| 路由                   | 页面         | 演示内容                                                                                   |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `#/`                   | 概览         | 页面导航、workspace 命令速查                                                               |
| `#/schematic`          | 原理图编辑器 | `@mica-js/schematic-editor`：器件库、宿主属性面板（#7 全部属性类型）、显示开关、回调事件流 |
| `#/schematic?readonly` | 只读查看器   | 同一页以 `readOnly: true` 挂载：选择与缩放可用，编辑全部被拒                               |
| `#/sandbox`            | 沙箱         | `@mica-js/sandbox`：guest 代码编辑、启动/终止、调用与日志                                  |

新增页面：在 `src/components/app-shell.tsx` 的 `PAGES` 里加一项（`id` 同时是路由），在 `src/App.tsx` 里渲染对应组件即可。

## 目录

```text
e2e/editor.spec.ts             Playwright 冒烟：渲染、网标拖动折线、导线 T 接入、只读守卫
playwright.config.ts           e2e 配置（webServer 跑 127.0.0.1:4174 的 dev server）
src/components/app-shell.tsx   侧边导航 + 顶栏 + 主题切换
src/components/property-panel.tsx  宿主实现的属性面板（state.inspector → controller）
src/components/ui/             shadcn/ui 组件（button / card / badge / input / textarea / separator）
src/lib/router.ts              哈希路由（useHashRoute / navigate）
src/lib/utils.ts               cn()
src/pages/home.tsx             概览
src/pages/schematic.tsx        原理图编辑器页：挂载编辑器并把宿主 UI 接上
src/pages/sandbox.tsx          沙箱页：createSandbox + 调用 + 日志
src/schematic/sample.ts        器件注册表（含 designatorPrefix 与 #7 属性描述）、示例 .sch
src/schematic/snippets.ts      编辑器页「用法」面板里的代码片段
public/assets/                 示例资源：panel.png（image）与 firmware/m4-demo.bin（binary）
src/index.css                  Tailwind + shadcn 主题 token（:root / .dark）
```

## 主题

`index.css` 用 shadcn 的 oklch token；顶栏切换 `.dark` 类。原理图页同时把 `@mica-js/schematic-editor` 的主题（`DARK_SCHEMATIC_THEME` / `LIGHT_SCHEMATIC_THEME`）传给编辑器，使 Canvas 与页面 chrome 一起切换。

## 别名

`vite.config.ts` 与 `tsconfig.json` 各自声明了同一组别名：

- `@/*` → `src/*`（shadcn 约定）
- `@mica-js/core/schematic`、`@mica-js/schematic-editor`、`@mica-js/sandbox` → 对应包的 `src`，所以改包源码后刷新即生效，无需先构建。
