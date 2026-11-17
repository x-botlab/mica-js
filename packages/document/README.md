# @mica-js/document

Mica 文档契约：`.sch` 原理图、`.cnv` 画布、融合器件文档、话题投递与共享格式模型。本包只承载纯数据契约与文档操作，不包含编辑器状态、交互或渲染。

## 主要入口

- `@mica-js/document`：话题投递（`TopicInbox`、投递类型与默认值）、payload 类型、资源引用、诊断类型和 `SchematicError`。
- `@mica-js/document/schematic`：原理图解析与序列化、器件元数据解析、器件符号、几何、网表推导及文档编辑命令。`device.json` 的结构与注册标准化见 [格式说明](../../docs/formats/device.md) 和 [Draft 2020-12 Schema](../../docs/formats/device.schema.json)。
- `@mica-js/document/canvas`：画布解析与序列化、widget 实例、绑定校验及文档编辑命令。
- `@mica-js/document/fused`：统一器件清单（[RFC 0020](../../docs/rfc/0020-unified-device-package.md)）、模型接口与载荷类型（[RFC 0021](../../docs/rfc/0021-device-model-api.md)）、器件二维几何（[RFC 0022](../../docs/rfc/0022-device-2d-presentation.md)）、融合 `.sch` 第 2 版文档与网表推导（[RFC 0024](../../docs/rfc/0024-fused-schematic-format.md)）及固件属性引用（[RFC 0026](../../docs/rfc/0026-firmware-properties.md)）的纯数据契约、解析与校验。

### 融合文档入口

- `parseUnifiedManifest(value)`、`parseGeometry2D(value, pins?)`、`parseFusedDocument(value)` 返回不可变快照；失败时抛出带稳定诊断码与 JSON Pointer 的 `FusedDocumentError`。
- 字符串输入由 `parseStrictJson` 解码：重复 JSON 键（含 `"a"` 与 `"\u0061"` 这类转义等价键）按 `json/duplicate-key` 拒绝，不再依赖 `JSON.parse` 的后者覆盖；调用方也可直接传入已解码的普通对象。
- `deriveFusedTopology(document, manifests)` 根据显式连接、同名网标与参考内嵌网名推导网络，并在命名或理想电压冲突时拒绝推导。
- `validateModelValue(value, type, types?)` 按 `ValueType` 校验模型载荷；`Value`、`ValueType`、`ModelDefinition`、`MethodDefinition` 与清单 `model` 一起构成器件接口。
- `DeviceLock`、`PackageFiles`、`DeviceRegistry` 描述锁定包的读取接口，`FirmwareImage`、`FirmwareSegment` 描述模型工厂收到的固件镜像；实现方由宿主提供。

## 依赖边界

本包只从 `@mica-js/core` 引入 `TimePs` 类型；不依赖仿真器或编辑器。`@mica-js/document/fused` 不引入任何 `@mica-js/core` 声明。
