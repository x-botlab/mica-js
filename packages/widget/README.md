# @mica-js/widget

Widget 定义、包加载和运行时。`WidgetHost` 管理画布文档、实例与绘制状态；执行隔离由 `@mica-js/sandbox` 提供，宿主负责传入 sandbox 工厂。

`@mica-js/widget` 导出 `createWidgetHost`、Widget provider 及内置 guest sandbox 和音频 worklet 工厂。内置脚本已随包内联；自定义 worklet 可使用 `@mica-js/widget/vite` 的 `micaWidgetPlugins()`。
