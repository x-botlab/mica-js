/** STM32G431RBT6 FDCAN1 的地址、寄存器与 Message RAM 布局（RM0440 第 44 章）。 */

/** FDCAN1 全局寄存器与 FDCAN_CONFIG 寄存器所在的地址区间。 */
export const FDCAN1_BASE = 0x40006400;
/** 1 KiB Message RAM（FDCAN1 独占）。 */
export const FDCAN1_RAM_BASE = 0x4000a400;

export const FDCAN_REGISTER_SIZE = 0x400;
export const FDCAN_RAM_SIZE = 0x400;

/**
 * `can` memory 内部分区：
 * - 0x000–0x17F：固件可见寄存器映像（CKDIV 在 0x100）；
 * - 0x180–0x1BF：模块私有状态（不通过总线暴露）；
 * - 0x400–0x7FF：Message RAM，对应 0x4000A400–0x4000A7FF。
 */
export const FDCAN_REGISTER_OFFSET = 0x000;
export const FDCAN_STATE_OFFSET = 0x180;
export const FDCAN_RAM_OFFSET = 0x400;

/** 寄存器偏移（FDCAN1 基址起）。 */
export const FDCAN_CREL = 0x000;
export const FDCAN_ENDN = 0x004;
export const FDCAN_DBTP = 0x00c;
export const FDCAN_TEST = 0x010;
export const FDCAN_RWD = 0x014;
export const FDCAN_CCCR = 0x018;
export const FDCAN_NBTP = 0x01c;
export const FDCAN_TSCC = 0x020;
export const FDCAN_TSCV = 0x024;
export const FDCAN_TOCC = 0x028;
export const FDCAN_TOCV = 0x02c;
export const FDCAN_ECR = 0x040;
export const FDCAN_PSR = 0x044;
export const FDCAN_TDCR = 0x048;
export const FDCAN_IR = 0x050;
export const FDCAN_IE = 0x054;
export const FDCAN_ILS = 0x058;
export const FDCAN_ILE = 0x05c;
export const FDCAN_RXGFC = 0x080;
export const FDCAN_XIDAM = 0x084;
export const FDCAN_HPMS = 0x088;
export const FDCAN_RXF0S = 0x090;
export const FDCAN_RXF0A = 0x094;
export const FDCAN_RXF1S = 0x098;
export const FDCAN_RXF1A = 0x09c;
export const FDCAN_TXBC = 0x0c0;
export const FDCAN_TXFQS = 0x0c4;
export const FDCAN_TXBRP = 0x0c8;
export const FDCAN_TXBAR = 0x0cc;
export const FDCAN_TXBCR = 0x0d0;
export const FDCAN_TXBTO = 0x0d4;
export const FDCAN_TXBCF = 0x0d8;
export const FDCAN_TXBTIE = 0x0dc;
export const FDCAN_TXBCIE = 0x0e0;
export const FDCAN_TXEFS = 0x0e4;
export const FDCAN_TXEFA = 0x0e8;
/** FDCAN_CONFIG 块内的输入时钟分频。 */
export const FDCAN_CKDIV = 0x100;

/** 寄存器复位值（RM0440 Table 411）。 */
export const FDCAN_RESET_VALUES: Readonly<Record<number, number>> = {
  [FDCAN_CREL]: 0x32141218,
  [FDCAN_ENDN]: 0x87654321,
  [FDCAN_DBTP]: 0x00000a33,
  [FDCAN_TEST]: 0x00000000,
  [FDCAN_RWD]: 0x00000000,
  [FDCAN_CCCR]: 0x00000001,
  [FDCAN_NBTP]: 0x06000a03,
  [FDCAN_TSCC]: 0x00000000,
  [FDCAN_TSCV]: 0x00000000,
  [FDCAN_TOCC]: 0xffff0000,
  [FDCAN_TOCV]: 0x0000ffff,
  [FDCAN_ECR]: 0x00000000,
  [FDCAN_PSR]: 0x00000707,
  [FDCAN_TDCR]: 0x00000000,
  [FDCAN_IR]: 0x00000000,
  [FDCAN_IE]: 0x00000000,
  [FDCAN_ILS]: 0x00000000,
  [FDCAN_ILE]: 0x00000000,
  [FDCAN_RXGFC]: 0x00000000,
  [FDCAN_XIDAM]: 0x1fffffff,
  [FDCAN_HPMS]: 0x00000000,
  [FDCAN_RXF0S]: 0x00000000,
  [FDCAN_RXF0A]: 0x00000000,
  [FDCAN_RXF1S]: 0x00000000,
  [FDCAN_RXF1A]: 0x00000000,
  [FDCAN_TXBC]: 0x00000000,
  [FDCAN_TXFQS]: 0x00000003,
  [FDCAN_TXBRP]: 0x00000000,
  [FDCAN_TXBAR]: 0x00000000,
  [FDCAN_TXBCR]: 0x00000000,
  [FDCAN_TXBTO]: 0x00000000,
  [FDCAN_TXBCF]: 0x00000000,
  [FDCAN_TXBTIE]: 0x00000000,
  [FDCAN_TXBCIE]: 0x00000000,
  [FDCAN_TXEFS]: 0x00000000,
  [FDCAN_TXEFA]: 0x00000000,
  [FDCAN_CKDIV]: 0x00000000,
};

