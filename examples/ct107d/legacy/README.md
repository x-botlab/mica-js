# 旧 simulator 引擎兼容层

本目录服务于 `ct107d` / `led8` 的旧 `createBoard` 运行路径，以及 `ct107d` 的 v1 文档
校验；不服务编辑器。

- `device-package.mjs`：从 `<id>/package.json`、`model.js` 加载统一工厂，使用 SDK
  `adaptModelFactory` 把完整属性（含 `FirmwareImage`）、统一事件到旧话题、旧输入话题到统一
  方法连接起来。
- `schematic-metadata.mjs`：按统一清单的引脚集合合成 v1 符号，按 `model.methods` /
  `model.events` 推导旧画布端口，供 `build-schematic.mjs`、`verify-schematic.mjs` 与
  `verify-canvas.mjs` 使用。
- 不生成编辑器使用的 `DeviceMetadata`、不复制旧 `device.json`，也不把 `.sch v1` /
  `.cnv v1` 伪装成 RFC 0024/0025 文档。

旧 `src/widgets/` 仍是板面 legacy widget；原理图/画布生成与校验已经改为统一器件包的
消费者，但产物仍是 v1 文档。
