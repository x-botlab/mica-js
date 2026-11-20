/*
 * PMA 多 STRH 最小复现（CPU/JIT 定位用）
 *
 * reset 先写 SRAM marker，证明 CPU 已进入 reset；随后用编译后的 C 循环把 8 字节
 * descriptor 以 4 个 STRH 写入 PMA 0x40；最后自旋。预期 PMA 字节：
 *   12 34 56 78 9a bc de f0
 * 如果 marker=0x31415926 但 PMA 只出现低字节/零，则问题在 CPU 存储/服务序列，
 * 不在 USB 模块的 halfword 处理（USB_MODULE 的 read/write size=2 单测已覆盖）。
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

static const u8 descriptor[8] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0};

static void pmaWrite(u16 offset, const u8 *data, u16 length) {
  volatile u16 *pma = (volatile u16 *)(0x40006000u + offset);

  for (u16 index = 0; index < length; index += 2) {
    u16 value = data[index];
    if (index + 1 < length) value |= (u16)data[index + 1] << 8;
    pma[index >> 1] = value;
  }
}

void reset(void);
__attribute__((section(".isr_vector"))) const void *vectors[2] = {
    (void *)0x20005800u,
    (void *)reset,
};

void reset(void) {
  *(volatile u32 *)0x20005000u = 0x31415926u;
  pmaWrite(0x40, descriptor, 8);
  *(volatile u8 *)(0x40006000u + 0x1F8u) = 0x5au;
  for (;;) {
  }
}
