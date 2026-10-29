---
'@mica-js/schematic-editor': minor
---

`SchematicEditor` 支持复制、剪切、粘贴、原地再制与全选：新增 `SchematicClipboard` 剪贴板数据（可序列化，带格式与版本号，复用 `.sch` 图元类型）、DOM `copy` / `cut` / `paste` 事件处理、`Ctrl/Cmd+D` 与 `Ctrl/Cmd+A` 快捷键，以及 `copySelection()` / `cutSelection()` / `pasteSelection()` / `duplicateSelection()` / `selectAll()` 宿主 API。

粘贴会重新生成元素 id 与器件位号，并保留复制时的几何形状；剪切、粘贴、再制各记录 1 步撤销，既有撤销 / 重做快捷键不变。通过 `clipboard` 选项可注入 `ClipboardPort`，无系统剪贴板权限时使用 `MemoryClipboardPort` 与编辑器内部缓冲。
