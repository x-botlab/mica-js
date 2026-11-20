# STM32G431RBT6 UCPD1 模型

本模块位于 `examples/stm32g431rbt6-core/src/ucpd.ts`，通过中央 `PeripheralModule`
合同注册为 `ucpd1`。器件上只有 **UCPD1**，基址 `0x4000A000`，中断 `UCPD1_IRQn = 63`。
CC1 = `PB6`，CC2 = `PB4`。

## 1. 电源、时钟与存储

| 资源                             | 行为                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `RCC_APB1ENR2.UCPD1EN`（bit8）   | 必须置 1；否则寄存器行为与 PHY 视为关闭                |
| `RCC_APB1RSTR2.UCPD1RST`（bit8） | 必须为 0；复位保持时不驱动 CC                          |
| `PWR_CR3.UCPD_DBDIS`（bit14）    | 0 = dead-battery Rd 仍在两条 CC 上；1 = 交给 UCPD 配置 |
| `ucpd[0x000–0x03C]`              | 固件可见寄存器映像                                     |
| `ucpd[0x080]`                    | TYPECEVT1/2 等事件标志私有状态                         |
| `ucpd[0x084]`                    | 上一次 TYPEC_VSTATE_CC1/CC2（每线 2 位）               |
| `ucpd[0x09C]`                    | 复位标记                                               |

UCPD 复位时中央 `applyReset` 清 `ucpd[0x100]`，本模块不需要新增 DDL state。
上电后第一次访问 UCPD 时如果复位标记不匹配，会清零寄存器并重建 CC intent。

## 2. 寄存器支持矩阵

### 完整行为

- `CFG1`：`UCPDEN`、`HBITCLKDIV`、`IFRGAP`、`TRANSWIN`、`PSC_UCPDCLK`、
  `RXORDSETEN`、`TXDMAEN`、`RXDMAEN` 保存；仅 `UCPDEN=0` 时允许改配置位。
  `UCPDEN` 1→0 时按 RM 复位控制位并释放 CC。
- `CFG2`：`RXFILTDIS`、`RXFILT2N3`、`FORCECLK`、`WUPEN` 保存；仅 `UCPDEN=0` 可写。
- `CR`：`TXMODE`、`RXMODE`、`PHYRXEN`、`PHYCCSEL`、`ANASUBMODE`、`ANAMODE`、
  `CCENABLE`、`FRSRXEN`、`FRSTX`、`RDCH`、`CC1TCDIS`、`CC2TCDIS` 保存；
  `TXSEND`/`TXHRST`/`FRSTX` 写 1 后自清并分别置 `TXMSGDISC`/`HRSTDISC`/`FRSEVT`，
  **不伪造发送成功**。
- `IMR`：保存可写位；当前只有 TYPECEVT1/2 参与 IRQ。
- `SR`：只读合成，`TYPECEVT1/2` + `TYPEC_VSTATE_CC1/2`；没有 PD 数据时其余标志为 0。
- `ICR`：写 1 清除 `TYPECEVT1/2`（以及未实现的 PD 事件位，保留为 0）；读 0。
- `TX_ORDSET`、`TX_PAYSZ`、`TXDR`、`RX_ORDSET`、`RX_PAYSZ`、`RXDR`、
  `RX_ORDEXT1/2`：保存寄存器值，不实现 BMC/PD 数据通路；RX 寄存器写忽略。
- 所有寄存器支持 byte/halfword/word 部分访问。

### Type-C 检测

- `ANAMODE=1`（sink）：每条 `CCENABLE` 使能且未 `CCxTCDIS` 的 CC 线接 5.1 kΩ Rd 到 VSS。
- `ANAMODE=0`（source）：`ANASUBMODE`：
  - `01` default USB Rp = 56 kΩ；
  - `10` 1.5 A Rp = 22 kΩ；
  - `11` 3.0 A Rp = 10 kΩ；
  - `00` 不驱动。
    Rp 接到 **VDD1**。真实 Rp 接 VBUS 5 V，但本器件 DDL 没有 VBUS 引脚；这是已知限制。
- `PWR_CR3.UCPD_DBDIS=0`：两条 CC 线保持 dead-battery 5.1 kΩ Rd，UCPD 配置不接管。
- `UCPDEN=0` 或 RCC 门控关闭：释放 CC intent（DBDIS=0 时例外，仍是 dead-battery Rd）。
- `CCxTCDIS=1`：该线不接电阻且不采样。
- 电压采样来自真实引脚电阻网络（`readSample(PB6/PB4).voltage`），阈值：
  - ≤0.2 V → `TYPEC_VSTATE=1`（vRa/低）；
  - > 0.2 V 且 ≤0.65 V → `2`（vRd-USB）；
  - > 0.65 V → `3`（vRd-1.5/3.0 或 vOpen）。
- 检测状态变化时置 `TYPECEVT1/2`；`SR` 读取和 1 ms 服务节拍都会采样。
- 采样/状态机不是完整 USB Type-C 状态机；没有 VBUS 检测、VCONN、Rp 切换计时、
  AttachWait、电流能力协商。

## 3. 中断

`ucpdPending` = `(SR_event_flags & IMR & 可写掩码) != 0` 且 RCC 门控打开、`UCPDEN=1`。
目前只有 `TYPECEVT1`（bit14）和 `TYPECEVT2`（bit15）会置位；`FRSEVT` 位保留。
`acknowledge` 为空，固件必须写 ICR 清标志；NVIC pending 为组合逻辑。

## 4. 明确未完成

- USB PD BMC 编解码、4b5b、CRC、SOP*、EOP、Hard Reset/Cable Reset、BIST；
- PD Tx/Rx FIFO、TXDR/RXDR 字节流、`TXIS/TXMSGSENT/RXNE/RXMSGEND` 的真实时序；
- DMA 请求、FRS 检测/发送、VBUS/VCONN 策略、完整 Type-C 状态机；
- source Rp 的 VBUS 参考（暂用 VDD1）、CC 去抖的精确滤波时间；
- `PWR_CR3.UCPD_STDBY`、Stop 唤醒、低功耗电流；
- `UCPDEN` 关闭时对 CC 的电气释放需要模块再次被访问/服务；纯 RCC 关时钟不会自动
  通知本模块更新 intent（固件应先写 `UCPDEN=0` 或触发一次 UCPD 访问）。

## 5. 真实板/IR 验证夹具

- `examples/devices/test/stm32g431rbt6/ucpd-rig.ts` 使用真实电阻 fixture：
  - 5 V → 56 kΩ → CC1，MCU sink Rd 5.1 kΩ → 约 0.417 V，`VSTATE=2`；
  - MCU source Rp 56 kΩ → 3.3 V，外部 5.1 kΩ 下拉 → 约 0.275 V，`VSTATE=2`；
  - 禁用 UCPD 后 CC1 回到 5 V（fixture 仍在），证明 intent 释放。
- 中央 `PERIPHERALS` 已注册 `UCPD_MODULE`。生产主 adapter 的真实固件测试：
  `ucpd-mcu.test.ts`（轮询）、`ucpd-irq-mcu.test.ts`（IRQ63）、
  `ucpd-reset-mcu.test.ts`（SYSRESETREQ）。
- 本模块不修改 `peripherals.ts`/`reset.ts`。
