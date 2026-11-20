/* Firmware for board-io.test.ts. Rebuild with build-board-io.sh. */
#include <stdint.h>

void reset(void);
__attribute__((section(".vectors"), used))
const uintptr_t vectors[] = {0x20005800, (uintptr_t)reset};

#define REG(base, offset) (*(volatile uint32_t *)((base) + (offset)))
#define RCC  0x40021000u
#define GPIOA 0x48000000u
#define GPIOB 0x48000400u
#define GPIOC 0x48000800u
#define GPIOD 0x48000c00u
#define ADC1  0x50000000u
#define ADC2  0x50000100u
#define TIM2  0x40000000u
#define TIM3  0x40000400u
#define MODER 0x00
#define IDR   0x10
#define BSRR  0x18
#define SCL   (1u << 6)
#define SDA   (1u << 7)
static volatile uint32_t *const results = (void *)0x20000000u;

static void high(uint32_t pin) { REG(GPIOB, BSRR) = pin; }
static void low(uint32_t pin) { REG(GPIOB, BSRR) = pin << 16; }

static void start(void) {
  high(SDA);
  high(SCL);
  low(SDA);
  low(SCL);
}

static void stop(void) {
  low(SDA);
  high(SCL);
  high(SDA);
}

static unsigned send(unsigned byte) {
  for (unsigned bit = 128; bit; bit >>= 1) {
    if (byte & bit) high(SDA); else low(SDA);
    high(SCL);
    low(SCL);
  }
  high(SDA);
  high(SCL);
  unsigned ack = !(REG(GPIOB, IDR) & SDA);
  low(SCL);
  return ack;
}

static unsigned receive(unsigned ack) {
  unsigned byte = 0;
  high(SDA);
  for (unsigned bit = 0; bit < 8; ++bit) {
    high(SCL);
    byte = (byte << 1) | ((REG(GPIOB, IDR) >> 7) & 1);
    low(SCL);
  }
  if (ack) low(SDA);
  high(SCL);
  low(SCL);
  high(SDA);
  return byte;
}

static unsigned sample(uint32_t adc, unsigned channel) {
  REG(adc, 0x08) = 1u << 28;
  REG(adc, 0x08) = (1u << 28) | 1;
  REG(adc, 0x30) = channel << 6;
  REG(adc, 0x08) = (1u << 28) | 4;
  while (!(REG(adc, 0x00) & 4)) {}
  return REG(adc, 0x40);
}

static void lcdWrite(unsigned data, unsigned value) {
  if (data) high(1u << 8); else low(1u << 8);
  REG(GPIOC, 0x14) = value;
  low(1u << 5);
  high(1u << 5);
}

static void timerStart(uint32_t timer) {
  REG(timer, 0x18) = 1; // CC1S = TI1.
  REG(timer, 0x20) = 1; // Rising edge.
  REG(timer, 0x00) = 1;
}

static void timerRead(uint32_t timer, unsigned slot) {
  if (REG(timer, 0x10) & 2) {
    unsigned next = REG(timer, 0x34);
    if (results[slot]) {
      unsigned delta = next - results[slot];
      results[slot + 1] = (timer == TIM3) ? delta & 0xffff : delta;
    }
    results[slot] = next;
    results[timer == TIM3 ? 18 : 19]++;
  }
}

void reset(void) {
  REG(RCC, 0x4c) = 0x200f; // GPIO A–D and ADC12.
  REG(RCC, 0x58) = 3;     // TIM2 and TIM3.
  REG(GPIOA, 0x24) = 1u << 28; // PA15 AF1.
  REG(GPIOB, 0x20) = 2u << 16; // PB4 AF2.
  REG(GPIOB, 0x04) = SCL | SDA; // PB6/PB7 open drain.
  high(SCL | SDA | (1u << 5) | (1u << 9));
  REG(GPIOA, BSRR) = 1u << 8; // LCD RD high.
  REG(GPIOA, MODER) = (2u << 30) | (1u << 16);
  REG(GPIOB, MODER) = 0xf3000000u | (5u << 16) | (0x15u << 10) | (2u << 8);
  REG(GPIOC, MODER) = 0x55555555;
  REG(GPIOD, MODER) = 1u << 4;
  timerStart(TIM2);
  timerStart(TIM3);

  results[0]++;
  results[1] = (REG(GPIOB, IDR) & 7) | ((REG(GPIOA, IDR) & 1) << 3);
  while (REG(GPIOB, IDR) & 1) {}
  results[2] = (REG(GPIOB, IDR) & 7) | ((REG(GPIOA, IDR) & 1) << 3);

  /* Leave the latch transparent, wait for B2, then close it during an LCD read. */
  REG(GPIOC, 0x14) = 0xa500;
  REG(GPIOD, BSRR) = 4;
  while (REG(GPIOB, IDR) & 2) {}
  REG(GPIOC, 0x14) = 0x5a00;
  low(1u << 9);
  lcdWrite(0, 0);
  high(1u << 8);
  REG(GPIOC, MODER) = 0;
  REG(GPIOA, BSRR) = 1u << 24;
  results[3] = REG(GPIOC, IDR);
  REG(GPIOD, BSRR) = 4u << 16;
  REG(GPIOA, BSRR) = 1u << 8;
  REG(GPIOC, MODER) = 0x55555555;
  lcdWrite(0, 0x22);
  lcdWrite(1, 0xf81f);

  start();
  results[4] = send(0x60); // Neither slave should ACK.
  stop();
  start();
  results[5] = send(0xa0);
  results[5] |= send(0x07) << 1;
  results[5] |= send(0x5a) << 2;
  results[5] |= send(0xc3) << 3; // Page write wraps to 0x00.
  stop();
  start();
  results[5] |= send(0xa0) << 4;
  results[5] |= send(0x07) << 5;
  start(); // Repeated START, then ACK + NACK two sequential bytes.
  results[5] |= send(0xa1) << 6;
  results[6] = receive(1);
  results[7] = receive(0);
  stop();
  start();
  results[8] = send(0x5e);
  results[8] |= send(0x90) << 1; // Only low 7 bits are used.
  stop();
  start();
  results[8] |= send(0x5f) << 2;
  results[9] = receive(0);
  stop();

  results[10] = sample(ADC2, 15);
  results[11] = sample(ADC1, 11);
  results[12] = sample(ADC1, 5);
  results[13] = 1;
  for (;;) {
    timerRead(TIM3, 14);
    timerRead(TIM2, 16);
  }
}
