# @mica-js/sandbox

## 0.2.0

### Minor Changes

- 1b8e46a: 移除 `./frame.html` 子路径导出；`frameUrl` 宿主改用 `SANDBOX_FRAME_HTML` 或自行托管帧文档。

## 0.1.0

### Minor Changes

- 503b44b: 首个公开版本：在 `sandbox="allow-scripts"` 的 iframe + classic Worker 中运行不可信客户代码，提供能力白名单、离屏 Canvas 合成、CSP 适配与可强制终止的生命周期。