/* ---------------- CCCR ---------------- */
export const FDCAN_CCCR_INIT = 1 << 0;
export const FDCAN_CCCR_CCE = 1 << 1;
export const FDCAN_CCCR_ASM = 1 << 2;
export const FDCAN_CCCR_CSA = 1 << 3;
export const FDCAN_CCCR_CSR = 1 << 4;
export const FDCAN_CCCR_MON = 1 << 5;
export const FDCAN_CCCR_DAR = 1 << 6;
export const FDCAN_CCCR_TEST = 1 << 7;
export const FDCAN_CCCR_FDOE = 1 << 8;
export const FDCAN_CCCR_BRSE = 1 << 9;
export const FDCAN_CCCR_PXHD = 1 << 12;
export const FDCAN_CCCR_EFBI = 1 << 13;
export const FDCAN_CCCR_TXP = 1 << 14;
export const FDCAN_CCCR_NISO = 1 << 15;
/** INIT/CCE 之外可由软件改写的位；受保护位单独处理。 */
export const FDCAN_CCCR_ALWAYS_MASK =
  FDCAN_CCCR_INIT |
  FDCAN_CCCR_CCE |
  FDCAN_CCCR_ASM |
  FDCAN_CCCR_CSR |
  FDCAN_CCCR_MON |
  FDCAN_CCCR_DAR |
  FDCAN_CCCR_TEST;
export const FDCAN_CCCR_PROTECTED_MASK =
  FDCAN_CCCR_FDOE |
  FDCAN_CCCR_BRSE |
  FDCAN_CCCR_PXHD |
  FDCAN_CCCR_EFBI |
  FDCAN_CCCR_TXP |
  FDCAN_CCCR_NISO;
export const FDCAN_CCCR_WRITABLE_MASK = FDCAN_CCCR_ALWAYS_MASK | FDCAN_CCCR_PROTECTED_MASK;

/* ---------------- TEST ---------------- */
export const FDCAN_TEST_LBCK = 1 << 4;
export const FDCAN_TEST_TX_MASK = 3 << 5;
export const FDCAN_TEST_RX = 1 << 7;
export const FDCAN_TEST_WRITABLE_MASK = FDCAN_TEST_LBCK | FDCAN_TEST_TX_MASK;

/* ---------------- DBTP / NBTP ---------------- */
export const FDCAN_DBTP_WRITABLE_MASK = 0x009f1fff;
export const FDCAN_NBTP_WRITABLE_MASK = 0xffffff7f;
export const FDCAN_NBTP_NTSEG2 = 0x7f;
export const FDCAN_NBTP_NTSEG1 = 0xff00;
export const FDCAN_NBTP_NBRP = 0x01ff0000;
export const FDCAN_NBTP_NSJW = 0xfe000000;

