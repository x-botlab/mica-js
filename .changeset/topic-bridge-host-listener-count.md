---
'@mica-js/simulator': minor
---

`TopicBridge` 新增 `hostListenerCount` 与 `assertCanPublish()`。

`hostListenerCount` 是未携带 `owner` 的监听者数量，即宿主对板级根 bridge 的直连订阅数；实例作用域包装注册的器件监听者不计入。它让运行时能够判断「本次发布是否有人接收」，从而在无人接收时跳过载荷复制、扇出与批量输出。

`assertCanPublish()` 以与 `publish` 相同的失效、非法阶段与故障规则校验，但不复制载荷、不组装消息、不派发，供跳过发布的调用方保留板级守护。

对实现方是破坏性变更（新增两个必需成员）；仓库内只有 `Board` 一个实现，消费方不受影响。
