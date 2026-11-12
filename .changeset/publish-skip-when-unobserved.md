---
'@mica-js/simulator': minor
---

`TopicBridge` 收回两个框架内部成员；发布前置校验改为按意图命名的调用闸。

2.4.0 中短暂暴露的 `hostListenerCount` 与 `assertCanPublish()` 从公开合同移除：判定所需的「宿主直连订阅数」与「发布前置校验」改由包内 `WeakMap` 传给适配层，器件与宿主继续只通过 `onDidReceive` 与 `publish` 交互。任意观察面存在时，消息条数、内容与 `simTime` 不变；跳过路径仍执行与 `publish` 相同的对象有效性、调用阶段与板故障校验，因此 `OBJECT_DISPOSED` / `INVALID_CALL_STATE` / `BOARD_FAULTED` 的抛出时机不变。

板级内部的调用准入拆成 `assertCallAllowed` 与 `assertReadAllowed`（共用私有 `admit`），只读入口在板故障后仍可访问；`validity` 改名 `assertAlive`。

无人订阅时的跳过行为沿用 2.4.0：每条批量输出的复制次数 5 → 0，板级发布开销 8.76 → 1.10 µs/tick（100k tick/臂、进程 CPU 时间）。
