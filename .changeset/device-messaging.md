---
'@mica-js/device': minor
'@mica-js/ir': minor
'@mica-js/core': minor
---

实现话题与 IR 消息桥接（#54）：`api.subscribe/publish/post/postBytes/onOutput/updateBytes` 接入真实 `validateIR` → 参考解释器 → scheduler → device 生命周期链；新增 IR `output` / `outputBytes`、`bridge.send` / `bridge.send_bytes` 与宿主 `IRBridgeHost`，device 侧提供有界输出/输入/发布/更新队列、inbox 预留与释放、初始化暂存与激活顺序、`onTopic` 宿主回调及 `deliver`，并以 `BackpressureError` 和新增 `DeviceErrorCode` 报告背压与非法载荷/句柄/范围。Scheduler 增加不推进时间、不分配事件 ID 的普通消息入口与 `messageId`；`IRStorage` 增加宿主 inbox 写入与原子版本化字节更新。
