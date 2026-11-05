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

主页面消费 [playground-components](../../examples/playground-components/) 的 SDK CLI 产物，
`public/runtime-demo` 只保存示例原理图和画布，不维护器件或 Widget 的预编译副本。

电路使用固定板级 `VCC = 5 V` 和接地参考，串联 330 Ω 电阻、LED 与常开按钮，电压表并联在 LED
两端。没有独立电源器件。LED 使用 100 Ω 简化电阻负载；仅正向电流产生亮度，反向不发光，电气模型
仍允许反向电流，不模拟二极管截止或压降。按钮闭合为 1 Ω，断开为 1 GΩ；电压表输入阻抗为 10 MΩ。
电阻、LED 和按钮隐藏引脚名称；电压表仅在符号内显示 `+ / -` 极性标识。

- `demo:button.press -> demo:push-button.press`：按住闭合，松开或取消指针时断开。
- `demo:led.brightness -> demo:led-indicator.brightness`：显示正向电流对应的亮度。
- `demo:voltmeter.voltage -> demo:voltmeter.voltage`：显示 LED 两端电压。

进入仿真模式并运行后，按住按钮点亮 LED，电压表约为 1.16 V；松开后熄灭并回到约 0 V。
主线程只读取 JSON 和 JS，代码只在编辑器的 sandbox 中执行。每个组件的交付产物只有一份 JS 和一份
JSON；依赖与资源全部内联，产物不含运行时模块导入、动态导入或独立资源文件。

## SDK CLI 集成

`dev` / `build` 首先构建 SDK 及其依赖，保证干净工作区中 CLI 入口可用。

- 开发：先执行一次 `mica build`，将组件产物复制到忽略提交的 `public/components`，再启动普通 Vite
  开发服务。可传 `--host`、`--port`、`--strictPort`、`--open`。
- 更新：应用源码由 Vite 正常热更新；组件源码变更后重新运行 Playground `dev`，不自动重建组件。
- 生产：同样先构建组件并复制到 `public/components`，再由 Vite 构建应用并复制静态产物。组件构建失败时
  停止应用构建。部署后通过相同的 `/components/` 路径加载，不依赖独立组件服务。

生成目录和 DDL 类型声明均由仓库忽略，源码是唯一维护入口。

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