/* ---------------- IR / IE / ILS / ILE ---------------- */
export const FDCAN_IR_RF0N = 1 << 0;
export const FDCAN_IR_RF0F = 1 << 1;
export const FDCAN_IR_RF0L = 1 << 2;
export const FDCAN_IR_RF1N = 1 << 3;
export const FDCAN_IR_RF1F = 1 << 4;
export const FDCAN_IR_RF1L = 1 << 5;
export const FDCAN_IR_HPM = 1 << 6;
export const FDCAN_IR_TC = 1 << 7;
export const FDCAN_IR_TCF = 1 << 8;
export const FDCAN_IR_TFE = 1 << 9;
export const FDCAN_IR_TEFN = 1 << 10;
export const FDCAN_IR_TEFF = 1 << 11;
export const FDCAN_IR_TEFL = 1 << 12;
export const FDCAN_IR_TSW = 1 << 13;
export const FDCAN_IR_MRAF = 1 << 14;
export const FDCAN_IR_TOO = 1 << 15;
export const FDCAN_IR_ELO = 1 << 16;
export const FDCAN_IR_EP = 1 << 17;
export const FDCAN_IR_EW = 1 << 18;
export const FDCAN_IR_BO = 1 << 19;
export const FDCAN_IR_WDI = 1 << 20;
export const FDCAN_IR_PEA = 1 << 21;
export const FDCAN_IR_PED = 1 << 22;
export const FDCAN_IR_ARA = 1 << 23;

export const FDCAN_IR_IMPLEMENTED =
  FDCAN_IR_RF0N |
  FDCAN_IR_RF0F |
  FDCAN_IR_RF0L |
  FDCAN_IR_RF1N |
  FDCAN_IR_RF1F |
  FDCAN_IR_RF1L |
  FDCAN_IR_HPM |
  FDCAN_IR_TC |
  FDCAN_IR_TCF |
  FDCAN_IR_TFE;

export const FDCAN_IE_MASK = FDCAN_IR_IMPLEMENTED;
export const FDCAN_ILS_MASK = 0x7f;
export const FDCAN_ILE_MASK = 0x3;

const GROUP_RX0 = FDCAN_IR_RF0N | FDCAN_IR_RF0F | FDCAN_IR_RF0L;
const GROUP_RX1 = FDCAN_IR_RF1N | FDCAN_IR_RF1F | FDCAN_IR_RF1L;
const GROUP_SMSG = FDCAN_IR_HPM | FDCAN_IR_TC | FDCAN_IR_TCF;
const GROUP_TFERR = FDCAN_IR_TFE;

/** ILS 分组位：0=RXFIFO0、1=RXFIFO1、2=SMSG、3=TFERR。 */
export const FDCAN_ILS_GROUPS: readonly {
  readonly bit: number;
  readonly mask: number;
}[] = [
  { bit: 0, mask: GROUP_RX0 },
  { bit: 1, mask: GROUP_RX1 },
  { bit: 2, mask: GROUP_SMSG },
  { bit: 3, mask: GROUP_TFERR },
  { bit: 4, mask: 0 },
  { bit: 5, mask: 0 },
  { bit: 6, mask: 0 },
];

/* ---------------- RXGFC / XIDAM / TXBC ---------------- */
export const FDCAN_RXGFC_WRITABLE_MASK = 0x0f1f0333;
export const FDCAN_RXGFC_LSS_SHIFT = 16;
export const FDCAN_RXGFC_LSS_MASK = 0x1f << FDCAN_RXGFC_LSS_SHIFT;
export const FDCAN_RXGFC_LSE_SHIFT = 24;
export const FDCAN_RXGFC_LSE_MASK = 0x0f << FDCAN_RXGFC_LSE_SHIFT;
export const FDCAN_RXGFC_F0OM = 1 << 9;
export const FDCAN_RXGFC_F1OM = 1 << 8;
export const FDCAN_RXGFC_ANFS_SHIFT = 4;
export const FDCAN_RXGFC_ANFE_SHIFT = 2;
export const FDCAN_RXGFC_RRFS = 1 << 1;
export const FDCAN_RXGFC_RRFE = 1 << 0;
export const FDCAN_XIDAM_MASK = 0x1fffffff;
export const FDCAN_TXBC_TFQM = 1 << 24;

