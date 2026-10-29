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
