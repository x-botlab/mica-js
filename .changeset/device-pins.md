---
'@mica-js/device': minor
'@mica-js/ir': minor
---

实现引脚声明接入与数字 I/O 指令（#55）：解析 `pins` / `pinGroups`，新增 `api.ir.pin`、`b.pin.configure/writeDigital/sampleDigital` 与 `pin.configure/write_digital/sample_digital` 显式指令；链接期校验引脚类别、配置编码与宿主授权，经 `DeviceInstanceOptions.pinHost` 消费 #51 的持有意图、门控采样与恢复能力；初始状态提交、控制阶段可见性与销毁恢复均按已批准合同执行。IR 增加通用 `builderExtensions` 建图扩展，领域指令执行复用已合并的 `executors`；不实现观察、消息、电压/查询指令或组 I/O。
