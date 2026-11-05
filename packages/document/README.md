# @mica-js/document

Mica 文档契约：`.sch` 原理图、`.cnv` 画布、话题投递与共享格式模型。本包只承载纯数据契约与文档操作，不包含编辑器状态、交互或渲染。

## 主要入口

- `@mica-js/document`：话题投递（`TopicInbox`、投递类型与默认值）、payload 类型、资源引用、诊断类型和 `SchematicError`。
- `@mica-js/document/schematic`：原理图解析与序列化、器件元数据解析、器件符号、几何、网表推导及文档编辑命令。`device.json` 的结构与注册标准化见 [格式说明](../../docs/formats/device.md) 和 [Draft 2020-12 Schema](../../docs/formats/device.schema.json)。
- `@mica-js/document/canvas`：画布解析与序列化、widget 实例、绑定校验及文档编辑命令。

## 依赖边界

本包只从 `@mica-js/core` 引入 `TimePs` 类型；不依赖仿真器或编辑器。
