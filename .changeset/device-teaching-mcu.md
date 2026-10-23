---
'@mica-js/device': minor
---

新增 `DeviceInstanceOptions.updateResources`：宿主可按资源名单独授权只读 `bytes` 资源走 `api.updateBytes` 与 IR `resource.update_bytes` / `fill_bytes` 更新路径，`readonly` 仍只禁止客体普通写入。补充 #8/#26 教学 MCU 示例与 #62 集成验收：两字节合成 ISA、Provider 按 PC 生成基本块、8 B 版本单元、固件消息更新、checkpoint 不自修改重放，以及缺少固件/非法地址/非法指令/HALT 的明确行为。示例仅保证块边界可观察，不是真实 AVR/8051 ISA 或逐周期等价实现。
