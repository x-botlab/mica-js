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
│   └── sandbox-playground/   # 沙箱演示与手测面板
└── packages/
    ├── core/                 # @mica/core：仿真内核
    ├── ir/                   # @mica/ir：IR 模型、建图、校验、标量语义、实例存储与参考解释器
    └── sandbox/              # @mica/sandbox：iframe + Web Worker 通用 JS 沙箱
```

`@mica/ir` 当前提供内存 IR 模型、同步类型化建图器、静态校验/链接诊断、整数/布尔及浮点逐指令求值、实例存储和参考解释器。解释器固定并校验模块快照，复用既有标量与存储语义，执行基本块、循环、普通调用及多结果返回，提供确定预算与调用链诊断；不推进时间或创建事件，未实现的领域指令明确拒绝。尚无事件执行、Provider 或资源版本化更新语义。职责边界、非目标与验证方式见 [packages/ir/README.md](packages/ir/README.md)。

## 沙箱

`@mica/sandbox` 用于在相对隔离的环境中运行不可信的第三方代码（仿真器内核、2D Widget 等）：宿主页面 → `sandbox="allow-scripts"` iframe（不透明源）→ classic Web Worker → 客户代码。客户代码无 DOM、无存储、无网络，死循环不阻塞 UI 且可强制终止；渲染采用「客户离屏渲染 + 宿主合成 `ImageBitmap`」。

```ts
import { createSandbox } from '@mica/sandbox';

const sandbox = await createSandbox({
  source: { type: 'module', code: guestSource },
  capabilities: { draw: (commands) => render(commands) },
  canvas: document.querySelector('canvas'),
});

await sandbox.call('start');
```

默认的 `srcdoc` 模式会继承宿主 CSP，严格 CSP 站点请改用 `frameUrl` 模式。宿主 CSP 要求、API、离屏渲染与安全边界详见 [packages/sandbox/README.md](packages/sandbox/README.md)，可运行演示见 [apps/sandbox-playground](apps/sandbox-playground)。

## 开发路线

当前开发阶段：**优先实现 `@mica/core` 的虚拟时间与确定性事件调度器**，再逐步加入数字网络求解、Peer、CPU 解释器和 JIT。

1. `@mica/core`：虚拟时间与确定性事件调度器
2. 数字网络求解
3. Peer
4. CPU 解释器
5. JIT

## 开发

环境要求：Node.js `^20.19.0 || >=22.12.0`，pnpm 由 `packageManager` 固定版本（`corepack enable pnpm` 即可）。

```bash
pnpm install
pnpm run build       # 构建所有包（Vite library mode，输出 ESM + d.ts）
pnpm run test        # 运行所有包测试（Vitest）
pnpm run typecheck   # TypeScript 类型检查
pnpm run lint        # ESLint
pnpm run format      # Prettier 格式化
```

Vite / Vitest / vite-plugin-dts 的版本通过 [pnpm catalog](pnpm-workspace.yaml) 统一管理，子包中用 `catalog:` 引用。CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，会依次执行格式检查、lint、类型检查、构建与测试。

## 许可证

[MIT](LICENSE)
