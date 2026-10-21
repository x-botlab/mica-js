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
    code: `import { mountSchematicEditor } from '@mica-js/schematic-editor';

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

// 位号来自器件定义：{ id: 'ne555', designatorPrefix: 'U', ... } → U1、U2…
// 器件没声明前缀时回退到 U；也可以用 createDesignator 完全接管。
createDeviceRegistry([
  { packageId: 'timer-package', devices: [{ id: 'ne555', designatorPrefix: 'U' }] },
]);`,
  },
  {
    title: '属性面板',
    note: '属性类型与约束来自器件定义（#7），随 state.inspector 下发，宿主只负责渲染控件。',
    code: `// 器件定义：类型、默认值与约束都声明在 properties 里
createDeviceRegistry([{
  packageId: 'stm32-package',
  devices: [{
    id: 'stm32g431rbt6-lqfp64',
    raw: {
      properties: {
        speed: { type: 'number', title: '主频', default: 72, min: 1, max: 170, unit: 'MHz' },
        firmware: {
          type: 'binary',
          default: { src: 'assets/firmware/m4-demo.bin', mode: 'file' },
          maxBytes: 1048576,
        },
      },
    },
  }],
}]);

// 宿主渲染 state.inspector.properties（PropertyField[]）
for (const field of inspector.properties) {
  field.type; // string | integer | number | boolean | color | enum | image | binary
  field.value; // 实例覆盖值；undefined 表示继承 field.defaultValue
  field.options; // enum 选项
  field.min; field.max; field.step; field.unit; // 数值约束
}

controller.setSymbolProperty(id, 'speed', 168); // 按声明校验，越界会被拒绝
controller.removeSymbolProperty(id, 'speed'); // 恢复默认`,
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
