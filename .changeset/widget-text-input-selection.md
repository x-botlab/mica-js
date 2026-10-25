---
'@mica-js/widget': minor
---

新增原生文本输入与选择（RFC 0015 §6–§7）：

- `api.textInput.begin / update / commit / cancel` 与 `api.onTextInput`：guest 通过 `widget:text-input` 事件请求宿主的隐藏 `<textarea>` 代理，IME 的 `compositionstart` / `compositionupdate` / `compositionend` 与 `input` 都会转成 `composing` 事件；宿主提交或 widget 主动提交只产生一次 `commit`。
- `api.textSelection.begin / update / commit / cancel` 与 `api.onTextSelection`：把 widget 绘制的文本交给原生选择控件，`change` / `commit` / `cancel` 事件携带夹到文本长度并对调过的 `start` / `end` / `selectedText`。
- 新文件 `host/text-input-proxy.ts` 提供默认 `<textarea>` 覆盖层（锚点定位、缩放、焦点、Enter / Escape / blur、组合输入状态机）与可注入的 `WidgetTextInputProxyFactory`；`WidgetHostOptions` 新增 `textInputProxy` / `textInputAnchor` / `textInputScale`，无 DOM 环境以 `widget/text-input-failed` 上报。
- 实例卸载、`reset()`、宿主 `dispose()` 都会取消或释放活动控件，避免覆盖层泄漏。
- 测试：`runtime/text-input.test.ts` 覆盖中文/日文 IME 组合、提交/取消、光标夹取、监听器隔离与生命周期；`host/text-input-proxy.test.ts` 覆盖原生事件转发与控件定位；`host/create-widget-host.test.ts` 覆盖 guest ↔ 宿主路由。
