# Mica 设计文档

本目录收录 `proposal(simulator)` 系列提案中已确认的合同，按主题整理为可独立阅读的设计文档。每篇文档在页首标注来源 issue、同步日期与实现落点，正文只描述当前确认的口径。

## 状态标记

| 标记         | 含义                                                   |
| ------------ | ------------------------------------------------------ |
| 提案（OPEN） | 内容来自仍开放的提案；合同已确认，实现可能尚未完全落地 |
| 已确认       | 提案已关闭，合同定稿；实现落点见页首                   |
| 已实现       | 仓库中存在对应实现，页首给出源码路径                   |
| 未实现       | 只有合同，尚无对应实现                                 |

## 文档地图

### 执行内核

| 文档                                   | 内容                                                                        | 来源                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| [虚拟时间](./spec/time-model.md)       | 整数皮秒、取值范围、单位换算、运算、错误分类与序列化                        | [#23](https://github.com/x-botlab/mica-js/issues/23) |
| [电气模型](./spec/electrical-model.md) | 主动驱动、内部弱上下拉、网络解析与容差、浮空输入算法、解析预算              | [#24](https://github.com/x-botlab/mica-js/issues/24) |
| [器件 IR 核心](./spec/device-ir.md)    | 类型与常量、SSA 与基本块、指令族、事件与 ID、公共控制、Provider、预算与故障 | [#26](https://github.com/x-botlab/mica-js/issues/26) |
| [IR 引脚 I/O](./spec/ir-pin-io.md)     | 引脚与组指令、提交边界、配置指令、观察绑定、边沿基线                        | [#25](https://github.com/x-botlab/mica-js/issues/25) |

### 器件模型

| 文档                                      | 内容                                                      | 来源                                                 |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| [器件定义](./spec/device-definition.md)   | `devices` 索引、描述核心字段、实现配对与关联文件命名      | [#11](https://github.com/x-botlab/mica-js/issues/11) |
| [引脚声明](./spec/device-pins.md)         | `pins` / `pinGroups` 声明、输出模式与偏置、意图与状态保存 | [#12](https://github.com/x-botlab/mica-js/issues/12) |
| [电源域](./spec/device-power-domains.md)  | 域声明、输入门限与逻辑记忆、迟滞、门控、通知顺序与恢复    | [#13](https://github.com/x-botlab/mica-js/issues/13) |
| [内部可控连接](./spec/device-topology.md) | `connections` 声明、原子拓扑提交、`connection.apply` 接入 | [#14](https://github.com/x-botlab/mica-js/issues/14) |
| [属性定义](./spec/device-properties.md)   | 属性类型与约束、颜色与枚举、资源引用、实例属性生命周期    | [#7](https://github.com/x-botlab/mica-js/issues/7)   |
| [话题端口](./spec/topic-ports.md)         | 端口描述、载荷类型封闭清单、布局、绑定与投递信封          | [#10](https://github.com/x-botlab/mica-js/issues/10) |

### 文档格式

| 文档                                     | 内容                                              | 来源                                                 |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| [包格式](./spec/package-format.md)       | `package.json` 基础元数据、包内路径、安装与校验   | [#3](https://github.com/x-botlab/mica-js/issues/3)   |
| [原理图格式](./spec/schematic-format.md) | `.sch` 图元、符号角色、导线与交点、网络推导与校验 | [#6](https://github.com/x-botlab/mica-js/issues/6)   |
| [Canvas 格式](./spec/canvas-format.md)   | `.cnv` 顶层字段、widget 实例、属性覆盖与端口绑定  | [#67](https://github.com/x-botlab/mica-js/issues/67) |

### Widget

| 文档                                             | 内容                                                                     | 来源                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| [Widget 定义](./spec/widget-definition.md)       | `widgets` 索引、描述字段、实现配对与身份                                 | [#1](https://github.com/x-botlab/mica-js/issues/1)     |
| [Widget JavaScript API](./spec/widget-js-api.md) | 实例工厂与上下文、属性与话题、绘制与交互、文本输入、时间与资源、生命周期 | [#2](https://github.com/x-botlab/mica-js/issues/2)     |
| [Widget 音频 API](./spec/widget-audio-api.md)    | 音频状态、片段与振荡器、PCM 流与流控、重采样、直连数据通路、配额         | [#133](https://github.com/x-botlab/mica-js/issues/133) |

## 建议阅读顺序

1. [虚拟时间](./spec/time-model.md) → [电气模型](./spec/electrical-model.md)：先确定时间与电气事实的表示。
2. [器件定义](./spec/device-definition.md) → [引脚声明](./spec/device-pins.md) → [电源域](./spec/device-power-domains.md) → [内部可控连接](./spec/device-topology.md)：器件包的声明与运行时状态。
3. [器件 IR 核心](./spec/device-ir.md) → [IR 引脚 I/O](./spec/ir-pin-io.md)：器件代码如何读写引脚、安排事件与观察。
4. [话题端口](./spec/topic-ports.md) → [包格式](./spec/package-format.md) → [原理图格式](./spec/schematic-format.md) → [Canvas 格式](./spec/canvas-format.md)：文档与通信格式。
5. [Widget 定义](./spec/widget-definition.md) → [Widget JavaScript API](./spec/widget-js-api.md) → [Widget 音频 API](./spec/widget-audio-api.md)：画布侧运行时。

## 与其他文档的关系

| 文档                                                                                          | 定位                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 本目录                                                                                        | 组件间的合同与语义，跨包适用                    |
| [packages/simulator/docs/API.md](../packages/simulator/docs/API.md)                           | 统一 IR 电路与器件访问器的 API 参考（使用指南） |
| [packages/simulator/docs/MIGRATION.md](../packages/simulator/docs/MIGRATION.md)               | 从旧路径迁移到统一 IR                           |
| [packages/simulator/docs/PERFORMANCE.md](../packages/simulator/docs/PERFORMANCE.md)           | 基准场景与复现步骤                              |
| [packages/ir/README.md](../packages/ir/README.md)                                             | IR 包的实现结构与使用方式                       |
| [packages/simulator/src/unified-ir/README.md](../packages/simulator/src/unified-ir/README.md) | 统一 IR 编译器与运行时内部结构                  |

## 维护约定

- 每篇文档只对应一个来源 issue；跨文档引用写链接，不复制合同正文。
- 提案有实质修订时同步本目录，并更新页首的同步日期与实现落点。
- 正文只保留已确认的合同条目与示例；讨论过程不进入文档。
