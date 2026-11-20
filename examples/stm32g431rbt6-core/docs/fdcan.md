# STM32G431RBT6 FDCAN1 模型

本模块位于 `examples/stm32g431rbt6-core/src/fdcan.ts`，通过中央 `PeripheralModule` 合同注册为
`fdcan1`。器件上只有 **FDCAN1**（无 FDCAN2/3），基址 `0x40006400`，Message RAM
`0x4000A400–0x4000A7FF`（1 KiB），中断 `FDCAN1_IT0`（IRQ21）与 `FDCAN1_IT1`（IRQ22）。

## 1. 地址与存储分区

| 区间                    | 内容                                              |
| ----------------------- | ------------------------------------------------- |
| `0x40006400–0x400067FF` | FDCAN1 全局寄存器 + `FDCAN_CONFIG.CKDIV`（0x100） |
| `0x4000A400–0x4000A7FF` | 1 KiB Message RAM                                 |
| `can[0x000–0x0FF]`      | 固件可见寄存器映像                                |
| `can[0x100]`            | FDCAN_CONFIG.CKDIV                                |
| `can[0x180–0x1BF]`      | 模块私有状态，不通过总线暴露                      |
| `can[0x400–0x7FF]`      | Message RAM 映像                                  |

DDL 使用 `memory can[0x800]`。`reset.ts` 清除 `can[0x000–0x1FF]` 时会同时清零寄存器、
CKDIV 与私有状态；Message RAM 在 MCU 复位后内容不保证，和真实器件上电后的 RAM 一样，
固件必须先写过滤器/list size/Tx buffer。

## 2. 寄存器支持矩阵

### 完整行为

- `CREL` / `ENDN`：只读复位常量。
- `CCCR`：`INIT`、`CCE`、`ASM`、`CSR/CSA`、`MON`、`DAR`、`TEST`、`FDOE`、`BRSE`、
  `PXHD`、`EFBI`、`TXP`、`NISO` 的保存；`INIT&&CCE` 保护；清 `INIT` 自动清 `CCE`；
  清 `TEST` 清空 `TEST` 寄存器；`CSR=1` 立即回读 `INIT=1`、`CSA=1`（不模拟真正停钟）。
- `DBTP` / `NBTP` / `RWD` / `CKDIV`：`INIT&&CCE` 保护写入，保留位读 0。
- `TEST`：只有 `CCCR.TEST=1` 可写 `LBCK/TX`；`RX` 读 0（未接引脚）。
- `IR`：写 1 清除；`IE`、`ILS`、`ILE` 保存并按分组路由到 IT0/IT1。
- `RXGFC`、`XIDAM`、`TXBC`：`INIT&&CCE` 保护写入。
- `RXF0S`、`RXF1S`、`TXFQS`、`TXBRP`：按 FIFO/发送状态动态合成。
- `RXF0A` / `RXF1A`：写 acknowledge index 更新 get index/fill level。
- `TXBAR` / `TXBCR`：add/cancel request，维护 `TXBRP`、`TXBTO`、`TXBCF`。
- `TSCC`、`TSCV`、`TOCC`、`TOCV`、`TDCR`：按可写位保存；计数器本身不产生时间语义。
- 所有寄存器支持 byte/halfword/word 部分访问；窄写只影响对应字节/半字。

### 只读或仅保存、无实际语义

- `ECR`：始终读 0，不累计 TEC/REC/CEL。
- `PSR`：复位值 `0x707`（LEC=7、DLEC=7、ACT=0），不产生错误状态、bus-off、
  protocol exception、TDC 值。
- `HPMS`：只在标准/扩展过滤器命中 priority 时按实现写入；没有独立高优先级搜索。
- `TXEFS` / `TXEFA`：保持空；Tx event FIFO 不写入元素。
- `TXBTIE` / `TXBCIE`：保存位，但当前 TX 完成中断只用全局 `IR.TC/TCF`，不按 buffer 位门控。
- `RXF1S` / `RXF1A`：FIFO1 可被 RXGFC/过滤器路由，状态与 acknowledge 实现。

## 3. Message RAM

固定布局与 RM0440 Figure 669 一致（字节偏移）：

| 区             | 起点    | 大小                            |
| -------------- | ------- | ------------------------------- |
| 标准 ID 过滤器 | `0x000` | 28 × 4 B                        |
| 扩展 ID 过滤器 | `0x070` | 8 × 8 B（模块保留，不参与过滤） |
| Rx FIFO0       | `0x0B0` | 3 × 72 B                        |
| Rx FIFO1       | `0x188` | 3 × 72 B                        |
| Tx event FIFO  | `0x260` | 3 × 8 B（不写入）               |
| Tx buffer      | `0x278` | 3 × 72 B                        |

固件通过绝对地址直接读写 1 KiB Message RAM；byte/halfword/word 访问都按小端拼接/截取。

### 标准 ID 过滤器

