/*
 * GCC -O2 post-index LDRB 通用 C 回归（CPU 专属，不依赖 USB/PMA）。
 *
 * 构建：
 *   arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 -ffreestanding -fno-builtin \
 *     -nostdlib -nostartfiles -T usb-link.ld cpu-postindex-o2.c \
 *     -o /tmp/cpu-postindex-o2.elf
 *   arm-none-eabi-objcopy -O binary /tmp/cpu-postindex-o2.elf cpu-postindex-o2.bin
 *
 * -O2 会把 copy 循环生成 ldrb.w ip,[r1,#1] / ldrb.w r2,[r1],#2 / strh.w。
 * 目标 SRAM 0x20005010 起必须为 12 34 56 78 9a bc de f0；完成后 PA0=1。
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

static const u8 descriptor[8] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};

static void copy(volatile u16 *dst, const u8 *data, u16 length) {
  for (u16 index = 0; index < length; index += 2) {
    u16 value = data[index];
    if (index + 1 < length) value |= (u16)data[index + 1] << 8;
    dst[index >> 1] = value;
  }
}

void reset(void);
__attribute__((section(".isr_vector"))) const void *vectors[2] = {
    (void *)0x20005800u,
    (void *)reset,
};

void reset(void) {
  volatile u32 *rcc = (volatile u32 *)0x4002104cu;
  volatile u32 *gpio = (volatile u32 *)0x48000000u;
  volatile u8 *target = (volatile u8 *)0x20005010u;

  *rcc = 1u;
  *gpio = 5u;
  *(volatile u32 *)0x20005000u = 0x31415926u;
  copy((volatile u16 *)target, descriptor, 8);

  /* CPU SRAM 断言已检查完整数据；这里只标记 copy 循环完成。 */
  *(volatile u32 *)(0x48000000u + 0x14u) = 1u;
  for (;;) {
  }
}
