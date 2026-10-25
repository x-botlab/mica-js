---
'@mica-js/core': minor
'@mica-js/widget': minor
---

新增 RFC 0009 §3 的资源引用错误处理：`@mica-js/core/assets` 提供 `asset/missing`、`asset/out-of-root`、`asset/too-large`、`asset/undecodable` 四个稳定错误码，以及按工程根解析 `file` 引用的 `resolveAsset`（词法归一化 + `fs.realpath` 双重边界检查、默认 10 MiB 上限、可注入 `decode`）。

- `ASSET_ERROR_CODES` / `AssetError` / `isAssetError`：宿主可只按 `code` 分支。
- `validateSchematicAssets` 与 `parseSchematicWithAssets`：把 `.sch` 中每个 `file` 资源引用解析成带 JSON Pointer 的 `Diagnostic`，失败时抛 `SchematicError`。
- `@mica-js/widget/assets`：`readBinary` 与 `createFileWidgetAssetProvider` 复用同一解析器，widget 宿主不再各自实现路径边界检查。该子入口依赖 `node:fs`，不进入浏览器侧的包根导出。
- 测试：核心解析器 14 例（含跨平台符号链接逃逸、前缀相邻目录、恰好/超过上限、解码失败），原理图集成 6 例，widget 集成 4 例。