/* ---------------- 状态寄存器 ---------------- */
export const FDCAN_RXF0S_RF0L = 1 << 25;
export const FDCAN_RXF0S_F0F = 1 << 24;
export const FDCAN_RXF0S_F0PI = 3 << 16;
export const FDCAN_RXF0S_F0GI = 3 << 8;
export const FDCAN_RXF0S_F0FL = 0xf;
export const FDCAN_RXF1S_F1L = 1 << 25;
export const FDCAN_RXF1S_F1F = 1 << 24;
export const FDCAN_RXF1S_F1PI = 3 << 16;
export const FDCAN_RXF1S_F1GI = 3 << 8;
export const FDCAN_RXF1S_F1FL = 0xf;
export const FDCAN_TXFQS_TFQF = 1 << 21;
export const FDCAN_TXFQS_TFQPI = 3 << 16;
export const FDCAN_TXFQS_TFGI = 3 << 8;
export const FDCAN_TXFQS_TFFL = 0x7;

/** FDCAN1 的两个中断：IT0=IRQ21、IT1=IRQ22。 */
export const FDCAN1_IT0_IRQ = 21;
export const FDCAN1_IT1_IRQ = 22;

/* ---------------- Message RAM ---------------- */
/** 标准 ID 过滤器从 0x000 起，28 个 32 位元素。 */
export const FDCAN_STD_FILTER_START = 0x000;
export const FDCAN_STD_FILTER_COUNT = 28;
/** 扩展 ID 过滤器从 0x070 起，8 个双字元素。 */
export const FDCAN_EXT_FILTER_START = 0x070;
export const FDCAN_EXT_FILTER_COUNT = 8;
/** Rx FIFO 0 / 1 各 3 个 18 字元素（72 字节）。 */
export const FDCAN_RX0_START = 0x0b0;
export const FDCAN_RX1_START = 0x188;
export const FDCAN_RX_FIFO_DEPTH = 3;
export const FDCAN_ELEMENT_SIZE = 0x48;
/** Tx event FIFO 与 Tx buffer 的起始偏移。 */
export const FDCAN_TX_EVENT_START = 0x260;
export const FDCAN_TX_EVENT_SIZE = 8;
export const FDCAN_TX_BUFFER_START = 0x278;
export const FDCAN_TX_BUFFER_COUNT = 3;

/** Rx/Tx 元素内数据字节从 T2/R2 开始。 */
export const FDCAN_ELEMENT_DATA_OFFSET = 8;

/* ---------------- 私有状态（can memory 0x200 起） ---------------- */
export const FDCAN_STATE_TX_PENDING = FDCAN_STATE_OFFSET + 0x00;
export const FDCAN_STATE_TX_ACTIVE = FDCAN_STATE_OFFSET + 0x04;
export const FDCAN_STATE_TX_REMAINING = FDCAN_STATE_OFFSET + 0x08;
export const FDCAN_STATE_TX_PUT = FDCAN_STATE_OFFSET + 0x0c;
export const FDCAN_STATE_TX_GET = FDCAN_STATE_OFFSET + 0x10;
export const FDCAN_STATE_RX0_PUT = FDCAN_STATE_OFFSET + 0x14;
export const FDCAN_STATE_RX0_GET = FDCAN_STATE_OFFSET + 0x18;
export const FDCAN_STATE_RX0_FILL = FDCAN_STATE_OFFSET + 0x1c;
export const FDCAN_STATE_RX1_PUT = FDCAN_STATE_OFFSET + 0x20;
export const FDCAN_STATE_RX1_GET = FDCAN_STATE_OFFSET + 0x24;
export const FDCAN_STATE_RX1_FILL = FDCAN_STATE_OFFSET + 0x28;
export const FDCAN_STATE_LAST_STATUS = FDCAN_STATE_OFFSET + 0x2c;
/** 已写过哪些带非零复位值的寄存器；复位清空 `can[0x000..0x1ff]` 时一起归零。 */
export const FDCAN_STATE_WRITTEN = FDCAN_STATE_OFFSET + 0x30;
/** 旧的复位标记保留导出，当前实现不再使用（复位计数由 memory 清零代替）。 */
export const FDCAN_STATE_RESET_MARKER = FDCAN_STATE_OFFSET + 0x3c;

/** 校验 FDCAN Message RAM 元素起点没有越界（编译期常量，便于审查）。 */
export const FDCAN_MESSAGE_RAM_END =
  FDCAN_TX_BUFFER_START + FDCAN_TX_BUFFER_COUNT * FDCAN_ELEMENT_SIZE;
