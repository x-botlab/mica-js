/*
 * USB FS device 验收固件：class-agnostic。
 *
 * 设备/配置描述符、GET_DESCRIPTOR/SET_ADDRESS/SET_CONFIGURATION 处理和 EP1/EP2
 * 自定义 bulk 回环全部在固件里完成；MCU 模型只提供 USB 控制器/PMA。
 *
 * 构建：
 *   arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 -ffreestanding -fno-builtin \
 *     -nostdlib -nostartfiles -T usb-link.ld usb-firmware.c -o usb-firmware.elf
 *   arm-none-eabi-objcopy -O binary usb-firmware.elf usb-firmware.bin
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define USB_REGS 0x40005C00u
#define USB_PMA 0x40006000u
#define RCC_APB1ENR1 (*(volatile u32 *)0x40021058u)
#define NVIC_ISER0 (*(volatile u32 *)0xE000E100u)
#define NVIC_ISER1 (*(volatile u32 *)0xE000E104u)

#define USB_CNTR (*(volatile u16 *)(USB_REGS + 0x40u))
#define USB_ISTR (*(volatile u16 *)(USB_REGS + 0x44u))
#define USB_FNR (*(volatile u16 *)(USB_REGS + 0x48u))
#define USB_DADDR (*(volatile u16 *)(USB_REGS + 0x4Cu))
#define USB_BTABLE (*(volatile u16 *)(USB_REGS + 0x50u))
#define USB_BCDR (*(volatile u16 *)(USB_REGS + 0x58u))
#define EPR(n) (*(volatile u16 *)(USB_REGS + (n)*4u))

#define ISTR_CTR 0x8000u
#define ISTR_RESET 0x0400u
#define ISTR_SUSP 0x0800u
#define ISTR_WKUP 0x1000u
#define EP_CTR_RX 0x8000u
#define EP_CTR_TX 0x0080u
#define EP_SETUP 0x0800u
#define EP_TYPE_CONTROL (1u << 9)
#define EP_TYPE_BULK (0u << 9)
#define EP_STAT_NAK (2u << 12)
#define EP_STAT_VALID (3u << 12)

#define IRQ_COUNT (*(volatile u32 *)0x20005000u)
#define STAGE (*(volatile u32 *)0x20005004u)
#define PENDING_ADDR (*(volatile u32 *)0x20005008u)
#define CONFIGURED (*(volatile u32 *)0x2000500Cu)
#define POLL_COUNT (*(volatile u32 *)0x2000501Cu)

#define STAGE_IDLE 0u
#define STAGE_DATA_IN 1u
#define STAGE_STATUS_OUT 2u
#define STAGE_STATUS_ADDR 3u
#define STAGE_STATUS_CFG 4u

static const u8 deviceDescriptor[18] = {
    18, 1, 0x00, 0x02, 0xff, 0x00, 0x00, 64,
    0x09, 0x12, 0x01, 0x00, 0x00, 0x01,
    1, 2, 3, 1,
};

/* config 9 + interface 9 + bulk IN 7 + bulk OUT 7 */
static const u8 configDescriptor[32] = {
    9, 2, 32, 0, 1, 1, 0, 0x80, 50,
    9, 4, 0, 0, 2, 0xff, 0x00, 0x00, 0,
    7, 5, 0x81, 0x02, 64, 0, 0,
    7, 5, 0x02, 0x02, 64, 0, 0,
};

static const u8 string0[4] = {4, 3, 0x09, 0x04};

static void pmaWrite(u16 offset, const u8 *data, u16 length) {
  volatile u16 *pma = (volatile u16 *)(0x40006000u + offset);

  for (u16 index = 0; index < length; index += 2) {
    u16 value = data[index];
    if (index + 1 < length) value |= (u16)data[index + 1] << 8;
    pma[index >> 1] = value;
  }
}

