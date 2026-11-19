@ CT117E-M4 74HC573:
@ 1) D=0xA5, PD2 high: transparent (LED mask 0x5A);
@ 2) B1 (PB0) changes D to 0x3C while LE is still high: mask 0xC3;
@ 3) B2 (PB1) closes the latch and changes D to 0x22: mask stays 0xC3.

    .syntax unified
    .cpu cortex-m4
    .thumb

    .section .isr_vector, "a", %progbits
    .word 0x20005800
    .word reset + 1

    .section .text
    .thumb_func
reset:
    ldr r0, =0x40021000
    movs r1, #0x0f              @ GPIOA/B/C/D clocks
    str r1, [r0, #0x4c]

    ldr r2, =0x48000800         @ GPIOC
    ldr r1, =0x55550000         @ PC8-PC15 output
    str r1, [r2, #0x00]

    ldr r3, =0x48000c00         @ GPIOD
    movs r1, #0x10              @ PD2 output
    str r1, [r3, #0x00]

    ldr r4, =0x48000400         @ GPIOB
    movs r1, #0                 @ PB0/PB1 input, no internal pull
    str r1, [r4, #0x00]
    str r1, [r4, #0x0c]

    ldr r1, =0xa500
    str r1, [r2, #0x14]         @ D = 0xA5
    movs r1, #4
    str r1, [r3, #0x18]         @ PD2 high: transparent

wait_b1:
    ldr r1, [r4, #0x10]
    ands r1, r1, #1
    bne wait_b1
    ldr r1, =0x3c00
    str r1, [r2, #0x14]         @ D changes while LE high

wait_b2:
    ldr r1, [r4, #0x10]
    ands r1, r1, #2
    bne wait_b2
    movs r1, #4
    lsls r1, r1, #16
    str r1, [r3, #0x18]         @ PD2 low: latch 0x3C
    ldr r1, =0x2200
    str r1, [r2, #0x14]         @ D changes with LE closed

spin:
    b spin
