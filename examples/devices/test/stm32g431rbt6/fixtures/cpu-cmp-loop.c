typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

static const u8 descriptor[8] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};

static void copy(u16 offset, const u8 *data, u16 length) {
  volatile u16 *target = (volatile u16 *)(0x20005000u + offset);
  for (u16 index = 0; index < length; index += 2) {
    u16 value = data[index];
    if (index + 1 < length) value |= (u16)data[index + 1] << 8;
    target[index >> 1] = value;
  }
}

void reset(void);
__attribute__((section(".isr_vector"))) const void *vectors[2] = {
    (void *)0x20005800u,
    (void *)reset,
};

void reset(void) {
  volatile u32 *rcc = (volatile u32 *)0x40021048u;
  volatile u32 *gpio = (volatile u32 *)0x48000000u;
  *rcc = 1u;
  *gpio = 5u; /* PA0/PA1 output */
  copy(0x10, descriptor, 8);
  const volatile u8 *target = (const volatile u8 *)(0x20005000u + 0x10u);
  u8 ok = 1;
  for (u16 index = 0; index < 8; index += 1) {
    if (target[index] != descriptor[index]) ok = 0;
  }
  *(volatile u32 *)(0x48000000u + 0x14u) = ok ? 1u : 2u;
  for (;;) {
  }
}
