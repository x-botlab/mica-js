# Mica RFC

本目录按 RFC 组织电路仿真的合同：每篇文档是一个编号固定的规范，正文描述当前生效的语义，页首给出起源与实现落点。

## 索引

| RFC                                        | 标题            | 领域     | 来源                                                   |
| ------------------------------------------ | --------------- | -------- | ------------------------------------------------------ |
| [RFC 0001](./0001-virtual-time.md)         | 虚拟时间模型    | 执行内核 | [#23](https://github.com/x-botlab/mica-js/issues/23)   |
| [RFC 0002](./0002-electrical-model.md)     | 电气模型        | 执行内核 | [#24](https://github.com/x-botlab/mica-js/issues/24)   |
| [RFC 0003](./0003-device-ir.md)            | 器件 IR 核心    | 执行内核 | [#26](https://github.com/x-botlab/mica-js/issues/26)   |
| [RFC 0004](./0004-ir-pin-io.md)            | IR 引脚 I/O     | 执行内核 | [#25](https://github.com/x-botlab/mica-js/issues/25)   |
| [RFC 0005](./0005-device-definition.md)    | 器件定义        | 器件模型 | [#11](https://github.com/x-botlab/mica-js/issues/11)   |
| [RFC 0006](./0006-device-pins.md)          | 引脚声明        | 器件模型 | [#12](https://github.com/x-botlab/mica-js/issues/12)   |
| [RFC 0007](./0007-device-power-domains.md) | 电源域          | 器件模型 | [#13](https://github.com/x-botlab/mica-js/issues/13)   |
| [RFC 0008](./0008-device-topology.md)      | 内部可控连接    | 器件模型 | [#14](https://github.com/x-botlab/mica-js/issues/14)   |
| [RFC 0009](./0009-device-properties.md)    | 属性定义        | 器件模型 | [#7](https://github.com/x-botlab/mica-js/issues/7)     |
| [RFC 0010](./0010-topic-ports.md)          | 话题端口        | 器件模型 | [#10](https://github.com/x-botlab/mica-js/issues/10)   |
| [RFC 0011](./0011-package-format.md)       | 包格式          | 文档格式 | [#3](https://github.com/x-botlab/mica-js/issues/3)     |
| [RFC 0012](./0012-schematic-format.md)     | 原理图格式      | 文档格式 | [#6](https://github.com/x-botlab/mica-js/issues/6)     |
| [RFC 0013](./0013-canvas-format.md)        | Canvas 格式     | 文档格式 | [#67](https://github.com/x-botlab/mica-js/issues/67)   |
| [RFC 0014](./0014-widget-definition.md)    | Widget 定义     | Widget   | [#1](https://github.com/x-botlab/mica-js/issues/1)     |
| [RFC 0015](./0015-widget-js-api.md)        | Widget JS API   | Widget   | [#2](https://github.com/x-botlab/mica-js/issues/2)     |
| [RFC 0016](./0016-widget-audio-api.md)     | Widget 音频 API | Widget   | [#133](https://github.com/x-botlab/mica-js/issues/133) |

## 页首字段

每篇 RFC 在标题后使用三个列表项，不引入其他元数据：

| 字段                | 含义                                                     |
| ------------------- | -------------------------------------------------------- |
| `Start Date`        | RFC 起源日期，取来源 issue 的创建日期                    |
| `Reference Issues`  | 讨论与需求来源的 issue；RFC 正文陈述结论，讨论留在 issue |
| `Implementation PR` | 把该合同落地到代码的 PR；`—` 表示尚无实现                |

```markdown
- Start Date: 2026-10-18
- Reference Issues: [#23](https://github.com/x-botlab/mica-js/issues/23)
- Implementation PR: [#82](https://github.com/x-botlab/mica-js/pull/82)
```

引用时使用编号（如 `RFC 0007`），便于代码注释与提交信息指向稳定的规范位置。

## 建议阅读顺序

1. [RFC 0001](./0001-virtual-time.md) → [RFC 0002](./0002-electrical-model.md)：先确定时间与电气事实的表示。
2. [RFC 0005](./0005-device-definition.md) → [RFC 0006](./0006-device-pins.md) → [RFC 0007](./0007-device-power-domains.md) → [RFC 0008](./0008-device-topology.md)：器件包的声明与运行时状态。
3. [RFC 0003](./0003-device-ir.md) → [RFC 0004](./0004-ir-pin-io.md)：器件代码如何读写引脚、安排事件与观察。
4. [RFC 0010](./0010-topic-ports.md) → [RFC 0011](./0011-package-format.md) → [RFC 0012](./0012-schematic-format.md) → [RFC 0013](./0013-canvas-format.md)：文档与通信格式。
5. [RFC 0014](./0014-widget-definition.md) → [RFC 0015](./0015-widget-js-api.md) → [RFC 0016](./0016-widget-audio-api.md)：画布侧运行时。

## 与其他文档的关系

| 文档                                                                                             | 定位                                            |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 本目录                                                                                           | 跨包的合同与语义                                |
| [packages/simulator/docs/API.md](../../packages/simulator/docs/API.md)                           | 统一 IR 电路与器件访问器的 API 参考（使用指南） |
| [packages/simulator/docs/MIGRATION.md](../../packages/simulator/docs/MIGRATION.md)               | 从旧路径迁移到统一 IR                           |
| [packages/simulator/docs/PERFORMANCE.md](../../packages/simulator/docs/PERFORMANCE.md)           | 基准场景与复现步骤                              |
| [packages/ir/README.md](../../packages/ir/README.md)                                             | IR 包的实现结构与使用方式                       |
| [packages/simulator/src/unified-ir/README.md](../../packages/simulator/src/unified-ir/README.md) | 统一 IR 编译器与运行时内部结构                  |

## 维护约定

- 编号一经分配不再复用；新增合同取下一个可用编号，删除的 RFC 保留编号占位。
- 每篇 RFC 只对应一个主题；跨 RFC 引用写链接，不复制正文。
- 合同有实质修订时直接更新正文，并同步 `Implementation PR` 与索引。
- 正文只保留已确认的合同条目与示例；讨论过程留在 `Reference Issues`。
