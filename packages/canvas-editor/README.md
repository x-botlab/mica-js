# @mica-js/canvas-editor

交互式 `.cnv` 画布编辑器：展示文档和 widget 图层，将编辑命令交给宿主应用，文档持久化也由宿主负责。

## 使用

显式导入样式。应用需提供一个 `HostProvider`（例如使用本包的 `SandboxHostProvider`，传入 `HostFs` 和 `WidgetProvider`）；一个 provider 只用于一个编辑器。

```ts
import '@mica-js/canvas-editor/style.css';
import { createCanvasEditor, type HostProvider } from '@mica-js/canvas-editor';
import { parseCanvas } from '@mica-js/core/canvas';

export async function mountCanvasEditor(container: HTMLElement, hostProvider: HostProvider) {
  const editor = await createCanvasEditor({
    container,
    document: parseCanvas({ version: 1, widgets: [] }),
    hostProvider,
  });

  // 卸载时调用返回的函数，等待宿主资源释放。
  return () => editor.dispose();
}
```

`createCanvasEditor` 在宿主创建并加载文档后才返回；已有 `.cnv` 文本可传给 `parseCanvas(text)`。编辑后的文档可通过 `onChange` 接收并持久化。
