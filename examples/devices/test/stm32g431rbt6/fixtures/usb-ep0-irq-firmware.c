/*
 * 最小 EP0 + 真实 USB_LP IRQ 验收固件。
 *
 * 固件自己的 8 字节 descriptor；host RESET/SETUP 通过 USB_LP 中断处理，
 * 固件写 PMA，host 读取 DATA。PMA 0x1F0 是 IRQ 计数标记，供 host 通过
 * usbReadPma 验证 reset/IRQ 实际发生。不实现 bulk/高级模式。
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define USB 0x40005C00u
#define PMA 0x40006000u

static const u8 descriptor[8] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};

static void initDevice(void) {
  volatile u8 *pma = (volatile u8 *)PMA;
  volatile u16 *usb = (volatile u16 *)USB;

  usb[0x58 / 2] = 0x8000u; /* BCDR DPPU */
  usb[0x50 / 2] = 0;       /* BTABLE 0 */
  usb[0x4c / 2] = 0x80u;   /* DADDR EF, address 0 */

  *(volatile u32 *)(PMA + 0) = 0x00000040u; /* TX addr 0x40, count 0 */
  *(volatile u32 *)(PMA + 4) = 0x88000080u; /* RX addr 0x80, count 0x88 */

  usb[0] = 0x3220u; /* EP0 CONTROL, RX VALID, TX NAK */
  usb[0x40 / 2] = 0x8C00u; /* CTRM | SUSPM | RESETM */
  *(volatile u32 *)0xE000E100u = 1u << 20; /* NVIC USB_LP */
}

void USB_LP_IRQHandler(void) {
  volatile u8 *pma = (volatile u8 *)PMA;
  volatile u16 *usb = (volatile u16 *)USB;
  u16 istr = usb[0x44 / 2];
  u16 ep;

  pma[0x1F0] = (u8)(pma[0x1F0] + 1);

  /* RESET/SUSP/WKUP 都是 W0C；一次写回即可。 */
  usb[0x44 / 2] = (u16)~(istr & 0x1C00u);

  if ((istr & 0x0400u) != 0) initDevice();

  ep = usb[0];

  if ((ep & 0x8000u) != 0) {
    if ((ep & 0x0800u) != 0) {
      if (*(volatile u16 *)(PMA + 0x80) == 0x0680u) { /* bmRequestType=0x80, bRequest=0x06 */
        *(volatile u32 *)(PMA + 0x40) = 0x78563412u;
        *(volatile u32 *)(PMA + 0x44) = 0xf0debc9au;
        *(volatile u16 *)(PMA + 0x02) = 8u;
        usb[0] = 0x0210u; /* clear CTR_RX; TX NAK->VALID */
      } else {
        usb[0] = 0x0230u; /* clear CTR_RX; TX NAK->STALL */
      }
    } else {
      usb[0] = 0x1200u; /* clear CTR_RX; RX NAK->VALID */
    }
  } else if ((ep & 0x0080u) != 0) {
    usb[0] = 0x1200u; /* clear CTR_TX; RX VALID */
  }
}

void defaultHandler(void) {
  for (;;) {
  }
}

void reset(void);
__attribute__((section(".isr_vector"))) const void *vectors[37] = {
    (void *)0x20005800u,
    (void *)reset,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)defaultHandler,
    (void *)USB_LP_IRQHandler,
};

void reset(void) {
  *(volatile u8 *)(PMA + 0x1F0u) = 0;
  initDevice();
  for (;;) {
  }
}
