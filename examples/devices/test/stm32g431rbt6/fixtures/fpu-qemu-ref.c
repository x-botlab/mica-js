typedef union { float f; unsigned u; } bits;

static void sh_write0(const char *s) {
  register int r0 __asm__("r0") = 4;
  register const char *r1 __asm__("r1") = s;
  __asm__ volatile("bkpt 0xab" :: "r"(r0), "r"(r1) : "memory");
}

static void sh_exit(void) {
  register int r0 __asm__("r0") = 0x18;
  register int r1 __asm__("r1") = 0x20026;
  __asm__ volatile("bkpt 0xab" :: "r"(r0), "r"(r1) : "memory");
}

static void put_hex(unsigned value) {
  static const char digits[] = "0123456789abcdef";
  char buffer[10];
  for (int i = 0; i < 8; i += 1) buffer[i] = digits[(value >> (28 - i * 4)) & 0xf];
  buffer[8] = '\n';
  buffer[9] = 0;
  sh_write0(buffer);
}

static unsigned get_fpscr(void) {
  unsigned value;
  __asm__ volatile("vmrs %0, fpscr" : "=r"(value));
  return value;
}

static void set_fpscr(unsigned value) {
  __asm__ volatile("vmsr fpscr, %0" :: "r"(value) : "memory");
}

static void emit(const char *name, unsigned result, unsigned flags) {
  sh_write0(name);
  put_hex(result);
  put_hex(flags);
}

volatile float a, b;

int main(void) {
  bits r;
  unsigned f;

  a = 1.5f; b = 2.25f;
  set_fpscr(0);
  r.f = a + b; f = get_fpscr(); emit("add ", r.u, f);
  r.f = a - b; f = get_fpscr(); emit("sub ", r.u, f);
  r.f = a * b; f = get_fpscr(); emit("mul ", r.u, f);
  r.f = a / b; f = get_fpscr(); emit("div ", r.u, f);
  r.u = (unsigned)(int)a; f = get_fpscr(); emit("cvt_s32 ", r.u, f);
  r.f = (float)(int)b; f = get_fpscr(); emit("cvt_f32 ", r.u, f);
  r.u = (unsigned)(a < b); f = get_fpscr(); emit("lt ", r.u, f);
  r.u = (unsigned)(a == b); f = get_fpscr(); emit("eq ", r.u, f);

  a = 1.0f; b = 0x1p-24f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("tie_rne ", r.u, f);
  set_fpscr(1u << 22); r.f = a + b; f = get_fpscr(); emit("tie_rp ", r.u, f);
  set_fpscr(2u << 22); r.f = a + b; f = get_fpscr(); emit("tie_rm ", r.u, f);
  set_fpscr(3u << 22); r.f = a + b; f = get_fpscr(); emit("tie_rz ", r.u, f);

  a = 1.0f; b = 3.0f * 0x1p-24f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("tie3_rne ", r.u, f);

  a = -1.0f; b = -0x1p-24f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("ntie_rne ", r.u, f);
  set_fpscr(2u << 22); r.f = a + b; f = get_fpscr(); emit("ntie_rm ", r.u, f);

  a = 1.0f; b = -1.0f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("cancel ", r.u, f);
  set_fpscr(2u << 22); r.f = a + b; f = get_fpscr(); emit("cancel_rm ", r.u, f);

  a = 0.0f; b = -0.0f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("pz ", r.u, f);
  a = -0.0f; b = -0.0f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("nz ", r.u, f);

  a = 0x1p-149f; b = 0x1p-149f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("subadd ", r.u, f);

  a = 0x1p-126f; b = 0.5f;
  set_fpscr(0); r.f = a * b; f = get_fpscr(); emit("under ", r.u, f);
  set_fpscr(1u << 24); r.f = a * b; f = get_fpscr(); emit("under_fz ", r.u, f);

  a = 0.0f; b = -0.0f; // 0 * inf
  a = 0.0f; b = __builtin_inff();
  set_fpscr(0); r.f = a * b; f = get_fpscr(); emit("zerinf ", r.u, f);

  a = 1.0f; b = 0.0f;
  set_fpscr(0); r.f = a / b; f = get_fpscr(); emit("divzero ", r.u, f);

  a = 0.0f; b = 0.0f;
  set_fpscr(0); r.f = a / b; f = get_fpscr(); emit("0div0 ", r.u, f);

  a = __builtin_inff(); b = __builtin_inff();
  set_fpscr(0); r.f = a - b; f = get_fpscr(); emit("infm ", r.u, f);

  a = __builtin_nanf("0x1"); b = 1.0f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("qnan ", r.u, f);
  set_fpscr(1u << 25); r.f = a + b; f = get_fpscr(); emit("qnan_dn ", r.u, f);
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("qnan2 ", r.u, f);

  a = 0x1.fffffep127f; b = 0x1.fffffep127f;
  set_fpscr(0); r.f = a + b; f = get_fpscr(); emit("ovf ", r.u, f);
  set_fpscr(3u << 22); r.f = a + b; f = get_fpscr(); emit("ovf_rz ", r.u, f);


  a = -0.5f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_m05 ", r.u, f);
  a = -1.5f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_m15 ", r.u, f);
  a = -0.5f; set_fpscr(0); r.u = (unsigned)a; f = get_fpscr(); emit("u32_m05 ", r.u, f);
  a = -1.5f; set_fpscr(0); r.u = (unsigned)a; f = get_fpscr(); emit("u32_m15 ", r.u, f);
  a = 4294967295.0f; set_fpscr(0); r.u = (unsigned)a; f = get_fpscr(); emit("u32_max ", r.u, f);
  a = 2147483647.5f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_half ", r.u, f);
  a = 1e20f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_big ", r.u, f);
  a = -1e20f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_nbig ", r.u, f);
  a = 1e20f; set_fpscr(0); r.u = (unsigned)a; f = get_fpscr(); emit("u32_big ", r.u, f);
  a = 2147483648.0f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_2p31 ", r.u, f);
  a = -2147483648.0f; set_fpscr(0); r.u = (unsigned)(int)a; f = get_fpscr(); emit("s32_m2p31 ", r.u, f);
  a = -0.0f; set_fpscr(0); r.u = (unsigned)a; f = get_fpscr(); emit("u32_mzero ", r.u, f);
  sh_exit();
  for (;;) {}
}
