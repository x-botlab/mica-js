# 弃用与移除时间表

本页记录 `@mica-js/simulator` 中已弃用或进入维护状态的 API，以及它们被哪个 API 取代。

## 状态总览

| API / 路径                          | 状态         | 替代                                                    | 移除版本   |
| ----------------------------------- | ------------ | ------------------------------------------------------- | ---------- |
| `createUnifiedCircuit()`（原型）    | **已移除**   | `Circuit.create()`                                      | 0.3.0      |
| `generateUnifiedIR()`（原型）       | **已移除**   | `compileCircuit()`                                      | 0.3.0      |
| `planUnifiedCircuit()`（原型）      | **已移除**   | `compileCircuit()`                                      | 0.3.0      |
| `UnifiedCircuit*` 类型（原型）      | **已移除**   | `Circuit`、`CompiledCircuit`、`CircuitCompilationInput` | 0.3.0      |
| `unified-ir/fixtures/*`（原型器件） | **已移除**   | `unified-ir/devices/*`、`createLedDescription()`        | 0.3.0      |
| `createDeviceSimExecutor()`         | **维护模式** | `Circuit.create()`（新电路代码）                        | 不早于 1.0 |
| `createCircuitHost()`               | **维护模式** | 统一 IR 的电气管线（`compileCircuit`）                  | 不早于 1.0 |

“维护模式”表示：API 仍然完整支持、继续修复缺陷，但**不推荐用于新代码**，也不会新增功能。

## 0.3.0：移除 v0 原型

U01–U04 用生产级管线取代了 v0 原型：

- **编译**：`generateUnifiedIR(config)` + 固定的 `mcu` / `led` 布局 → `compileCircuit({ devices, connections })`，
  支持任意器件描述、全局状态分配、每器件一个 phase 函数和模块内批处理入口。
- **运行时**：`createUnifiedCircuit()`（数字引脚地址 + `ledOn()`）→ `Circuit.create()`，
  带类型化访问器、`step()` / `runBatch()` / `reset()`、`getPin()` / `setPin()` 与 `dispose()`。
- **器件**：`fixtures/simple-mcu.ts`、`fixtures/simple-led.ts`、`fixtures/test-netlist.ts`
  → `unified-ir/devices/`（`createLedIR`、`createButtonIR`）、`unified-ir/examples/teaching-mcu/`
  以及内置 `mcu` / `led` 描述（`createMcuDescription`、`createLedDescription`）。

这些原型 API 从未出现在包的 `exports` 中（`package.json` 只导出 `.`，`files` 只包含 `dist`），
因此**删除它们是内部整理，不构成对外破坏性变更**。依赖深层 `src/unified-ir` 导入的本地脚本需要按
[MIGRATION.md](./MIGRATION.md) 改写。

## 维护中的调度器路径

`createDeviceSimExecutor()` 与 `createCircuitHost()` 建立在 `@mica-js/core` 的虚拟时钟调度器和
`@mica-js/device` 的器件实例之上。它们目前仍是唯一具备以下能力的路径：

- 从原理图文档加载器件模块（`loadSchematic`）；
- 把 `pinHost` / `topology` 透传给 `@mica-js/device` 实例；
- `onPublish` / `deliver` 与画布（widget）互投载荷。

统一 IR 运行时尚未提供这些宿主集成能力（器件模块加载、消息路由、按时间片推进），因此本版本
**不会**删除调度器路径，也不会改变它的默认行为。迁移按下面的顺序推进：

1. **0.3.x**（当前）：统一 IR 为新建程序化电路的推荐路径；调度器路径保持兼容。
2. **0.x 后续版本**：统一 IR 补齐宿主集成（`loadSchematic`、消息路由、器件模块挂载）。
3. **1.0**：评估移除调度器路径；移除前至少保留一个 minor 版本的弃用警告期。

在移除之前，`createDeviceSimExecutor()` 不会改变签名或语义；新增能力只会出现在统一 IR 路径上。
