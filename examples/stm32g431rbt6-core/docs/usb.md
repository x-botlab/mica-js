# STM32G431 USB FS device 控制器（experimental）

> **状态：experimental，不属于本轮生产交付。** 中央正在撤销新增的生产 USB 注册、
> host typed API 与 channel plumbing；本文只保留实验性模块/夹具记录，不作为支持矩阵
> 或生产交付依据。生产测试 suite 不再引用 USB host API。

本文描述 `src/usb.ts` 的实验性模型子集、PMA/端点语义、虚拟 host API 与未支持项。

## 1. 定位

- 仅 **USB 2.0 full-speed device**，不是 host/OTG，不实现 12 Mbps bit-level PHY。
- 实验性控制器只提供寄存器、PMA、端点状态、事务级 ACK/NAK/STALL 和 reset/IRQ。
- **class-agnostic**：设备/配置/字符串描述符、标准请求、类请求、数据端点用途全部由固件决定；
  模型不硬编码 `GET_DESCRIPTOR`，也不替固件生成枚举响应。
- 外部虚拟 host 通过 `usbHost*` 注入 transaction（reset/SETUP/OUT/IN/SOF/suspend/resume），
  读取的是固件实际写入的 PMA 和端点状态。

## 2. 已支持

| 能力     | 说明                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| 寄存器   | `EP0R..EP7R`、`CNTR`、`ISTR`、`FNR`、`DADDR`、`BTABLE`、`LPMCSR`、`BCDR.DPPU`                       |
| PMA      | 1024 字节，`BTABLE` + `ADDR/COUNT` 缓冲描述符，8/16 位访问（32 位按兼容扩展处理）                   |
| 端点     | 8 个单缓冲端点；BULK/CONTROL/INTERRUPT 类型；`CTR_RX/TX`、`DTOG_RX/TX`、`STAT_RX/TX`、`SETUP`、`EA` |
| EP0      | SETUP、DATA IN、DATA OUT、status IN/OUT、SET_ADDRESS/SET_CONFIGURATION 的零长度状态阶段             |
| 数据端点 | bulk/interrupt 单缓冲 IN/OUT，64 字节 FS 包                                                         |
| 握手     | ACK/NAK/STALL；控制 SETUP 在 NAK/STALL 下仍被接受；toggle 不匹配 ACK 并丢弃                         |
| 事件     | USB reset、suspend、resume/wakeup、SOF 标志；IRQ19/20/42 pending                                    |
| 时间     | 1 ms 帧计数、SOF 标志；事务本身即时，IRQ 在下一个 USB 服务节拍观察                                  |

## 3. 未支持 / 明确剩余

- isochronous 端点；
- double-buffer bulk/isochronous；
- LPM / L1；
- BCD（电池充电检测）；
- remote wakeup 和设备主动 resume（只模拟 host resume 的 WKUP 观察）；
- bit-stuffing、NRZI、CRC 生成/校验的物理层时序；
- 精确 3 ms suspend 检测、SOF 锁相、USB 时钟恢复；
- 所有 8 端点的复杂特性组合、PMA overrun 的精确总线行为；
- ST 系统 bootloader/DFU。

## 4. 内存布局与中央集成

`usb` memory 至少 **0x500** 字节：

| 偏移          | 内容                                |
| ------------- | ----------------------------------- |
| `0x000–0x05F` | USB 寄存器映像                      |
| `0x080–0x08F` | 模型内部计时字（`USB_FRAME_TIMER`） |
| `0x100–0x4FF` | PMA 1 KiB                           |

中央需要：

1. 两个消费者 DDL 都声明至少 `memory usb[0x500];`；当前已扩到 `0x800`。
2. `PERIPHERALS` 注册 `USB_MODULE`；不要放入 `FUSED_PERIPHERALS`。
3. 系统复位清理 `usb` 使用 0x800/至少 0x500；`reset.ts` 已确认清理 0x800。
4. 在固件运行前初始化 `CNTR=0x0003`、`DADDR=0`、`BTABLE=0`、`FRAME_TIMER=1 ms`。
   `DeviceContext.memory` 是只读 `ReadonlyBytes` 快照，**不能**用它调用 `initUsbMemory`；
   应通过 DDL `process start` 或实例内部可变 `Uint8Array` 完成。
