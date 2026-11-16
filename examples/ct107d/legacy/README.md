# 旧 simulator 引擎兼容层

本目录只服务于 `ct107d` / `led8` 的旧 `createBoard` 运行路径，不服务编辑器。

- `device-package.mjs`：从 `<id>/package.json`、`model.js` 加载统一工厂，使用 SDK
  `adaptModelFactory` 把完整属性（含 `FirmwareImage`）、统一事件到旧话题、旧输入话题到统一
  方法连接起来。
- 不生成 `DeviceMetadata`、不生成符号、不复制旧 `device.json`，也不把 `.sch v1` / `.cnv v1`
  伪装成 RFC 0024/0025 文档。

旧原理图/画布的编辑器验证脚本与 widget 保持本轮迁移前的实现；它们不是统一器件包的消费者。
