# Mica

基于 TypeScript 的电路仿真与编辑器 monorepo。各包可以独立组合；[Playground](apps/playground/) 提供交互示例。

## 包

| 包                                                       | 职责                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@mica-js/ir`](packages/ir)                             | 领域无关 IR：建图、存储、静态校验、参考解释器与 Provider 产物               |
| [`@mica-js/core`](packages/core)                         | 文档与宿主基础设施：虚拟时间、`.sch` / `.cnv` 格式、RPC、日志与生命周期     |
| [`@mica-js/simulator`](packages/simulator)               | 仿真器：统一 IR 电路编译/运行时，`DeviceSimulationHost` 契约与 sandbox 适配 |
| [`@mica-js/sandbox`](packages/sandbox)                   | 通用 JS 沙箱：iframe + Worker 隔离与离屏渲染合成                            |
| [`@mica-js/widget`](packages/widget)                     | Widget 契约与运行时：包加载、`WidgetHost`、图层与端口路由                   |
| [`@mica-js/canvas-editor`](packages/canvas-editor)       | 画布编辑器：`.cnv` 合成、交互命令与场景组装                                 |
| [`@mica-js/schematic-editor`](packages/schematic-editor) | 原理图编辑器：`.sch` 的 Canvas 渲染与交互                                   |

开发构建使用 `source` 条件读取 workspace 源码；发布时 `publishConfig.exports` 指向 `dist`。

## 文档

接口约定见 [RFC](docs/rfc/)；各包的简要用法见对应 README。

## 开发

环境要求：Node.js `^20.19.0 || >=22.12.0`，pnpm 由 `packageManager` 固定版本（`corepack enable pnpm` 即可）。

```bash
pnpm install
pnpm run build         # 构建全部包（ESM + d.ts）
pnpm run test          # 运行全部包测试
pnpm run typecheck     # TypeScript 类型检查
pnpm run lint          # ESLint
pnpm run format        # Prettier 格式化
```

Vite、Vitest 与 vite-plugin-dts 的版本通过 [pnpm catalog](pnpm-workspace.yaml) 统一管理，子包以 `catalog:` 引用。

## 许可证

[MIT](LICENSE)
