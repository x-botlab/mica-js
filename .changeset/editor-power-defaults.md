---
'@mica-js/editor': minor
---

融合工作台新建电源符号默认接入 `VCC` 网络，电压为 `3.3 V`，放置预览使用同一默认值。双击电源符号或其网名、接地符号和普通网标会打开对应的属性面板。

宿主可用 `simulation.pause` 和 `simulation.resume` 在同一运行会话中暂停和继续仿真，并通过 `simulationStatus` 观察状态。工作台界面不新增控件。底层融合运行时的 `pause()` 现在返回 Promise，可等待仿真端确认。
