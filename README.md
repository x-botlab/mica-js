# Mica

Mica 是一套基于 TypeScript 的电路仿真与可视化编辑工具集，把原理图、电路运行和交互式面板连接起来，可用于构建浏览器中的电路实验、教学演示和自定义器件仿真应用。

项目提供原理图与画布编辑器、器件仿真运行时和扩展脚本的沙箱环境。各部分可以独立嵌入现有应用；[Playground](apps/playground/) 使用新编辑器工厂展示文档编辑与 widget / 器件双向话题通信。

## 特色

- **原理图与交互面板联动**：在原理图中放置器件、连线和配置属性，再用画布上的按钮、电位器、指示灯等 widget 与仿真器件交互。
- **可扩展的器件与 widget**：JSON 声明展示元数据，DDL 定义器件模型；SDK 生成自包含的 JavaScript 模型与同步适配器，应用提供自己的器件库和 widget 包。
- **虚拟时间驱动的仿真**：支持单步、批量执行与复位，不依赖墙上时钟决定电路行为。DDL 和 TypeScript Builder 共用新器件模型与 JavaScript 编译后端。
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

打开终端输出的地址，在工具栏切换原理图或画布。画布切换到仿真模式并运行后，按住按钮可观察通过器件回送话题驱动的指示灯。文档下载由 Playground 自行处理。

## 包

| 包                                               | 职责                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| [`@mica-js/core`](packages/core)                 | 基础设施：虚拟时间、RPC、日志与生命周期                           |
| [`@mica-js/document`](packages/document)         | 文档领域：`.sch` / `.cnv` 格式、文档操作、几何与网表、话题契约    |
| [`@mica-js/device-model`](packages/device-model) | 新器件共享模型、TypeScript Builder 与校验                         |
| [`@mica-js/compiler`](packages/compiler)         | 新器件模型的 JavaScript 编译与执行                                |
| [`@mica-js/ddl`](packages/ddl)                   | DDL 解析、模型编译与类型投影                                      |
| [`@mica-js/simulator`](packages/simulator)       | 同步板级仿真与编辑器预备运行时、独立 sandbox 适配                 |
| [`@mica-js/sdk`](packages/sdk)                   | Device / Widget 作者 API、DDL 类型生成与 Vite 独立双文件构建      |
| [`@mica-js/sandbox`](packages/sandbox)           | 通用 JS 沙箱：iframe + Worker 隔离与离屏渲染合成                  |
| [`@mica-js/widget`](packages/widget)             | Widget 契约与运行时：包加载、`IWidgetRuntime`、帧、音频与话题通信 |
| [`@mica-js/editor`](packages/editor)             | 原理图与画布编辑器：文档、交互、历史、依赖注入及内部运行会话      |

## 文档

接口约定见 [RFC](docs/rfc/)；各包的简要用法见对应 README。仿真重设计规范使用 [RST + Sphinx](docs/spec/index.rst) 编写。

### 规范构建

准备好 Sphinx、XeLaTeX 和 latexmk 后，在仓库根目录运行。安装步骤及开源字体说明见[规范构建](docs/README.rst)。

```powershell
pnpm docs:html
pnpm docs:pdf
```

HTML 入口为 `dist/docs/html/index.html`，PDF 为 `dist/docs/latex/mica-spec.pdf`。命令直接使用 Sphinx 的 `html` 和 `latexpdf` 构建目标；所有产物均位于已忽略的 `dist/` 下。

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
