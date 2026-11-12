@ STM32G431 reset vector and platform init, textually included by every
@ fixture so a fixture links as a single object of 16-bit Thumb instructions.
@
@ Peripheral addresses follow the STM32G4 reference manual:
@   RCC_AHB2ENR   0x4002104c  bit0 = GPIOAEN
@   GPIOA_MODER   0x48000000  bits 11:10 = 01 puts PA5 in general-purpose output
@   GPIOA_ODR     0x48000014
@   GPIOA_BSRR    0x48000018
@   SYSTICK_CSR   0xe000e010  ENABLE|TICKINT|CLKSOURCE = 7
@   SYSTICK_LOAD  0xe000e014  reload 255 -> exception every 256 core cycles
@   SYSTICK_VAL   0xe000e018
@
@ Reset sets MSP = 0x20008000, clears the 256-byte SRAM scratch window at
@ 0x20000000, enables the GPIOA clock, configures PA5 as a push-pull output and
@ leaves SysTick disabled. Fixtures that need a periodic interrupt program
@ SysTick themselves.
@
@ The including fixture must define label 9 at its entry point and must define
@ the symbol systick_handler (the real handler or a trap loop).

    .syntax unified
    .thumb

    .equ SRAM_TOP,       0x20008000
    .equ SCRATCH_BASE,   0x20000000
    .equ SCRATCH_END,    0x20000100
    .equ RCC_AHB2ENR,    0x4002104c
    .equ GPIOA_MODER,    0x48000000
    .equ SYSTICK_CSR,    0xe000e010

    .section .vectors, "a", %progbits
    .align 2
    .word SRAM_TOP              @ 0: initial MSP
    .word reset_handler     @ 1: Reset
    .word 0                     @ 2: NMI
    .word 0                     @ 3: HardFault
    .word 0                     @ 4: MemManage
    .word 0                     @ 5: BusFault
    .word 0                     @ 6: UsageFault
    .word 0                     @ 7..10: reserved
    .word 0
    .word 0
    .word 0
    .word 0                     @ 11: SVCall
    .word 0                     @ 12..13: reserved
    .word 0
    .word 0                     @ 14: PendSV
    .word systick_handler   @ 15: SysTick

    .section .text, "ax", %progbits
    .align 2
    .global reset_handler
    .type reset_handler, %function
    .thumb_func
reset_handler:
    ldr r0, 7f
    mov sp, r0
    ldr r0, 1f
    ldr r1, 2f
    movs r2, #0
3:  str r2, [r0]
    adds r0, r0, #4
    cmp r0, r1
    bne.n 3b
    ldr r0, 4f
    movs r1, #1
    str r1, [r0]
    ldr r0, 5f
    ldr r1, 6f
    str r1, [r0]
    ldr r0, 8f
    movs r1, #0
    str r1, [r0]
    movs r0, #0
    movs r1, #0
    movs r2, #0
    movs r3, #0
    movs r4, #0
    movs r5, #0
    movs r6, #0
    movs r7, #0
    b.n 9f
    .align 2
7:  .word SRAM_TOP
1:  .word SCRATCH_BASE
2:  .word SCRATCH_END
4:  .word RCC_AHB2ENR
5:  .word GPIOA_MODER
6:  .word 0x00000400
8:  .word SYSTICK_CSR
    .size reset_handler, . - reset_handler
