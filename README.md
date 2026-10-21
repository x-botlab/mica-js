# Mica

Mica 是一个基于 TypeScript/JavaScript 开发的高性能、模块化、开源电路仿真引擎，采用 pnpm Monorepo 组织。

## 核心特性

- **仿真内核**：采用离散事件调度，使用 `Number` 表示整数皮秒虚拟时间，保证时序准确性与确定性。
- **Peer 机制**：自动识别兼容器件接口，建立绕过网络求解器的专用高速通信通道。
- **CPU 仿真**：计划支持 8051、ARM Cortex-M0/M3/M4 等架构。
- **JIT 优化**：通过架构无关 IR 将 MCU 指令动态编译为 JavaScript，利用 V8 优化执行性能，并复用通用 JIT 后端。
- **架构设计**：核心、CPU、JIT、具体指令集和调试模块解耦，支持插件化扩展。

## 仓库结构

采用 pnpm workspace 管理：

```text
.
├── apps/
│   ├── playground/           # 各包示例站点（原理图编辑器、沙箱）
│   └── sandbox-playground/   # 沙箱演示与手测面板
└── packages/
    ├── core/                 # @mica-js/core：仿真内核
    ├── schematic-editor/     # @mica-js/schematic-editor：Canvas 原理图编辑器
    └── sandbox/              # @mica-js/sandbox：iframe + Web Worker 通用 JS 沙箱
```

## 原理图编辑器

`@mica-js/schematic-editor` 把 `@mica-js/core/schematic` 的 `.sch` 文档渲染成可编辑的 Canvas 画布：给一个容器元素即可挂载，画布交互与悬浮工具条在包内，属性面板等宿主 UI 通过 `state.inspector` 与 controller 自行实现，主题、显示选项、视口与历史通过返回值控制。

```ts
import { mountSchematicEditor } from '@mica-js/schematic-editor';

const editor = mountSchematicEditor({
  container: document.querySelector('#host'),
  schematic,
  devices, // 器件外形由宿主的 DeviceSymbolProvider 提供
  onChange: (state) => setStatus(state),
});

editor.placeDevice('stm32-package:stm32g431rbt6-lqfp64'); // 抓到光标上，下一次点击落地
```

宿主 API、器件放置与回调时序见 [packages/schematic-editor/README.md](packages/schematic-editor/README.md)，可运行示例见 [apps/playground](apps/playground)。

## 沙箱

`@mica-js/sandbox` 用于在相对隔离的环境中运行不可信的第三方代码（仿真器内核、2D Widget 等）：宿主页面 → `sandbox="allow-scripts"` iframe（不透明源）→ classic Web Worker → 客户代码。客户代码无 DOM、无存储、无网络，死循环不阻塞 UI 且可强制终止；渲染采用「客户离屏渲染 + 宿主合成 `ImageBitmap`」。

```ts
import { createSandbox } from '@mica-js/sandbox';

const sandbox = await createSandbox({
  source: { type: 'module', code: guestSource },
  capabilities: { draw: (commands) => render(commands) },
  canvas: document.querySelector('canvas'),
});

await sandbox.call('start');
```

默认的 `srcdoc` 模式会继承宿主 CSP，严格 CSP 站点请改用 `frameUrl` 模式。宿主 CSP 要求、API、离屏渲染与安全边界详见 [packages/sandbox/README.md](packages/sandbox/README.md)，可运行演示见 [apps/sandbox-playground](apps/sandbox-playground)。

## Playground

[apps/playground](apps/playground) 是各包的可交互示例站点：React + Vite + Tailwind v4 + shadcn/ui，哈希路由单入口，页面直接引用包源码。目前包含概览、原理图编辑器（含宿主驱动器件放置与回调事件流）与沙箱（guest 代码执行与调用日志）三个页面。

```bash
pnpm --filter @mica-js/playground dev
```

新增页面只需在 `src/components/app-shell.tsx` 的 `PAGES` 里加一项，并在 `src/App.tsx` 中渲染对应组件。

## 开发路线

当前开发阶段：**优先实现 `@mica-js/core` 的虚拟时间与确定性事件调度器**，再逐步加入数字网络求解、Peer、CPU 解释器和 JIT。

1. `@mica-js/core`：虚拟时间与确定性事件调度器
2. 数字网络求解
3. Peer
4. CPU 解释器
5. JIT

## 开发

环境要求：Node.js `^20.19.0 || >=22.12.0`，pnpm 由 `packageManager` 固定版本（`corepack enable pnpm` 即可）。

```bash
pnpm install
pnpm run build        # 构建所有包（Vite library mode，输出 ESM + d.ts）
pnpm run test         # 运行所有包测试（Vitest）
pnpm run test:e2e     # Playground 冒烟测试（Playwright，自带独立端口的 dev server）
pnpm run typecheck    # TypeScript 类型检查
pnpm run lint         # ESLint
pnpm run lint:package # 包产物检查（publint + arethetypeswrong）
pnpm run format       # Prettier 格式化
```

Vite / Vitest / vite-plugin-dts 的版本通过 [pnpm catalog](pnpm-workspace.yaml) 统一管理，子包中用 `catalog:` 引用。CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，会依次执行格式检查、lint、类型检查、构建、单元测试与 Playground 的 Playwright 冒烟测试。

## 许可证

[MIT](LICENSE)