- `SFT`：`00` range、`01` dual、`10` classic mask、`11` disabled。
- `SFEC`：`000` disabled、`001` FIFO0、`010` FIFO1、`011` reject、`100` priority、
  `101` priority+FIFO0、`110` priority+FIFO1、`111` 按 disabled 处理。
- 列表长度 `RXGFC.LSS`，>28 按 28 处理；命中第一个过滤器后停止。
- 未命中按 `RXGFC.ANFS` 路由：00 FIFO0、01 FIFO1、10/11 reject；`ANMF=1`。
- `RRFS=1` 时标准远程帧直接丢弃。
- Rx 元素的 `FIDX` 为命中过滤器索引；`ANMF=1` 时 FIDX 未定义，本模型写 0。

**未实现**：扩展 ID 过滤器列表、远程帧的自动响应、J1939/AUTOSAR 特殊语义。
扩展帧按 `RXGFC.ANFE` 路由，不检查 `XIDAM`。

## 4. 内部 loopback 与发送

1. `CCCR.INIT=1 && CCCR.CCE=1` 时配置 `NBTP/DBTP/TEST/RXGFC`。
2. `CCCR.TEST|MON` 进入内部 loopback；清 `INIT` 退出初始化，保留 `TEST/MON`。
3. Tx buffer 写入 T0/T1/T2…；T0 标准 ID 放在 `ID[28:18]`，与 Rx R0 格式相同。
4. `TXBAR` 置 `TXBRP`，服务块在下一拍读取 Tx buffer 并计算帧时长：
   - `tq = (NBRP+1) × kernel clock period × CKDIV 分频`；
   - 帧位数按 `47 + 8 × dataBytes` 估算（经典 CAN）；
   - 发送完成后清 `TXBRP`、置 `TXBTO`、`IR.TC`；
   - 在 `TEST.LBCK` 下把同一帧送进接受过滤和 Rx FIFO0/1。
5. 内部 loopback 不需要 FDCAN_TX/FDCAN_RX 引脚；`MON` 不阻止内部 loopback。

当前发送调度：

- 有多个 pending buffer 时按**最低缓冲区号**启动，不实现 Tx queue 的最低 ID 优先级；
- Tx FIFO `TFQPI/TFGI/TFFL` 为近似状态，支持单 buffer 往返；
- 取消正在发送的 buffer 会停止当前帧并置 `IR.TCF`，不会回滚 Message RAM；
- 没有外部帧注入/发送 typed method/event，也没有位流、仲裁、ACK、错误帧、bus-off。

## 5. CAN FD 边界

- `CCCR.FDOE/BRSE`、Tx 元素 `FDF/BRS`、DLC 9–15 → 12/16/20/24/32/48/64 字节的映射已保存。
- Rx 元素可保存最多 64 字节数据。
- **未实现** CAN FD 数据相位切换的精确时序、FD CRC、>8 字节的 0xCC 填充规则、
  TDC/SSP、扩展 DLC 的线速切换；帧时长按标称位时间近似，不用于真实 FD 时序验收。
- 未实现 CAN FD 的远程帧特殊规则与 protocol exception。

## 6. 中断

- `fdcanPending(line)` = `(IR & IE & routedGroup) != 0 && ILE.EINT[line]`。
- ILS 分组：bit0 RXFIFO0、bit1 RXFIFO1、bit2 SMSG（HPM/TC/TCF）、bit3 TFERR（TFE）；
  bit4–6 保留为 0。
- `acknowledge` 为空：IR 标志必须由固件写 1 清除；NVIC pending 是组合逻辑。
- 两条中断线分别提供 exception 37（IRQ21）与 38（IRQ22）。

## 7. 明确未完成

- 外部 FDCAN 总线/收发器、引脚 AF、TX/RX 波形；
- 仲裁、ACK、位错误/格式错误/CRC 错误、错误计数、错误被动/警告、bus-off；
- 时间戳计数器、超时计数器、RAM watchdog 的真实计时；
- Tx event FIFO 存储、Tx queue 严格优先级、Tx FIFO 完整指针语义；
- 扩展 ID 过滤器、XIDAM 过滤、远程帧自动响应；
- DMA 请求、低功耗/Stop 唤醒、外部时间戳；
- 批量/真实 HAL 的完整 FDCAN 协议栈回归（当前只验证寄存器、Message RAM 与内部 loopback）。

## 8. 生产固件测试

中央 `PERIPHERALS` 全量注册下，生产主 adapter 的真实固件测试：

- `fdcan-mcu.test.ts`：内部 loopback、标准 filter、Rx FIFO0、FDCAN1_IT0 IRQ21；
- `fdcan-reset-mcu.test.ts`：SYSRESETREQ 后 CREL/CCCR/TXFQS/XIDAM 复位。

`advanceFdcan` 的服务块 `elapsedPs` 先在函数入口绑定为 local，再在嵌套分支里读取，
避免 IR_SCOPE；寄存器写路径使用局部变量与顺序 `if`，不构造深层 select/局部键。
