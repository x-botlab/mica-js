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
├── apps/       # 应用
└── packages/   # 可发布的库，如 @mica/core
```

## 开发路线

当前开发阶段：**优先实现 `@mica/core` 的虚拟时间与确定性事件调度器**，再逐步加入数字网络求解、Peer、CPU 解释器和 JIT。

1. `@mica/core`：虚拟时间与确定性事件调度器
2. 数字网络求解
3. Peer
4. CPU 解释器
5. JIT

## 开发

```bash
pnpm install
```

> 若未全局安装 pnpm，可使用 `corepack pnpm <command>`，或先执行 `corepack enable pnpm`。

## 许可证

[MIT](LICENSE)
