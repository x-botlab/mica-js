# 器件作者示例：理想按钮与理想继电器

本目录存放 #58 首个端到端闭环使用的两个真实器件模型。每个器件遵循 [器件定义](https://github.com/x-botlab/mica-js/issues/11) 的同目录同名配对：描述与实现分别使用 `<id>.json` 与 `<id>.js`，加载时由宿主 `IDeviceProvider` 读取两份文件，`loadDeviceModule` 只导入实现源码。

| 器件       | 文件            | 行为                                                                                                                                                     |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 理想按钮   | `ideal-button/` | 话题 `pressed` 驱动被动双向触点 `contact`（`A`–`B`）；initialize 与 reset 复位为断开；不驱动任何引脚                                                     |
| 理想继电器 | `ideal-relay/`  | `IN` 的边沿由 `observeDigital` 捕获；`apply` 用捕获电平在同一 patch 原子切换 `normallyOpen`（`COM`–`NO`）与 `normallyClosed`（`COM`–`NC`）；不声明 reset |

两个模型只使用已确认的作者面：`api.ir` 静态声明、`b.pin`、`b.observe`、`b.connection`、`api.subscribe` / `api.post` 与生命周期绑定；没有运行期 JS 解码引脚协议，也没有用宿主输出代替被动触点。

## 与实现的关系

- 这些文件不是 `@mica-js/device` 的包实现：`tsconfig.build.json` 只包含 `src`，`package.json` 的 `files` 仅含 `dist`，因此它们不会进入 `dist` 或发布包。
- 放在 `examples/` 而不是 `src/`：模型是器件作者产物，保留原始 JSON/JS 配对便于宿主、文档和后续 Playground 直接复用；同时与包源码和测试辅助代码区分。
- 端到端回归在 [`../src/e2e/button-relay.test.ts`](../src/e2e/button-relay.test.ts)：从磁盘读取这两个文件，走 `loadDeviceModule` → `createDeviceInstance` → scheduler/IR → `createPowerRuntime` → `b.connection.apply` → topology 的完整链路，断言网络电压、观察投递、原子切换、复位、实例隔离、掉电门控与电气冲突行为。

## 运行

在仓库根目录运行：

```powershell
pnpm --filter @mica-js/device test
pnpm --filter @mica-js/device typecheck
```

示例只覆盖理想模型语义：无抖动、无接触电阻、无机械延迟、无线圈电流或吸合阈值。模拟量、协议库、Provider 生成与教学 MCU 不在本目录范围。
