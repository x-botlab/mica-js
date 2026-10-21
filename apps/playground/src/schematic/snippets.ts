/** Snippets rendered in the editor page's usage column; kept as text so the page is documentation. */
export interface UsageSnippet {
  readonly title: string;
  readonly note: string;
  readonly code: string;
}

export const USAGE_SNIPPETS: readonly UsageSnippet[] = [
  {
    title: '挂载编辑器',
    note: '给一个容器元素即可，编辑器只追加自己的 DOM。',
    code: `import { mountSchematicEditor } from '@mica/schematic-editor';

const editor = mountSchematicEditor({
  container: document.querySelector('#host'),
  schematic, // SchematicDocument（.sch）
  view, // 可选：.view 布局覆盖
  devices, // DeviceSymbolProvider，画布按它合成器件外形
  theme: LIGHT_SCHEMATIC_THEME, // 可选，默认深色
});

editor.fitToContent();`,
  },
  {
    title: '器件放置',
    note: '器件列表由宿主提供，编辑器只负责「抓取」到光标上。',
    code: `deviceList.addEventListener('click', (event) => {
  const device = event.target.closest('[data-device]')?.dataset.device;
  if (device !== undefined) editor.placeDevice(device);
});

editor.cancelPlacement(); // Esc 同样可以取消

// 新器件位号策略：默认最小未占用的 U1、U2…
mountSchematicEditor({
  container,
  schematic,
  createDesignator: (device, document) => nextDesignator(document, prefixOf(device)),
});`,
  },
  {
    title: '事件回调',
    note: '文档、选择、工具、错误、视口各自独立通知，宿主据此刷新自己的界面。',
    code: `mountSchematicEditor({
  container,
  schematic,
  onChange: (state) => setStatus(state), // 文档 / 工具 / 选择 / 历史
  onSelectionChange: (selection) => setSelection(selection),
  onToolChange: (tool) => setActiveTool(tool),
  onError: (error) => showToast(error?.message),
  onViewportChange: (viewport) => setZoom(viewport.scale),
});`,
  },
  {
    title: '宿主 API',
    note: '视图、显示、主题、历史与序列化都在返回值上。',
    code: `editor.undo();
editor.redo();
editor.zoomTo(2); // 夹在 zoomLimits（默认 0.25–4）之内
editor.setViewport(editor.getViewport());
editor.setDisplayOptions({ grid: false, snap: false });
editor.setTheme(LIGHT_SCHEMATIC_THEME);
editor.setSchematic(next, { keepHistory: true });

const sch = editor.toJSON(); // 序列化为 .sch JSON
editor.dispose(); // 解绑监听并移除自身 DOM`,
  },
];
