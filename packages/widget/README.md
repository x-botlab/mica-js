# @mica-js/widget

Widget 契约、包加载和运行时，负责管理画布文档、widget 实例、绘制、音频与端口通信。可作为独立运行时使用，也可由画布编辑器集成。

宿主负责提供文件访问、widget 包和沙箱工厂；执行隔离由 `@mica-js/sandbox` 提供。本包不负责器件电气仿真。

## 主要入口

- `@mica-js/widget`：`createWidgetHost`、widget provider 以及内置沙箱和音频 worklet 工厂。
- `@mica-js/widget/vite`：`micaWidgetPlugins()`，用于 widget 构建集成。
