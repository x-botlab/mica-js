typedef unsigned int u32;
typedef float f32;

void reset(void);
__attribute__((section(".isr_vector"))) const void *vectors[2] = {
    (void *)0x20005800u,
    (void *)reset,
};

void reset(void) {
  volatile u32 *cpacr = (volatile u32 *)0xE000ED88u;

  /* 打开 CP10/CP11，确保 0x20 不是 CPACR 门控造成的架构 NOCP。 */
  *cpacr = (*cpacr & ~0x00F00000u) | 0x00F00000u;

  volatile f32 a = 1.5f;
  volatile f32 b = 2.25f;
  volatile f32 c = a + b;
  volatile f32 d = c * 2.0f;

  (void)d;
  for (;;) {
  }
}
