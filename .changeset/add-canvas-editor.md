'@mica-js/canvas-editor': minor
---

新增 `@mica-js/canvas-editor`（#100）：把 `.cnv` 文档与 `WidgetLayers` 位图合成到一块画布，并把指针/键盘操作翻译成 `CanvasCommand`。编辑器不持有文档、不修改文档、不启动 sandbox：编辑模式只通过 `onCommand` 上报 `set-placement` / `remove-instance`，运行模式只通过 `dispatch` 转发命中的实例输入。命中测试、包围盒、手柄、缩放/旋转计算与视口限幅均为无 DOM 的纯模块；重绘由 `#dirty` 标志 + 单次 `requestAnimationFrame` 合并，空闲时不调度帧。
