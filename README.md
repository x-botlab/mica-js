# Mica

Mica 是一套基于 TypeScript 的电路仿真与可视化编辑工具集，把原理图、电路运行和交互式面板连接起来，可用于构建浏览器中的电路实验、教学演示和自定义器件仿真应用。

项目提供原理图编辑器、画布编辑器、器件仿真运行时和扩展脚本的沙箱环境。各部分可以独立嵌入现有应用，也可以组合使用；[Playground](apps/playground/) 展示了它们协同工作的完整示例。

## 特色

- **原理图与交互面板联动**：在原理图中放置器件、连线和配置属性，再用画布上的按钮、电位器、指示灯等 widget 与仿真器件交互。
- **可扩展的器件与 widget**：器件通过 JSON 声明引脚、属性和电气资源，配对 JavaScript 描述行为；应用可以提供自己的器件库和 widget 包。
- **虚拟时间驱动的仿真**：支持单步、批量执行与复位，不依赖墙上时钟决定电路行为。参考解释器与 JIT 为同一份程序提供不同执行方式。
- **真实的电阻网络求解**：支持显式电压源、电阻、有限内阻 GPIO、上下拉和双向理想触点，可观察节点电压与支路电流，而不只是传播布尔电平。
- **隔离运行扩展脚本**：提供沙箱与跨边界通信能力，供宿主隔离运行器件和 widget 脚本。
- **按需组合的包结构**：编辑器、仿真器、文档模型和运行基础设施分别提供，应用自行掌握界面集成、器件来源与文档持久化。

当前电气模型以线性电阻网络为主，尚不覆盖完整 SPICE 模拟器的非线性器件与储能元件瞬态分析。仿真包不内置具体器件库，示例器件由 Playground 提供。

## 本地体验

需要 Node.js `^20.19.0 || >=22.12.0`。pnpm 版本由仓库的 `packageManager` 固定。

```bash
corepack enable pnpm
pnpm install
pnpm --filter @mica-js/playground dev
```

打开终端输出的地址，在侧栏选择原理图或画布示例。现有示例包括 MCU 指示灯、按键与继电器、电位器调光，以及电阻上拉后由按键接地熄灯。

## 包

| 包                                                       | 职责                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@mica-js/ir`](packages/ir)                             | 领域无关 IR：建图、存储、静态校验、参考解释器与 JIT 执行                    |
| [`@mica-js/core`](packages/core)                         | 文档与宿主基础设施：虚拟时间、`.sch` / `.cnv` 格式、RPC、日志与生命周期     |
| [`@mica-js/simulator`](packages/simulator)               | 仿真器：统一 IR 电路编译/运行时，`DeviceSimulationHost` 契约与 sandbox 适配 |
| [`@mica-js/sandbox`](packages/sandbox)                   | 通用 JS 沙箱：iframe + Worker 隔离与离屏渲染合成                            |
| [`@mica-js/widget`](packages/widget)                     | Widget 契约与运行时：包加载、`WidgetHost`、图层与端口路由                   |
| [`@mica-js/canvas-editor`](packages/canvas-editor)       | 画布编辑器：`.cnv` 合成、交互命令与场景组装                                 |
| [`@mica-js/schematic-editor`](packages/schematic-editor) | 原理图编辑器：`.sch` 的 Canvas 渲染与交互                                   |

## 文档

接口约定见 [RFC](docs/rfc/)；各包的简要用法见对应 README。

## 开发

安装依赖后，可在仓库根目录运行：

```bash
pnpm run build         # 构建全部包（ESM + d.ts）
pnpm run test          # 运行全部包测试
pnpm run typecheck     # TypeScript 类型检查
pnpm run lint          # ESLint
pnpm run format        # Prettier 格式化
```

## 许可证

[MIT](LICENSE)
