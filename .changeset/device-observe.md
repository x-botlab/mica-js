---
'@mica-js/device': minor
'@mica-js/core': minor
---

实现数字边沿观察与捕获投递（#56）：`api.ir.observeDigital` 声明静态观察绑定，`b.observe.configure` 降低为 `observe.configure`（静态绑定、bool 启用位、u8 边沿编码 1/2/3）；链接期校验 trigger/capture 均为本实例 signal 引脚且目标 entry 签名恰为 `['u8', ...u32 × captures.length]`。device 按 #25 维护启用、边沿选择与基线，使用 #51 的解析阶段采样和门控结果，在首次启用、显式重配、门控恢复及浮空/待定区间后重建基线且不误报边沿；触发时按同一阶段快照固定 `[u8, ...u32]` 载荷，经 #54 的 `scheduler.enqueueMessage` 普通队列按声明顺序投递，不推进时间、不同步重入。core 新增 `PowerDigitalPinChange` / `PowerDigitalPinObserver` 与 `PowerRuntime.addDigitalPinObserver`，在多观察者注册顺序下 fail-fast 通知变化引脚。新增 `device/observe-pin`、`device/observe-binding`、`device/observe-config`、`device/observe-unavailable`；明确拒绝 `edges=0` 状态观察、模拟量、电压、get/set、组观察与任意比较器。
