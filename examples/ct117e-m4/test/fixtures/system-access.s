@ arm-none-eabi-as -mcpu=cortex-m4 -mthumb system-access.s -o /tmp/system-access.o
@ arm-none-eabi-objcopy -O ihex --change-addresses=0x08000000 /tmp/system-access.o system-access.hex
.syntax unified
.thumb
.section .text
.word 0x20010000
.word 0x08000009
reset:
  ldr  r4, =0x20000000
  ldr  r5, =0xe000e010             @ SysTick CTRL, LOAD, VAL
  str  r5, [r4]                   @ reload from SRAM to force dynamic addressing
  ldr  r0, [r4]
  adds r0, #4
  movs r1, #7
  movs r2, #0x55
  stmia r0!, {r1, r2}             @ LOAD = 7, VAL is cleared rather than written
  str  r0, [r4, #4]
  ldr  r0, [r4]
  adds r0, #4
  ldmia r0!, {r1, r2}
  str  r1, [r4, #8]
  str  r2, [r4, #12]
  str  r0, [r4, #16]
  ldr  r0, [r4]
  movs r1, #5                     @ enable SysTick, no exception
  strb r1, [r0]
  movs r3, #40
1:
  subs r3, #1
  bne  1b
  movs r1, #4
  strh r1, [r0]                   @ stop before reading the sticky flag
  ldrb r1, [r0, #2]               @ narrow read sees and clears COUNTFLAG
  ldrh r2, [r0, #2]
  str  r1, [r4, #20]
  str  r2, [r4, #24]
  ldr  r5, =0xe000e400             @ NVIC priority word, IRQ0–IRQ3
  str  r5, [r4]
  ldr  r0, [r4]
  movs r1, #0xaf
  strb r1, [r0, #1]
  movw r1, #0x7f3f
  strh r1, [r0, #2]
  ldr  r1, [r0]
  str  r1, [r4, #28]
  ldrb r1, [r0, #1]
  str  r1, [r4, #32]
  ldrh r1, [r0, #2]
  str  r1, [r4, #36]
2:
  b    2b
  .ltorg
