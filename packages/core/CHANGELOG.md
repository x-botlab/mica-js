# @mica-js/core

## 0.1.1

### Patch Changes

- 69dc4b0: 实现器件工厂上下文与实例生命周期（#53）：`createDeviceInstance` 同步调用一次工厂，提供固定 `api.props` 与声明封闭的 `api.ir`，在真实 IR 校验/链接通过后安装实例并把 initialize 作为公共控制工作驱动；支持 reset、故障暂停、幂等 destroy 与清理后的 `onDispose`，并以受控 storage 句柄阻止销毁后访问。核心调度器允许在 `faulted` 状态下销毁仍存在的实例以完成队列与引用清理，但不恢复执行能力。

## 0.1.0

### Minor Changes

- 503b44b: 新增原理图 `.sch` 与画布 `.cnv` 两个文档格式子路径：解析、序列化与校验，拓扑推导，编辑命令与撤销重做，命中测试，器件注册表，以及 `string` / `number` / `integer` / `boolean` / `enum` / `color` / `image` / `binary` 属性系统与资源引用。