static void pmaRead(u16 offset, u8 *data, u16 length) {
  volatile u16 *pma = (volatile u16 *)(0x40006000u + offset);

  for (u16 index = 0; index < length; index += 2) {
    u16 value = pma[index >> 1];
    data[index] = (u8)value;
    if (index + 1 < length) data[index + 1] = (u8)(value >> 8);
  }
}


/* EP0: CTR=0, EA/type 正常写入，toggles 只翻转需要的 STAT/DTOG 位。 */
static void ep0Write(u16 toggles) { EPR(0) = EP_TYPE_CONTROL | toggles; }
static void ep1Write(u16 toggles) { EPR(1) = EP_TYPE_BULK | 1u | toggles; }
static void ep2Write(u16 toggles) { EPR(2) = EP_TYPE_BULK | 2u | toggles; }

static u16 epCount(u16 endpoint) {
  volatile u16 *entry = (volatile u16 *)(USB_PMA + endpoint * 8u);

  return entry[3] & 0x03ffu;
}

static void btableWrite(u16 endpoint, u16 txAddr, u16 txCount, u16 rxAddr, u16 rxCount) {
  volatile u16 *entry = (volatile u16 *)(0x40006000u + endpoint * 8u);

  entry[0] = txAddr;
  entry[1] = txCount;
  entry[2] = rxAddr;
  entry[3] = rxCount;
}

static void ep0Init(void) {
  btableWrite(0, 0x40, 0, 0x80, 0x8800);
  EPR(0) = EP_TYPE_CONTROL | EP_STAT_VALID | (2u << 4);
}

static void deviceInit(void) {
  RCC_APB1ENR1 |= 1u << 23; /* USBEN */

  USB_BCDR = 0x8000; /* DPPU */
  USB_CNTR = 0;
  USB_BTABLE = 0;
  USB_DADDR = 0x80;

  btableWrite(0, 0x40, 0, 0x80, 0x8800);
  btableWrite(1, 0x100, 0, 0, 0);
  btableWrite(2, 0, 0, 0x140, 0x8800);

  EPR(0) = EP_TYPE_CONTROL | EP_STAT_VALID | (2u << 4);
  EPR(1) = EP_TYPE_BULK | 1u | (2u << 4);
  EPR(2) = EP_TYPE_BULK | 2u | EP_STAT_VALID;

  USB_CNTR = 0xAC00; /* CTRM | ERRM | SUSPM | RESETM; polled in this e2e fixture */
}

static void ep0Setup(void) {
  u8 setup[8];

  pmaRead(0x80, setup, 8);
  ep0Write(0); /* clear CTR_RX; both directions stay NAK from SETUP */

  u16 value = (u16)setup[2] | ((u16)setup[3] << 8);
  u16 length = (u16)setup[6] | ((u16)setup[7] << 8);
  u16 request = (u16)setup[0] | ((u16)setup[1] << 8);

  if (request == 0x0680u || request == 0x0681u) {
    const u8 *data = 0;
    u16 size = 0;

    if (setup[3] == 1) {
      data = deviceDescriptor;
      size = sizeof(deviceDescriptor);
    } else if (setup[3] == 2) {
      data = configDescriptor;
      size = sizeof(configDescriptor);
    } else if (setup[3] == 3) {
      data = string0;
      size = sizeof(string0);
    }

    if (data == 0) {
      ep0Write(0x30); /* STALL */
      STAGE = STAGE_IDLE;
      return;
    }

    if (size > length) size = length;
    pmaWrite(0x40, data, size);
    (*(volatile u8 *)(USB_PMA + 0x1F8u)) = 0x5au; /* completion marker regression */
    (*(volatile u16 *)(USB_PMA + 2u)) = size;
    ep0Write(0x10); /* TX NAK->VALID */
    STAGE = STAGE_DATA_IN;
    return;
  }

  if (request == 0x0500u) { /* SET_ADDRESS */
    PENDING_ADDR = setup[2] & 0x7fu;
    (*(volatile u16 *)(USB_PMA + 2u)) = 0;
    ep0Write(0x10); /* zero-length DATA IN */
    STAGE = STAGE_STATUS_ADDR;
    return;
  }

  if (request == 0x0900u) { /* SET_CONFIGURATION */
    CONFIGURED = setup[2];
    (*(volatile u16 *)(USB_PMA + 2u)) = 0;
    ep0Write(0x10);
    STAGE = STAGE_STATUS_CFG;
    return;
  }

  ep0Write(0x30); /* unsupported -> STALL data/status */
  STAGE = STAGE_IDLE;
}