5. host 事务 API 需要一个能写 `usb` memory 的通道。`DeviceContext.memory` 只读，
   所以 typed method 不能直接修改控制器。推荐流程：
   - 对 `context.memory.usb.slice(0, USB_MEMORY_SIZE)` 快照调用 `usbHost*` 得到 after；
   - 用 `usbPatchBytes(before, after)` 生成窄 patch；
   - 通过 input channel 发送 patch，由 DDL/模型 `usbApplyPatch` 只写变化的字节。
     **不要整块异步回灌 0x500/0x800 快照**，否则会覆盖 guest 并发写入并增加栈风险。
     patch 格式为连续的 `[offset u16 LE, length u16 LE, data...]`，适合作为 bytes 通道负载。

## 5. Host API（`src/usb.ts`）

所有函数操作一个可变的 `Uint8Array`（`usb` memory，长度至少 0x500）：

```ts
usbHostReset(usb): void
usbHostSetup(usb, address, endpoint, setup8): { handshake: 'ACK' | 'NAK' | 'STALL' | 'TIMEOUT' | 'ERROR' }
usbHostOut(usb, address, endpoint, data, dataToggle?): { handshake: ... }
usbHostIn(usb, address, endpoint): { handshake: 'DATA0' | 'DATA1' | 'NAK' | 'STALL' | 'TIMEOUT' | 'ERROR', data? }
usbHostSof(usb, frame?): void
usbHostSuspend(usb): void
usbHostResume(usb): void
```

建议 typed method 参数：

- `address`: 0–127；`endpoint`: 0–15；
- `data`: `Uint8Array`（SETUP 必须 8 字节；OUT 最大 64）；
- 返回 `handshake` + `data`（二进制）。

设备未连接（`BCDR.DPPU=0`）或 `CNTR.PDWN/FRES` 时返回 `TIMEOUT`，不产生假响应。
wrong address / 无匹配 EA 同样 `TIMEOUT`。

## 6. 测试边界（experimental）

USB 已完全移出本轮生产交付，不提供生产支持；不再有生产正向验收用例。
以下文件仅作为独立实验材料保留，不作为生产支持或生产验收项：

- `usb-registers.test.ts`、`usb-host.test.ts`、`usb-rig.ts`：纯模块/低级语义实验；
  只验证 `usb.ts` 模块本身，不经过生产设备 public host API。若 USB 模块最终移除，
  这些实验测试应随之删除。
- `fixtures/usb-*.c/.bin`、`fixtures/usb-*-build.sh`、`fixtures/usb-pma-multi-strh.*`：
  固件/复现夹具。PMA 多 STRH 夹具同时供 CPU owner 作为通用回归素材保留。
- 已移除的生产正向验收文件：`usb-ep0-e2e.test.ts`、`usb-pma-multi-strh.test.ts`。
  两者依赖即将撤销的生产 public host typed API，因此不再留在任何生产 test suite；
  没有永久 skip，也没有 mock/profile 冒充支持。

## 7. 停止记录

- USB 实现、优化和测试矩阵已停止；不再运行 USB 生产正向用例。
- 中央需要撤销的生产 API/plumbing：USB 生产注册、`usbHostReset/Setup/In/Out/ReadPma`
  等 host typed API、对应 channel/notification 接线。
- 撤出前曾完成的实验性 EP0/IRQ 与 PMA 证据仅保留为历史记录，不构成生产通过项；
  对应 `usb-ep0-e2e.test.ts`、`usb-pma-multi-strh.test.ts` 已删除。
- 完整 `usb-firmware.c`（SET_ADDRESS/SET_CONFIGURATION/EP1/EP2 bulk 回环）始终未验证，
  不计入任何交付项。
