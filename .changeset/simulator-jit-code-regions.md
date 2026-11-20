---
'@mica-js/simulator': minor
---

JIT 支持配置多个可执行区域、按代码写入更新版本并刷新派生元数据，以及绑定入口专用的同步函数。运行时传给 `translate` 回调的输入新增 `codeBase` 与 `codeVersion`；自行构造 `JitTranslateInput` 的调用方和测试夹具需补齐这两个字段。

减少 GPIO 和单槽电气更新的发布开销，同时保留调度与发布边界。
