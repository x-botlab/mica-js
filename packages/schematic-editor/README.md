# @mica-js/schematic-editor

交互式 `.sch` 原理图编辑器：`DocumentModel` 管理文档与撤销历史，`SchematicEditor` 负责画布和交互。

## 使用

显式导入样式；省略 `value` 时创建空图纸，也可用 `parseSchematic(text)` 初始化已有 `.sch` 文档。

```ts
import '@mica-js/schematic-editor/style.css';
import { createSchematicEditor } from '@mica-js/schematic-editor';

const container = document.querySelector<HTMLElement>('#host');
if (!container) throw new Error('Missing #host');

const editor = createSchematicEditor({ container });
// 应用可从模型读取文档并保存。
console.log(editor.getModel().toJSON());

// 卸载时调用。
editor.dispose();
```

创建过程是同步的。传入 `value` 时编辑器创建并拥有模型，`editor.dispose()` 也会释放模型；传入已有 `DocumentModel` 作为 `model` 时，模型由应用持有，需另行调用 `model.dispose()`。

## 剪贴板与快捷键

| 操作     | 快捷键                           | 行为                                                              |
| -------- | -------------------------------- | ----------------------------------------------------------------- |
| 复制     | `Ctrl/Cmd+C`                     | 复制选中元素；`reference` 归一为整个器件，`vertex` 归一为整条导线 |
| 剪切     | `Ctrl/Cmd+X`                     | 复制后删除，1 步历史                                              |
| 粘贴     | `Ctrl/Cmd+V`                     | 从系统剪贴板或编辑器内部缓冲插入，1 步历史                        |
| 原地再制 | `Ctrl/Cmd+D`                     | 复制并偏移一个网格插入，1 步历史                                  |
| 全选     | `Ctrl/Cmd+A`                     | 选中全部器件、导线与交点                                          |
| 撤销     | `Ctrl/Cmd+Z`                     | 与其他编辑共用同一条历史                                          |
| 重做     | `Shift+Ctrl/Cmd+Z`、`Ctrl/Cmd+Y` | 同上                                                              |

粘贴会为每个元素生成新 id，并重新分配器件位号，因此可以反复粘贴到同一张图纸；交点只在它连接的导线都被复制时才随选择带入。只读编辑器（`readOnly: true`）仍可复制与全选，剪切、粘贴、再制不生效。

## 宿主 API

`SchematicEditor` 暴露同一套方法，供自有工具栏调用：

```ts
// 复制当前选择：尽力写入系统剪贴板，同时保留编辑器内部缓冲。
const payload = editor.copySelection();

// 粘贴：优先用传入的文本，其次系统剪贴板，最后内部缓冲。
await editor.pasteSelection({ at: { x: 100, y: 200 } });

// 原地再制一个网格，返回新元素。
const duplicated = editor.duplicateSelection();

// 全选。
editor.selectAll();
```

剪贴板内容是与 `.sch` 图元同形的 `SchematicClipboard`，可用 `serializeSchematicClipboard()` / `parseSchematicClipboard()` 自行存取。`createSchematicEditor({ clipboard })` 可注入 `ClipboardPort`，测试、Electron 壳或自绘宿主可用导出的 `MemoryClipboardPort`；无法访问系统剪贴板时，粘贴会自动回退到编辑器内部缓冲。剪切、粘贴与再制各自只记录 1 步撤销，粘贴不会改写复制时的几何形状。