static void serviceEp0(void) {
  u16 ep = EPR(0);

  if ((ep & EP_CTR_RX) != 0) {
    if ((ep & EP_SETUP) != 0) {
      ep0Setup();
    } else {
      ep0Write(0);
      ep0Write(0x1000); /* RX NAK->VALID for next SETUP */
      STAGE = STAGE_IDLE;
    }
  }

  ep = EPR(0);
  if ((ep & EP_CTR_TX) != 0) {
    ep0Write(0); /* clear CTR_TX */

    if (STAGE == STAGE_DATA_IN) {
      ep0Write(0x1000); /* status OUT: RX NAK->VALID */
      STAGE = STAGE_STATUS_OUT;
    } else if (STAGE == STAGE_STATUS_ADDR) {
      USB_DADDR = 0x80u | (PENDING_ADDR & 0x7fu);
      ep0Write(0x1000);
      STAGE = STAGE_IDLE;
    } else if (STAGE == STAGE_STATUS_CFG) {
      ep0Write(0x1000);
      STAGE = STAGE_IDLE;
    }
  }
}

static void serviceLoopback(void) {
  if ((EPR(2) & EP_CTR_RX) != 0) {
    u16 count = epCount(2);
    u8 data[64];

    if (count > 64) count = 64;
    pmaRead(0x140, data, count);
    pmaWrite(0x100, data, count);
    (*(volatile u16 *)(USB_PMA + 0x0a)) = count;

    ep2Write(0);      /* clear CTR_RX */
    ep2Write(0x1000); /* RX NAK->VALID */
    ep1Write(0x10);   /* TX NAK->VALID */
  }

  if ((EPR(1) & EP_CTR_TX) != 0) ep1Write(0);
}

static void usbPoll(void) {
  POLL_COUNT++;

  if ((USB_ISTR & ISTR_RESET) != 0) {
    USB_ISTR = (u16)~ISTR_RESET;
    USB_DADDR = 0x80;
    STAGE = STAGE_IDLE;
    ep0Init();
  }

  if ((USB_ISTR & ISTR_SUSP) != 0) USB_ISTR = (u16)~ISTR_SUSP;
  if ((USB_ISTR & ISTR_WKUP) != 0) USB_ISTR = (u16)~ISTR_WKUP;

  serviceEp0();
  serviceLoopback();
}

void USB_LP_IRQHandler(void) {
  *(volatile u32 *)0x20005010u = 0x2222u;
  IRQ_COUNT++;

  usbPoll();
}

void USB_HP_IRQHandler(void) { *(volatile u32 *)0x20005014u = 0x1111u; IRQ_COUNT++; }
void USBWakeUp_IRQHandler(void) {
  *(volatile u32 *)0x20005018u = 0x3333u;
  IRQ_COUNT++;
  USB_ISTR = (u16)~ISTR_WKUP;
}

void defaultHandler(void) {
  for (;;) {
  }
}

extern void reset(void);

__attribute__((section(".isr_vector"))) const void *vectors[59] = {
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
    (void *)USB_HP_IRQHandler,
    (void *)USB_LP_IRQHandler,
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
    (void *)USBWakeUp_IRQHandler,
};

void reset(void) {
  IRQ_COUNT = 0;
  POLL_COUNT = 0;
  STAGE = STAGE_IDLE;
  PENDING_ADDR = 0;
  CONFIGURED = 0;
  deviceInit();

  for (;;) {
    usbPoll();
  }
}
