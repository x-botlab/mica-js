/**
 * STM32G431 USB FS device 的寄存器 / PMA 布局。
 *
 * RM0440 §45：USB 寄存器块在 0x4000_5C00，专用 packet memory 在 0x4000_6000，
 * 共 1024 字节（512 个 16 位半字）。模型把寄存器与 PMA 放进同一个 `usb` memory：
 * - 0x000–0x05F：USB 寄存器映像；
 * - 0x080–0x08F：模型内部计时/诊断字；
 * - 0x100–0x4FF：PMA 1 KiB。
 */
export const USB_PMA_BASE = 0x4000_6000;
export const USB_PMA_SIZE = 0x400;
export const USB_REGISTER_SIZE = 0x400;
export const USB_REGISTER_END = 0x60;

export const USB_PMA_OFFSET = 0x100;
export const USB_MEMORY_SIZE = USB_PMA_OFFSET + USB_PMA_SIZE;

/** 模型内部字；不映射到 guest 可见的 USB 寄存器地址。 */
export const USB_FRAME_TIMER = 0x80;
export const USB_FRAME_PS = 1_000_000_000;
export const USB_FRAME_MASK = 0x7ff;

export const USB_EP_COUNT = 8;
export const USB_EP_STRIDE = 4;
export const USB_EP0R = 0x00;
export const USB_CNTR = 0x40;
export const USB_ISTR = 0x44;
export const USB_FNR = 0x48;
export const USB_DADDR = 0x4c;
export const USB_BTABLE = 0x50;
export const USB_LPMCSR = 0x54;
export const USB_BCDR = 0x58;

export const USB_CNTR_CTRM = 0x8000;
export const USB_CNTR_PMAOVRM = 0x4000;
export const USB_CNTR_ERRM = 0x2000;
export const USB_CNTR_WKUPM = 0x1000;
export const USB_CNTR_SUSPM = 0x0800;
export const USB_CNTR_RESETM = 0x0400;
export const USB_CNTR_SOFM = 0x0200;
export const USB_CNTR_ESOFM = 0x0100;
export const USB_CNTR_L1REQM = 0x0080;
export const USB_CNTR_RESUME = 0x0010;
export const USB_CNTR_FSUSP = 0x0008;
export const USB_CNTR_LPMODE = 0x0004;
export const USB_CNTR_PDWN = 0x0002;
export const USB_CNTR_FRES = 0x0001;

export const USB_ISTR_CTR = 0x8000;
export const USB_ISTR_PMAOVR = 0x4000;
export const USB_ISTR_ERR = 0x2000;
export const USB_ISTR_WKUP = 0x1000;
export const USB_ISTR_SUSP = 0x0800;
export const USB_ISTR_RESET = 0x0400;
export const USB_ISTR_SOF = 0x0200;
export const USB_ISTR_ESOF = 0x0100;
export const USB_ISTR_L1REQ = 0x0080;

export const USB_EP_CTR_RX = 0x8000;
export const USB_EP_DTOG_RX = 0x4000;
export const USB_EP_STAT_RX = 0x3000;
export const USB_EP_SETUP = 0x0800;
export const USB_EP_TYPE = 0x0600;
export const USB_EP_KIND = 0x0100;
export const USB_EP_CTR_TX = 0x0080;
export const USB_EP_DTOG_TX = 0x0040;
export const USB_EP_STAT_TX = 0x0030;
export const USB_EP_EA = 0x000f;

export const USB_EP_TYPE_BULK = 0;
export const USB_EP_TYPE_CONTROL = 1;
export const USB_EP_TYPE_ISO = 2;
export const USB_EP_TYPE_INTERRUPT = 3;

export const USB_STAT_DISABLED = 0;
export const USB_STAT_STALL = 1;
export const USB_STAT_NAK = 2;
export const USB_STAT_VALID = 3;

export const USB_BCDR_DPPU = 0x8000;
