/** STM32G431RBT6 UCPD1 的寄存器与私有状态布局（RM0440 第 46 章）。 */

export const UCPD1_BASE = 0x4000a000;
export const UCPD1_SIZE = 0x400;
export const UCPD1_IRQ = 63;

/** `ucpd` memory 内部的寄存器映像与私有状态。 */
export const UCPD_REGISTER_OFFSET = 0x000;
export const UCPD_EVENT_OFFSET = 0x080;
export const UCPD_VSTATE_OFFSET = 0x084;
/** 复位标记存 `count ^ 0xffffffff`，避免初值 0 与复位计数 0 混淆。 */
export const UCPD_RESET_MARKER = 0x09c;

/** 寄存器偏移。 */
export const UCPD_CFG1 = 0x000;
export const UCPD_CFG2 = 0x004;
export const UCPD_CR = 0x00c;
export const UCPD_IMR = 0x010;
export const UCPD_SR = 0x014;
export const UCPD_ICR = 0x018;
export const UCPD_TX_ORDSET = 0x01c;
export const UCPD_TX_PAYSZ = 0x020;
export const UCPD_TXDR = 0x024;
export const UCPD_RX_ORDSET = 0x028;
export const UCPD_RX_PAYSZ = 0x02c;
export const UCPD_RXDR = 0x030;
export const UCPD_RX_ORDEXT1 = 0x034;
export const UCPD_RX_ORDEXT2 = 0x038;

/* ---------------- CFG1 ---------------- */
export const UCPD_CFG1_HBITCLKDIV = 0x3f;
export const UCPD_CFG1_IFRGAP = 0x7c0;
export const UCPD_CFG1_TRANSWIN = 0xf800;
export const UCPD_CFG1_PSC_UCPDCLK = 0x000e0000;
export const UCPD_CFG1_RXORDSETEN = 0x1ff00000;
export const UCPD_CFG1_TXDMAEN = 1 << 29;
export const UCPD_CFG1_RXDMAEN = 1 << 30;
export const UCPD_CFG1_UCPDEN = 1 << 31;
export const UCPD_CFG1_WRITABLE =
  UCPD_CFG1_HBITCLKDIV |
  UCPD_CFG1_IFRGAP |
  UCPD_CFG1_TRANSWIN |
  UCPD_CFG1_PSC_UCPDCLK |
  UCPD_CFG1_RXORDSETEN |
  UCPD_CFG1_TXDMAEN |
  UCPD_CFG1_RXDMAEN |
  UCPD_CFG1_UCPDEN;

/* ---------------- CFG2 ---------------- */
export const UCPD_CFG2_RXFILTDIS = 1 << 0;
export const UCPD_CFG2_RXFILT2N3 = 1 << 1;
export const UCPD_CFG2_FORCECLK = 1 << 2;
export const UCPD_CFG2_WUPEN = 1 << 3;
export const UCPD_CFG2_WRITABLE =
  UCPD_CFG2_RXFILTDIS | UCPD_CFG2_RXFILT2N3 | UCPD_CFG2_FORCECLK | UCPD_CFG2_WUPEN;

/* ---------------- CR ---------------- */
export const UCPD_CR_TXMODE = 0x3;
export const UCPD_CR_TXSEND = 1 << 2;
export const UCPD_CR_TXHRST = 1 << 3;
export const UCPD_CR_RXMODE = 1 << 4;
export const UCPD_CR_PHYRXEN = 1 << 5;
export const UCPD_CR_PHYCCSEL = 1 << 6;
export const UCPD_CR_ANASUBMODE = 0x180;
export const UCPD_CR_ANASUBMODE_SHIFT = 7;
export const UCPD_CR_ANAMODE = 1 << 9;
export const UCPD_CR_CCENABLE = 0xc00;
export const UCPD_CR_CCENABLE_SHIFT = 10;
export const UCPD_CR_FRSRXEN = 1 << 16;
export const UCPD_CR_FRSTX = 1 << 17;
export const UCPD_CR_RDCH = 1 << 18;
export const UCPD_CR_CC1TCDIS = 1 << 20;
export const UCPD_CR_CC2TCDIS = 1 << 21;
export const UCPD_CR_WRITABLE = 0x00370fff;

/* ---------------- IMR / SR / ICR ---------------- */
export const UCPD_SR_TXIS = 1 << 0;
export const UCPD_SR_TXMSGDISC = 1 << 1;
export const UCPD_SR_TXMSGSENT = 1 << 2;
export const UCPD_SR_TXMSGABT = 1 << 3;
export const UCPD_SR_HRSTDISC = 1 << 4;
export const UCPD_SR_HRSTSENT = 1 << 5;
export const UCPD_SR_TXUND = 1 << 6;
export const UCPD_SR_RXNE = 1 << 8;
export const UCPD_SR_RXORDDET = 1 << 9;
export const UCPD_SR_RXHRSTDET = 1 << 10;
export const UCPD_SR_RXOVR = 1 << 11;
export const UCPD_SR_RXMSGEND = 1 << 12;
export const UCPD_SR_RXERR = 1 << 13;
export const UCPD_SR_TYPECEVT1 = 1 << 14;
export const UCPD_SR_TYPECEVT2 = 1 << 15;
export const UCPD_SR_TYPEC_VSTATE_CC1 = 0x3 << 16;
export const UCPD_SR_TYPEC_VSTATE_CC1_SHIFT = 16;
export const UCPD_SR_TYPEC_VSTATE_CC2 = 0x3 << 18;
export const UCPD_SR_TYPEC_VSTATE_CC2_SHIFT = 18;
export const UCPD_SR_FRSEVT = 1 << 20;

export const UCPD_IMR_TYPECEVT1 = 1 << 14;
export const UCPD_IMR_TYPECEVT2 = 1 << 15;
export const UCPD_IMR_FRSEVT = 1 << 20;
/** 未实现 PD 报文，因此只让 Type-C 事件参与 IRQ。 */
export const UCPD_IMR_WRITABLE = 0x0010ffff;

export const UCPD_ICR_TYPECEVT1CF = 1 << 14;
export const UCPD_ICR_TYPECEVT2CF = 1 << 15;
export const UCPD_ICR_FRSEVTCF = 1 << 20;
export const UCPD_ICR_WRITABLE = 0x0010c000;

/* ---------------- Type-C ---------------- */
export const UCPD_ANAMODE_SINK = 1;
/** Sink Rd（USB Type-C 默认电流）。 */
export const UCPD_RD_OHM = 5_100;
/** Source Rp：default USB / 1.5 A / 3.0 A。 */
export const UCPD_RP_DEFAULT_OHM = 56_000;
export const UCPD_RP_1_5A_OHM = 22_000;
export const UCPD_RP_3A_OHM = 10_000;
export const UCPD_CC1_PIN = 'PB6';
export const UCPD_CC2_PIN = 'PB4';

/** polling 间隔：真实 Type-C 检测有去抖；模型以 1 ms 采样一次。 */
export const UCPD_POLL_PS = 1_000_000_000;
