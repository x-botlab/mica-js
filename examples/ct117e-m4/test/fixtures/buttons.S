@ CT117E-M4: publish B1/B2/B3 (PB0/PB1/PB2) and B4 (PA0) into SRAM[0].
@ bit0=B1, bit1=B2, bit2=B3, bit3=B4; released is 1 through the 10 kΩ pull-ups.

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
    movs r1, #3                 @ GPIOA/GPIOB clocks
    str r1, [r0, #0x4c]

    ldr r0, =0x48000400         @ GPIOB
    movs r1, #0
    str r1, [r0, #0x00]         @ PB0-PB2 input
    str r1, [r0, #0x0c]         @ no internal pull; board has 10 kΩ

    ldr r1, =0x48000000         @ GPIOA
    movs r2, #0
    str r2, [r1, #0x00]         @ PA0 input
    str r2, [r1, #0x0c]

    ldr r4, =0x20000000
loop:
    ldr r2, [r0, #0x10]         @ GPIOB IDR
    ands r2, r2, #7
    ldr r3, [r1, #0x10]         @ GPIOA IDR
    ands r3, r3, #1
    lsls r3, r3, #3
    orrs r2, r2, r3
    str r2, [r4]
    b loop
