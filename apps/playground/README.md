# @mica-js/playground

Mica 的交互式示例站点。主页面直接使用 `@mica-js/editor` 的 `createSchematicEditor` 与
`createCanvasEditor`：

- 顶部文档选择在 `runtime-demo/example.cnv`（画布）和 `runtime-demo/example.sch`（原理图）之间切换。
- 画布提供编辑/仿真模式切换，以及撤销、重做、视图缩放、适应内容、视图重置、运行、暂停、单步、复位和下载。
- 编辑模式下可拖动 widget、拖动选框角点调整尺寸；滚轮缩放视图，中键拖动或空格加左键拖动平移视图。
- 原理图提供撤销、重做和下载。
- 右侧集成面板列出文档对象并显示当前选择与属性；属性编辑统一通过 `schematic.setProperties` /
  `canvas.setProperties` 提交，可单独移除覆盖值恢复默认。画布另显示端口绑定和关联原理图，双击对象会
  打开面板并聚焦属性区。
- 下载内容来自应用侧保存的最新初始快照或 `onDidChangeContent` 快照，由 `serializeCanvas` /
  `serializeSchematic` 写出。编辑器只负责文档状态，不执行保存。

## 运行时示例

`public/runtime-demo` 是主页面使用的自包含演示，器件与 widget 的描述和代码都通过完整 ID 解析：

- `demo:echo`（`device.json` + `device.js`）：SDK 器件模块，具名导出 `model` 和同步适配器工厂
  `create(ctx)`。通过 `ctx.topics.onDidReceive` 缓存输入主题 `in` 的 `Boolean(payload)`，在 `sync()`
  中通过 `ctx.topics.publish` 回送到输出主题 `out`；`dispose()` 同步释放订阅。
- `demo:button`（`button.json` + `button.js`）：指针按下/松开时向 `press` 输出端口发布布尔值。
- `demo:indicator`（`indicator.json` + `indicator.js`）：订阅 `lit` 输入端口并绘制指示灯。

`example.cnv` 中的绑定为 `demo:button.press -> demo:echo.in` 和
`demo:echo.out -> demo:indicator.lit`。进入仿真模式并运行后，按住画布上的按钮会点亮指示灯，松开后
指示灯熄灭；暂停时可按“单步”推进。

主线程只读取 JSON 与 JS 文本，不执行模块代码；widget 和器件脚本只在编辑器内部的 sandbox worker
中运行。器件元数据遵循 `@mica-js/sdk/metadata` 的 `DeviceMetadata`，由加载器调用 `validateMetadata`
校验。元数据中的本地 `id` 为 `echo`，文档和库解析始终使用完整 ID `demo:echo`；主题定义在 `ports`
中，布尔端口采用 `level` 传递。widget 仍使用现有 `WidgetModule` 定义与默认导出的工厂，保留颜色属性。

`model.ddl` 是器件模型源文件，声明 `IN`、`OUT` 两个引脚。`device.js` 的 `model` 使用上游
`@mica-js/ddl` 的 `compileDDL(ddl, { uri: 'mica:devices/echo/model.ddl' })` 编译为
`@mica-js/device-model` 的 `DeviceIR`，再以 JSON 对象字面量嵌入模块；此模型只有普通 JSON 值，
没有额外运行时导入或构建流水线。修改 DDL 后需用相同 URI 重新编译并替换 `model`，保留同步适配器。
验证包括重新编译并比较嵌入模型、SDK 元数据校验，以及同步工厂的输入、推进、回送和释放订阅。

## 独立 device demo

`device-demo.html` 仍作为独立入口保留，展示 `public/device-demo` 中的元数据符号与原理图编辑，不启动
仿真。

## 暂时保留的集成资产

- `public/schematics`、`public/canvases`：旧示例文档。
- `public/devices`、`public/widgets`：旧器件与 widget 示例包。
- `public/assets`：位图与固件示例。

新主页面不依赖这些资产。

## 运行

在仓库根目录运行：

```bash
pnpm --filter @mica-js/playground dev
```

开发服务器地址以终端输出为准。打开首页即可使用主示例；`/device-demo.html` 打开独立器件演示。
