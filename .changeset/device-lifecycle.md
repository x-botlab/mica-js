---
'@mica-js/device': minor
'@mica-js/core': patch
---

实现器件工厂上下文与实例生命周期（#53）：`createDeviceInstance` 同步调用一次工厂，提供固定 `api.props` 与声明封闭的 `api.ir`，在真实 IR 校验/链接通过后安装实例并把 initialize 作为公共控制工作驱动；支持 reset、故障暂停、幂等 destroy 与清理后的 `onDispose`，并以受控 storage 句柄阻止销毁后访问。核心调度器允许在 `faulted` 状态下销毁仍存在的实例以完成队列与引用清理，但不恢复执行能力。
